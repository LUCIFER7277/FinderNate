import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { v4 as uuidv4 } from "uuid";
import { sendSms } from "../../utils/sendSms.js";
import { TempUser } from "../../models/tempUser.models.js";
import { AuthOtp } from "../../models/authOtp.models.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {
    generateAcessAndRefreshToken,
    OTP_EXPIRY_MS,
    RESEND_COOLDOWN_MS,
} from "./_helpers.js";

const registerUser = asyncHandler(async (req, res) => {
    const { fullName, username, email, password, confirmPassword, phoneNumber, dateOfBirth, gender } = req.body;
    const request_type = 'phonenumber_verify';

    if (!fullName || !username || !email || !password || !confirmPassword || !phoneNumber) {
        throw new ApiError(400, "All fields are required");
    }

    if (password !== confirmPassword) {
        throw new ApiError(400, "Password and confirm password do not match");
    }

    // Usernames become part of a public URL (/userprofile/<username>), so they
    // must be URL-safe. A username containing a space produced a %20 in the URL
    // which no longer matched the stored value, and the profile 404'd with
    // "Unable to load user profile". The model only does `trim`, which strips
    // outer whitespace but happily stores "megha bhat".
    // Validated here rather than on the schema on purpose: a schema-level
    // `match` also runs when SAVING pre-existing users, and a few legacy
    // accounts (e.g. "ravi@gmail.com") would then fail every future save.
    const normalizedUsername = String(username).trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername)) {
        throw new ApiError(400, "Username may only contain lowercase letters, numbers, dots, underscores and hyphens (3-30 characters), with no spaces", [
            { field: "username", message: "Username may only contain letters, numbers, dots, underscores and hyphens — no spaces" }
        ]);
    }

    const [existingEmail, existingPhone, existingUsername] = await Promise.all([
        User.findOne({ email, isEmailVerified: true }),
        User.findOne({ phoneNumber: phoneNumber.trim() }),
        User.findOne({ username: normalizedUsername })
    ]);

    const errors = [];
    if (existingPhone) errors.push({ field: "phoneNumber", message: "Phone number already in use" });
    if (existingEmail) errors.push({ field: "email", message: "Email already in use" });
    if (existingUsername) errors.push({ field: "username", message: "Username already in use" });

    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join(", ");
        throw new ApiError(409, errorMessage, errors);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await TempUser.findOneAndUpdate(
        { phoneNumber },
        {
            fullName,
            fullNameLower: fullName.toLowerCase(),
            username: normalizedUsername,
            email,
            password: hashedPassword,
            phoneNumber,
            dateOfBirth,
            gender: gender || 'prefer-not-to-say',
        },
        { upsert: true, new: true }
    );

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await AuthOtp.findOneAndUpdate(
        { identifier: phoneNumber, type: "phone", purpose: "registration" },
        { otp: hashedOtp, expiry, retryAfter: new Date(Date.now() + RESEND_COOLDOWN_MS) },
        { upsert: true, new: true }
    );

    try {
        await sendSms({ phone: phoneNumber, otp: plainOtp, request_type });
    } catch (smsErr) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[DEV] SMS failed (${smsErr.message}). OTP for ${phoneNumber}: ${plainOtp}`);
        } else {
            throw new ApiError(503, `Failed to send OTP: ${smsErr.message}. Please try again or contact support.`);
        }
    }

    return res.status(200).json(
        new ApiResponse(200, { phone: phoneNumber }, "OTP sent to your phone number. Please verify to complete registration.")
    );
});

const verifyRegistrationOTP = asyncHandler(async (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
        throw new ApiError(400, "Phone number and OTP are required");
    }

    const otpRecord = await AuthOtp.findOne({
        identifier: phone,
        type: "phone",
        purpose: "registration",
    });

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

    const tempUser = await TempUser.findOne({ phoneNumber: phone });
    if (!tempUser) {
        throw new ApiError(404, "Registration session not found. Please register again.");
    }

    const uid = uuidv4();
    await User.collection.insertOne({
        uid,
        fullName: tempUser.fullName,
        fullNameLower: tempUser.fullNameLower,
        username: tempUser.username,
        email: tempUser.email,
        password: tempUser.password,
        phoneNumber: tempUser.phoneNumber,
        dateOfBirth: tempUser.dateOfBirth,
        gender: tempUser.gender || 'prefer-not-to-say',
        isPhoneVerified: true,
        accountStatus: "active",
        isDeleted: false,
        deletedAt: null,
        adminActionReason: null,
        privacy: "public",
        isFullPrivate: false,
        isPhoneNumberHidden: false,
        isAddressHidden: false,
        isBusinessProfile: false,
        isBlueTickVerified: false,
        messagingPrivacy: { onlineStatus: "everyone", lastSeen: "everyone" },
        servicePostPreferences: { enableAutoFill: true },
        productPostPreferences: { enableAutoFill: true },
        followers: [],
        following: [],
        posts: [],
        fcmToken: null,
        fcmTokenUpdatedAt: null,
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    const user = await User.findOne({ uid }).select("-password -refreshToken");

    await Promise.all([
        TempUser.deleteOne({ _id: tempUser._id }),
        AuthOtp.deleteOne({ _id: otpRecord._id }),
    ]);

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const options = { httpOnly: true, secure: true };

    return res
        .status(201)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(201, { user, accessToken, refreshToken }, "Account created successfully")
        );
});

const resendRegistrationOTP = asyncHandler(async (req, res) => {
    const { phone } = req.body;
    const request_type = 'phonenumber_verify';

    if (!phone) {
        throw new ApiError(400, "Phone number is required");
    }

    const tempUser = await TempUser.findOne({ phoneNumber: phone });
    if (!tempUser) {
        throw new ApiError(404, "Registration session not found. Please register again.");
    }

    const existing = await AuthOtp.findOne({ identifier: phone, type: "phone", purpose: "registration" });
    if (existing?.retryAfter && new Date() < existing.retryAfter) {
        const secondsLeft = Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000);
        throw new ApiError(429,
            `Please wait ${secondsLeft} second${secondsLeft !== 1 ? 's' : ''} before requesting a new OTP.`,
            [{ retryAfterSeconds: secondsLeft }]
        );
    }

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry     = new Date(Date.now() + OTP_EXPIRY_MS);
    const retryAfter = new Date(Date.now() + RESEND_COOLDOWN_MS);

    await AuthOtp.findOneAndUpdate(
        { identifier: phone, type: "phone", purpose: "registration" },
        { otp: hashedOtp, expiry, retryAfter },
        { upsert: true, new: true }
    );

    await sendSms({ phone, otp: plainOtp, request_type });

    return res.status(200).json(
        new ApiResponse(200, { retryAfterSeconds: 60 }, "OTP resent successfully")
    );
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, username, password } = req.body;

    if (!email && !username) {
        throw new ApiError(400, "Please provide either email or username");
    }

    if (email && username) {
        throw new ApiError(400, "Please provide either email OR username, not both");
    }

    if (!password) {
        throw new ApiError(400, "Password is required");
    }

    let user;
    if (email) {
        user = await User.findOne({ email });
    } else {
        // Trim as well as lowercase: a stray space from an autofilled login
        // field would otherwise never match a stored username.
        user = await User.findOne({ username: String(username).trim().toLowerCase() });
    }

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid credentials");
    }

    if (user.isDeleted) {
        throw new ApiError(403, "Your account has been deleted. Please contact Find support.");
    }

    if (user.accountStatus === 'banned') {
        throw new ApiError(403, "Your account has been banned. Please contact Find support.");
    }

    if (user.accountStatus === 'deactivated') {
        throw new ApiError(403, "Your account has been deactivated. Please contact Find support.");
    }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const loggedUser = await User.findById(user._id).select("-password -refreshToken");

    const options = { httpOnly: true, secure: true };

    return res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(200, {
            user: loggedUser,
            accessToken,
            refreshToken
        }, "Login successful"));
});

const logOutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        { $set: { refreshToken: undefined } },
        { new: true }
    );

    const options = { httpOnly: true, secure: true };

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged Out Successfully"));
});

const checkTokenExpiry = asyncHandler(async (req, res) => {
    try {
        let token;

        if (req.cookies?.accessToken) {
            token = req.cookies.accessToken;
        } else if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        if (!token) {
            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: true,
                    message: "No token provided"
                }, "Token status checked")
            );
        }

        try {
            const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
            const user = await User.findById(decodedToken?._id).select("-password -refreshToken");

            if (!user) {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: false,
                        message: "User no longer exists"
                    }, "Token status checked")
                );
            }

            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: true,
                    isExpired: false,
                    user: {
                        _id: user._id,
                        username: user.username,
                        fullName: user.fullName
                    },
                    expiresAt: new Date(decodedToken.exp * 1000),
                    message: "Token is valid"
                }, "Token status checked")
            );

        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: true,
                        expiredAt: new Date(jwtError.expiredAt),
                        message: "Token has expired"
                    }, "Token status checked")
                );
            }

            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: false,
                    message: "Invalid token"
                }, "Token status checked")
            );
        }

    } catch (error) {
        throw new ApiError(500, "Error checking token status: " + error.message);
    }
});

export {
    registerUser,
    verifyRegistrationOTP,
    resendRegistrationOTP,
    loginUser,
    logOutUser,
    checkTokenExpiry,
};
