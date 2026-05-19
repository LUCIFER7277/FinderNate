import { AuthOtp } from "../../models/authOtp.models.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";

export const OTP_EXPIRY_MS      = 5  * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_RATE_WINDOW_MS = 24 * 60 * 1000;
export const OTP_MAX_SENDS      = 3;

export const rateCheckAndUpsertOtp = async ({ identifier, type, purpose, hashedOtp, expiry }) => {
    const existing = await AuthOtp.findOne({ identifier, type, purpose });

    let sendCount   = 1;
    let windowStart = new Date();

    if (existing) {
        if (existing.retryAfter && new Date() < existing.retryAfter) {
            const secondsLeft = Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000);
            throw new ApiError(429,
                `Please wait ${secondsLeft} second${secondsLeft !== 1 ? 's' : ''} before requesting a new OTP.`,
                [{ retryAfterSeconds: secondsLeft }]
            );
        }

        const ws = existing.windowStart || existing.createdAt;
        const withinWindow = (Date.now() - ws.getTime()) < OTP_RATE_WINDOW_MS;
        if (withinWindow) {
            if (existing.sendCount >= OTP_MAX_SENDS) {
                throw new ApiError(429, "Too many OTP requests. Please try again after 10 minutes.");
            }
            sendCount   = (existing.sendCount || 1) + 1;
            windowStart = ws;
        }
    }

    const retryAfter = new Date(Date.now() + RESEND_COOLDOWN_MS);

    return AuthOtp.findOneAndUpdate(
        { identifier, type, purpose },
        { otp: hashedOtp, expiry, sendCount, windowStart, retryAfter },
        { upsert: true, new: true }
    );
};

export const generateAcessAndRefreshToken = async (userId) => {
    try {
        const user = await User.findById(userId);
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave: false });
        return { accessToken, refreshToken };
    } catch (error) {
        throw new ApiError(500, "something went wrong while generating tokens");
    }
};
