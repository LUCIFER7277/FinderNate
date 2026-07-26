import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { AuthOtp } from "../../models/authOtp.models.js";
import { sendEmail } from "../../utils/sendEmail.js";
import { sendSms } from "../../utils/sendSms.js";
import {
    rateCheckAndUpsertOtp,
    generateAcessAndRefreshToken,
    resolveUserByIdentifier,
    canonicalIdentifier,
    OTP_EXPIRY_MS,
} from "./_helpers.js";

const getOtpStatus = asyncHandler(async (req, res) => {
    const { identifier, type, purpose } = req.query;

    if (!identifier || !type || !purpose) {
        throw new ApiError(400, "identifier, type, and purpose are required");
    }

    const record = await AuthOtp.findOne({ identifier, type, purpose });

    if (!record) {
        return res.status(200).json(new ApiResponse(200, { retryAfterSeconds: 0, otpExpiresIn: 0 }, "No OTP record found"));
    }

    const now = Date.now();
    const retryAfterSeconds = record.retryAfter
        ? Math.max(0, Math.ceil((record.retryAfter.getTime() - now) / 1000))
        : 0;
    const otpExpiresIn = record.expiry
        ? Math.max(0, Math.ceil((record.expiry.getTime() - now) / 1000))
        : 0;

    return res.status(200).json(new ApiResponse(200, { retryAfterSeconds, otpExpiresIn }, "OTP status fetched"));
});

/**
 * Unified email OTP sender.
 * request_type: "email_verification" | "password_reset"
 *
 * For email_verification — stores OTP in AuthOtp.
 * For password_reset     — stores hashed OTP in AuthOtp.
 * Both are routed to the same endpoint: POST /users/send-verification-otp
 */
const sendVerificationOTPForEmail = asyncHandler(async (req, res) => {
    const { email, phone, request_type } = req.body;

    const purposeMap = {
        email_verification: "email_verification",
        password_reset: "password_reset",
    };
    const purpose = purposeMap[request_type] || "email_verification";

    // Password-reset via phone
    if (purpose === "password_reset" && phone) {
        const user = await User.findOne({ phoneNumber: phone });
        if (!user) throw new ApiError(404, "No account found with this phone number");

        const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedOtp = await AuthOtp.hashOtp(plainOtp);
        const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

        await rateCheckAndUpsertOtp({ identifier: phone, type: "phone", purpose: "password_reset", hashedOtp, expiry });
        await sendSms({ phone, otp: plainOtp, request_type: purpose });

        return res.status(200).json(
            new ApiResponse(200, { type: "phone", retryAfterSeconds: 60 }, "OTP sent to your phone successfully")
        );
    }

    // Email-based OTP (verification or password-reset)
    if (!email) throw new ApiError(400, "Email is required");

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, "User not found with this email");

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    if (purpose === "password_reset") {
        await rateCheckAndUpsertOtp({ identifier: email, type: "email", purpose: "password_reset", hashedOtp, expiry });
    } else {
        await rateCheckAndUpsertOtp({ identifier: email, type: "email", purpose: "email_verification", hashedOtp, expiry });
    }

    const subjects = {
        email_verification: "Your OTP for Email Verification - FinderNate",
        password_reset: "Your OTP for Password Reset - FinderNate",
    };
    const headings = {
        email_verification: "Email Verification OTP",
        password_reset: "Password Reset OTP",
    };

    await sendEmail({
        to: user.email,
        subject: subjects[purpose] || subjects.email_verification,
        html: `
            <h3>${headings[purpose] || headings.email_verification}</h3>
            <h2>Your OTP is: <b>${plainOtp}</b></h2>
            <p>This OTP is valid for 5 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>
        `
    });

    return res.status(200).json(
        new ApiResponse(200, { type: "email", retryAfterSeconds: 60 }, "OTP sent to your email successfully")
    );
});

const verifyEmailWithOTP = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) throw new ApiError(400, "Email and OTP are required");

    const otpRecord = await AuthOtp.findOne({
        identifier: email,
        type: "email",
        purpose: "email_verification",
    });

    if (!otpRecord) throw new ApiError(404, "OTP not found. Please request a new one.");

    if (new Date() > otpRecord.expiry) {
        await AuthOtp.deleteOne({ _id: otpRecord._id });
        throw new ApiError(400, "OTP has expired. Please request a new one.");
    }

    const isOtpValid = await otpRecord.verifyOtp(otp);
    if (!isOtpValid) throw new ApiError(400, "Invalid OTP");

    const verifiedUser = await User.findOneAndUpdate({ email }, { $set: { isEmailVerified: true } });
    await AuthOtp.deleteOne({ _id: otpRecord._id });

    // GET /users/profile serves a Redis-cached snapshot (1h TTL); without
    // this, a profile refresh keeps returning isEmailVerified=false.
    if (verifiedUser) {
        const { UserCacheManager } = await import("../../utils/cache.utils.js");
        await UserCacheManager.invalidateUserProfile(verifiedUser._id.toString());
    }

    return res.status(200).json(new ApiResponse(200, { email, isEmailVerified: true }, "Email verified successfully"));
});

