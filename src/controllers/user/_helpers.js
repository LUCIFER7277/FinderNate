import { AuthOtp } from "../../models/authOtp.models.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";

export const OTP_EXPIRY_MS      = 5  * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_RATE_WINDOW_MS = 24 * 60 * 1000;
export const OTP_MAX_SENDS      = 3;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds a user from whatever a person typed: an email, a username, or a phone
 * number in any reasonable shape.
 *
 * This is deliberately forgiving because the stored data is not uniform.
 * Registration inserted through the raw driver for a long time, so schema
 * setters never ran: emails kept the case that was typed ("Foo@Gmail.com"),
 * and phone numbers were saved both bare ("9483122481") and E.164-ish
 * ("+919483122481"). A plain equality lookup matches one shape and silently
 * fails the rest, which is what made login and password reset look broken.
 *
 * Exact matches are attempted first so the indexes still do the work; the
 * regex is only a last resort.
 */
export const resolveUserByIdentifier = async (identifier) => {
    const raw = String(identifier || '').trim();
    if (!raw) return null;

    if (raw.includes('@')) {
        const email = raw.toLowerCase();
        return (await User.findOne({ email }))
            || (await User.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') }))
            // A username may legitimately contain '@' (e.g. "test@123"), so an
            // '@' is a hint, not proof that this is an email address.
            || (await User.findOne({ username: email }));
    }

    const digits = raw.replace(/\D/g, '');
    // 7+ digits and mostly numeric => treat as a phone, not a username.
    if (digits.length >= 7 && digits.length >= raw.replace(/[\s+\-()]/g, '').length) {
        const last10 = digits.slice(-10);
        const candidates = [raw, digits, last10, `+${digits}`, `+91${last10}`, `91${last10}`];
        for (const c of [...new Set(candidates)]) {
            const hit = await User.findOne({ phoneNumber: c });
            if (hit) return hit;
        }
        // Last resort: match on the final 10 digits however they were stored.
        return await User.findOne({ phoneNumber: new RegExp(`${escapeRegex(last10)}$`) });
    }

    return await User.findOne({ username: raw.toLowerCase() });
};

/**
 * Every account reachable by this identifier.
 *
 * A phone number is NOT unique in this product — families and resellers share
 * one, and some numbers are on a dozen accounts. Password reset therefore has
 * to ask which account is meant rather than silently picking whichever
 * document the database returned first.
 */
export const resolveAllUsersByIdentifier = async (identifier) => {
    const raw = String(identifier || '').trim();
    if (!raw) return [];

    if (raw.includes('@')) {
        const email = raw.toLowerCase();
        const byEmail = await User.find({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') });
        if (byEmail.length) return byEmail;
        return await User.find({ username: email });
    }

    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length >= raw.replace(/[\s+\-()]/g, '').length) {
        // Match on the last 10 digits so bare and +country-code storage
        // (both exist in this data) resolve to the same set.
        const last10 = digits.slice(-10);
        return await User.find({ phoneNumber: new RegExp(`${escapeRegex(last10)}$`) });
    }

    return await User.find({ username: raw.toLowerCase() });
};

/**
 * The stable identifier an OTP is filed under, so send and verify agree.
 *
 * Scoped by account id for phone, because one number can belong to several
 * accounts — an OTP filed under the bare number alone would be overwritten by
 * the next sibling account's request and reset the wrong password.
 */
export const canonicalIdentifier = (user, type) =>
    type === 'email' ? user.email : `${String(user.phoneNumber)}#${user._id}`;

/** Safe-to-return summary for the "which account?" chooser. */
export const accountChoice = (user) => ({
    id: user._id,
    username: user.username,
    fullName: user.fullName,
    profileImageUrl: user.profileImageUrl || null,
    // Masked: this list is returned for any phone number that is typed in, so
    // it must not hand out full addresses to whoever guesses a number.
    email: maskEmail(user.email),
});

export const maskEmail = (email) => {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at < 1) return '';
    const local = value.slice(0, at);
    const domain = value.slice(at);
    const shown = local.slice(0, Math.min(2, local.length));
    return `${shown}${'*'.repeat(Math.max(local.length - shown.length, 1))}${domain}`;
};

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
