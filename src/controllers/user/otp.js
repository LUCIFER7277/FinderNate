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
    resolveAllUsersByIdentifier,
    canonicalIdentifier,
    accountChoice,
    maskEmail,
    maskPhone,
    assertValidPassword,
    clientIp,
    normalizePhone,
    OTP_EXPIRY_MS,
} from "./_helpers.js";

const escapeRegexLocal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

    //* Password reset — email OR phone — is handled by sendPasswordResetOTP.
    //* The web client posts here while the mobile app posts to
    //* /users/send-reset-otp; they used to be two separate implementations and
    //* only one of them got the identifier-matching fixes, so the same reset
    //* worked in the app and failed on the web. Delegating keeps a single code
    //* path: case-insensitive email, phone in any stored shape, username, and
    //* the "which account?" step when a number is shared.
    if (purpose === "password_reset") {
        return sendPasswordResetOTP(req, res);
    }

    // Email-based OTP (verification or password-reset)
    if (!email) throw new ApiError(400, "Email is required");

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, "User not found with this email");

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    if (purpose === "password_reset") {
        await rateCheckAndUpsertOtp({ identifier: email, type: "email", purpose: "password_reset", hashedOtp, expiry, ip: clientIp(req) });
    } else {
        await rateCheckAndUpsertOtp({ identifier: email, type: "email", purpose: "email_verification", hashedOtp, expiry, ip: clientIp(req) });
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
    const { email, phone, userId } = req.body;

    if (!email && !phone) {
        throw new ApiError(400, "Email or phone number is required");
    }

    let user;
    let identifier;
    let type;

    //* The lookups cope with non-uniform stored data: emails keep whatever
    //* case was typed at signup, and phone numbers exist both bare
    //* ("9483122481") and prefixed ("+919483122481"). The web form always
    //* sends countryCode + number, so an exact match missed every bare one.
    //* Email also accepts a username, since sign-in takes either identifier.
    if (email) {
        user = await resolveUserByIdentifier(email);
        if (!user) throw new ApiError(404, "No account found with this email or username");
        type = "email";
    } else {
        type = "phone";
        //* "Resend OTP" echoes back the scoped identifier it was given
        //* ("<number>#<accountId>"). Strip it here rather than letting the
        //* number and the account id run together into one digit string,
        //* which would resolve to no account — or worse, the wrong one.
        const hashAt = String(phone).indexOf('#');
        const phoneOnly = hashAt > -1 ? String(phone).slice(0, hashAt) : phone;
        const scopedUserId = hashAt > -1 ? String(phone).slice(hashAt + 1) : null;
        const chosenId = userId || scopedUserId;

        //* One phone number can belong to several accounts. Picking the first
        //* match would reset an arbitrary sibling's password, so when the
        //* number is shared we return the candidates and let the user choose
        //* instead of sending an OTP.
        const matches = await resolveAllUsersByIdentifier(phoneOnly);
        if (!matches.length) throw new ApiError(404, "No account found with this phone number");

        if (chosenId) {
            user = matches.find(u => String(u._id) === String(chosenId));
            //* Only accounts on THIS number are selectable — an arbitrary id
            //* must not be resettable by quoting someone else's number.
            if (!user) throw new ApiError(400, "That account is not registered to this phone number");
        } else if (matches.length > 1) {
            return res.status(200).json(new ApiResponse(200, {
                requiresAccountSelection: true,
                type: "phone",
                accounts: matches.map(accountChoice),
            }, "Several accounts use this number. Choose which one to reset."));
        } else {
            user = matches[0];
        }
    }

    //* File the OTP under the account's own identifier, never the typed
    //* string, so verification resolves to the same record no matter which
    //* spelling the client sends back.
    identifier = canonicalIdentifier(user, type);

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await rateCheckAndUpsertOtp({ identifier, type, purpose: "password_reset", hashedOtp, expiry, ip: clientIp(req) });

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
        //* The account's real number — `identifier` is scoped with the account
        //* id for shared phones and is not a dialable number.
        //*
        //* Wrapped like the registration path: unwrapped, a gateway failure
        //* surfaced as a 500 reading "something went wrong on our end", which
        //* sends somebody locked out of their account to support instead of
        //* telling them the SMS could not be delivered and to try again.
        try {
            await sendSms({ phone: String(user.phoneNumber), otp: plainOtp, request_type: 'password_reset' });
        } catch (smsErr) {
            if (process.env.NODE_ENV === 'development') {
                console.warn(`[DEV] SMS failed (${smsErr.message}). Reset OTP for ${user.phoneNumber}: ${plainOtp}`);
            } else {
                throw new ApiError(503, `Failed to send OTP: ${smsErr.message}. Please try again or contact support.`);
            }
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            type,
            //* Echo this back to /reset-password. For a shared phone it is
            //* scoped to the chosen account ("<number>#<accountId>"), so the
            //* right password is reset. It is an internal key — NEVER show it
            //* to the user; render `sentTo` instead.
            identifier,
            //* Where the OTP actually went, masked and human-readable.
            sentTo: type === 'email' ? maskEmail(user.email) : maskPhone(user.phoneNumber),
            userId: user._id,
            username: user.username,
            retryAfterSeconds: 60,
        }, `OTP sent to your ${type} successfully`)
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

    //* The save below uses validateBeforeSave:false, so the schema's
    //* minlength never runs — without this, reset could set any password.
    assertValidPassword(newPassword);

    //* Resolve the account FIRST, then look the OTP up under that account's
    //* canonical identifier. The client echoes back whatever it typed, which
    //* need not match how the value is stored (case, or a "+91" the number was
    //* never saved with) — resolving first makes the two halves agree.
    //*
    //* A phone identifier may arrive scoped as "<number>#<accountId>", which is
    //* how a shared number picks out one account; that id is authoritative.
    const raw = String(identifier);
    const scopedAt = raw.indexOf('#');
    const user = scopedAt > -1
        ? await User.findById(raw.slice(scopedAt + 1))
        : await resolveUserByIdentifier(raw);
    if (!user) throw new ApiError(404, "User not found");

    const type = raw.includes('@') ? "email" : "phone";
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

    //* Deliberately NOT rejecting a number another account already uses —
    //* several accounts may share one. Uniqueness lives on email + username.
    const normalizedPhone = normalizePhone(phone);

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await rateCheckAndUpsertOtp({ identifier: normalizedPhone, type: "phone", purpose: "phone_verification", hashedOtp, expiry, ip: clientIp(req) });

    try {
        await sendSms({ phone: normalizedPhone, otp: plainOtp, request_type });
    } catch (smsErr) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[DEV] SMS failed (${smsErr.message}). Phone verification OTP for ${normalizedPhone}: ${plainOtp}`);
        } else {
            throw new ApiError(503, `Failed to send OTP: ${smsErr.message}`);
        }
    }

    return res.status(200).json(new ApiResponse(200, { phone: normalizedPhone, retryAfterSeconds: 60 }, "OTP sent to your phone number"));
});

const verifyAndUpdatePhone = asyncHandler(async (req, res) => {
    const { phone, otp } = req.body;
    const userId = req.user._id;

    if (!phone || !otp) throw new ApiError(400, "Phone number and OTP are required");

    //* Filed under the normalised number, so normalise the lookup too —
    //* otherwise a client echoing the bare national part would miss it.
    const normalizedPhone = normalizePhone(phone);

    const otpRecord = await AuthOtp.findOne({
        identifier: normalizedPhone,
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
        $set: { phoneNumber: normalizedPhone, isPhoneVerified: true },
    });

    await AuthOtp.deleteOne({ _id: otpRecord._id });

    // Invalidate the cached profile snapshot so the new phone/verified
    // status is visible on the next profile fetch.
    {
        const { UserCacheManager } = await import("../../utils/cache.utils.js");
        await UserCacheManager.invalidateUserProfile(userId.toString());
    }

    return res.status(200).json(new ApiResponse(200, { phone: normalizedPhone, isPhoneVerified: true }, "Phone number verified and updated successfully"));
});

/**
 * Change the account's email — step 1 of 2: send an OTP to the NEW address.
 *
 * Nothing is written until the code is verified, so a typo cannot strand
 * someone on an address they do not own. (One account already reached
 * "@gamil.com" that way.)
 */
const sendEmailChangeOtp = asyncHandler(async (req, res) => {
    const { email } = req.body;
    const userId = req.user._id;

    if (!email) throw new ApiError(400, "Email is required");

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
        throw new ApiError(400, "Enter a valid email address");
    }

    const current = await User.findById(userId).select('email');
    if (current?.email && String(current.email).toLowerCase() === normalizedEmail) {
        throw new ApiError(400, "That is already your email address");
    }

    //* Email is unique per account, checked case-insensitively: the unique
    //* index is byte-wise, so "Foo@Gmail.com" would otherwise slip past a
    //* plain equality check against a stored "foo@gmail.com".
    const taken = await User.findOne({
        email: new RegExp(`^${escapeRegexLocal(normalizedEmail)}$`, 'i'),
        _id: { $ne: userId },
    });
    if (taken) throw new ApiError(409, "This email is already in use by another account");

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    //* Filed under the NEW address — that is what gets confirmed, and it keeps
    //* this separate from any password-reset OTP on the old one.
    await rateCheckAndUpsertOtp({
        identifier: normalizedEmail,
        type: "email",
        purpose: "email_verification",
        hashedOtp,
        expiry,
        ip: clientIp(req),
    });

    await sendEmail({
        to: normalizedEmail,
        subject: "Confirm your new email address - FinderNate",
        html: `
            <h3>Confirm your new email address</h3>
            <h2>Your OTP is: <b>${plainOtp}</b></h2>
            <p>This OTP is valid for 5 minutes.</p>
            <p>If you did not request this change you can ignore this email — your account is unchanged.</p>`
    });

    return res.status(200).json(
        new ApiResponse(200, { email: normalizedEmail, retryAfterSeconds: 60 }, "OTP sent to your new email address")
    );
});

/** Change the account's email — step 2 of 2: verify the OTP and save. */
const verifyAndUpdateEmail = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const userId = req.user._id;

    if (!email || !otp) throw new ApiError(400, "Email and OTP are required");

    const normalizedEmail = String(email).trim().toLowerCase();

    const otpRecord = await AuthOtp.findOne({
        identifier: normalizedEmail,
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

    //* Re-check immediately before writing: someone else could have claimed
    //* the address during the five minutes this OTP was valid.
    const taken = await User.findOne({
        email: new RegExp(`^${escapeRegexLocal(normalizedEmail)}$`, 'i'),
        _id: { $ne: userId },
    });
    if (taken) throw new ApiError(409, "This email is already in use by another account");

    await User.findByIdAndUpdate(userId, {
        $set: { email: normalizedEmail, isEmailVerified: true },
    });

    await AuthOtp.deleteOne({ _id: otpRecord._id });

    //* GET /users/profile serves a Redis snapshot; without this the old
    //* address keeps coming back for up to an hour.
    {
        const { UserCacheManager } = await import("../../utils/cache.utils.js");
        await UserCacheManager.invalidateUserProfile(userId.toString());
    }

    return res.status(200).json(
        new ApiResponse(200, { email: normalizedEmail, isEmailVerified: true }, "Email verified and updated successfully")
    );
});

export {
    getOtpStatus,
    sendVerificationOTPForEmail,
    verifyEmailWithOTP,
    sendPasswordResetOTP,
    resetPasswordWithOTP,
    sendPhoneVerificationOtp,
    verifyAndUpdatePhone,
    sendEmailChangeOtp,
    verifyAndUpdateEmail,
};