const sendPasswordResetOTP = asyncHandler(async (req, res) => {
    const { email, phone } = req.body;

    if (!email && !phone) {
        throw new ApiError(400, "Email or phone number is required");
    }

    let user;
    let identifier;
    let type;

    //* resolveUserByIdentifier copes with the non-uniform stored data: emails
    //* keep whatever case was typed at signup, and phone numbers exist both
    //* bare ("9483122481") and prefixed ("+919483122481"). The web form always
    //* sends countryCode + number, so an exact match missed every bare one.
    //* Email also accepts a username, since sign-in takes either identifier.
    if (email) {
        user = await resolveUserByIdentifier(email);
        if (!user) throw new ApiError(404, "No account found with this email or username");
        type = "email";
    } else {
        user = await resolveUserByIdentifier(phone);
        if (!user) throw new ApiError(404, "No account found with this phone number");
        type = "phone";
    }

    //* File the OTP under the account's own identifier, never the typed
    //* string, so verification resolves to the same record no matter which
    //* spelling the client sends back.
    identifier = canonicalIdentifier(user, type);

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await rateCheckAndUpsertOtp({ identifier, type, purpose: "password_reset", hashedOtp, expiry });

    if (type === "email") {
        await sendEmail({
            to: user.email,
            subject: "Your OTP for Password Reset - FinderNate",
            html: `
                <h3>Password Reset OTP</h3>
                <h2>Your OTP is: <b>${plainOtp}</b></h2>
                <p>This OTP is valid for 5 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>`
        });
    } else {
        await sendSms({ phone: identifier, otp: plainOtp, request_type: 'password_reset' });
    }

    return res.status(200).json(
        new ApiResponse(200, { type, identifier, retryAfterSeconds: 60 }, `OTP sent to your ${type} successfully`)
    );
});

const resetPasswordWithOTP = asyncHandler(async (req, res) => {
    const { identifier, otp, newPassword, confirmPassword } = req.body;

    if (!identifier || !otp || !newPassword || !confirmPassword) {
        throw new ApiError(400, "Identifier, OTP, new password and confirm password are required");
    }

    if (newPassword !== confirmPassword) {
        throw new ApiError(400, "New password and confirm password do not match");
    }

    //* Resolve the account FIRST, then look the OTP up under that account's
    //* canonical identifier. The client echoes back whatever it typed, which
    //* need not match how the value is stored (case, or a "+91" the number was
    //* never saved with) — resolving first makes the two halves agree.
    const user = await resolveUserByIdentifier(identifier);
    if (!user) throw new ApiError(404, "User not found");

    const type = String(identifier).includes('@') ? "email" : "phone";
    const canonical = canonicalIdentifier(user, type);

    const otpRecord = await AuthOtp.findOne({ identifier: canonical, type, purpose: "password_reset" })
        || await AuthOtp.findOne({ identifier, type, purpose: "password_reset" });

    if (!otpRecord) {
        throw new ApiError(404, "OTP not found. Please request a new one.");
    }

    if (new Date() > otpRecord.expiry) {
        await AuthOtp.deleteOne({ _id: otpRecord._id });
        throw new ApiError(400, "OTP has expired. Please request a new one.");
    }

    const isOtpValid = await otpRecord.verifyOtp(otp);
    if (!isOtpValid) {
        throw new ApiError(400, "Invalid OTP");
    }

    user.password = newPassword;
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpiry = undefined;
    await user.save({ validateBeforeSave: false });

    await AuthOtp.deleteOne({ _id: otpRecord._id });

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const loggedUser = await User.findById(user._id).select("-password -refreshToken");
    const options = { httpOnly: true, secure: true };

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(200, { user: loggedUser, accessToken, refreshToken }, "Password reset successfully"));
});

const sendPhoneVerificationOtp = asyncHandler(async (req, res) => {
    const { phone } = req.body;
    const userId = req.user._id;
    const request_type = 'phonenumber_verify';

    if (!phone) throw new ApiError(400, "Phone number is required");

    const existing = await User.findOne({ phoneNumber: phone, _id: { $ne: userId } });
    if (existing) throw new ApiError(409, "This phone number is already in use by another account");

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await rateCheckAndUpsertOtp({ identifier: phone, type: "phone", purpose: "phone_verification", hashedOtp, expiry });

    try {
        await sendSms({ phone, otp: plainOtp, request_type });
    } catch (smsErr) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[DEV] SMS failed (${smsErr.message}). Phone verification OTP for ${phone}: ${plainOtp}`);
        } else {
            throw new ApiError(503, `Failed to send OTP: ${smsErr.message}`);
        }
    }

    return res.status(200).json(new ApiResponse(200, { phone, retryAfterSeconds: 60 }, "OTP sent to your phone number"));
});

const verifyAndUpdatePhone = asyncHandler(async (req, res) => {
    const { phone, otp } = req.body;
    const userId = req.user._id;

    if (!phone || !otp) throw new ApiError(400, "Phone number and OTP are required");

    const otpRecord = await AuthOtp.findOne({
        identifier: phone,
        type: "phone",
        purpose: "phone_verification",
    });

    if (!otpRecord) throw new ApiError(404, "OTP not found. Please request a new one.");

    if (new Date() > otpRecord.expiry) {
        await AuthOtp.deleteOne({ _id: otpRecord._id });
        throw new ApiError(400, "OTP has expired. Please request a new one.");
    }

    const isOtpValid = await otpRecord.verifyOtp(otp);
    if (!isOtpValid) throw new ApiError(400, "Invalid OTP");

    await User.findByIdAndUpdate(userId, {
        $set: { phoneNumber: phone, isPhoneVerified: true },
    });

    await AuthOtp.deleteOne({ _id: otpRecord._id });

    // Invalidate the cached profile snapshot so the new phone/verified
    // status is visible on the next profile fetch.
    {
        const { UserCacheManager } = await import("../../utils/cache.utils.js");
        await UserCacheManager.invalidateUserProfile(userId.toString());
    }

    return res.status(200).json(new ApiResponse(200, { phone, isPhoneVerified: true }, "Phone number verified and updated successfully"));
});

export {
    getOtpStatus,
    sendVerificationOTPForEmail,
    verifyEmailWithOTP,
    sendPasswordResetOTP,
    resetPasswordWithOTP,
    sendPhoneVerificationOtp,
    verifyAndUpdatePhone,
};
