import { AuthOtp } from "../../models/authOtp.models.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { redisClient } from "../../config/redis.config.js";

export const OTP_EXPIRY_MS      = 5  * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
//* 24 HOURS. This was 24 * 60 * 1000 — twenty-four MINUTES — so the daily cap
//* reset every half hour and barely limited anything.
export const OTP_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** OTPs one account (email address / phone number) may request per day. */
export const OTP_MAX_SENDS      = 20;
/** OTPs one IP or device may request per day, across all accounts. */
export const OTP_MAX_PER_IP     = 50;

// ── Password policy ────────────────────────────────────────────────────────
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 20;

/**
 * Enforces the password policy server-side.
 *
 * The schema's `minlength: 8` never actually ran: registration writes through
 * `User.collection.insertOne` (raw driver, no validators) and password reset
 * saves with `validateBeforeSave: false`. Both paths bypassed it entirely, so
 * any API client could set a one-character password.
 */
export const assertValidPassword = (password) => {
    const value = String(password ?? '');
    if (value.length < PASSWORD_MIN) {
        throw new ApiError(400, `Password must be at least ${PASSWORD_MIN} characters`, [
            { field: "password", message: `Password must be at least ${PASSWORD_MIN} characters` },
        ]);
    }
    if (value.length > PASSWORD_MAX) {
        throw new ApiError(400, `Password must be at most ${PASSWORD_MAX} characters`, [
            { field: "password", message: `Password must be at most ${PASSWORD_MAX} characters` },
        ]);
    }
    return value;
};

/**
 * Normalises a phone number to E.164 ("+919483122481").
 *
 * The web sent countryCode + number while the app sent the bare national
 * number, so the same person signing up on both produced two records the
 * duplicate check could not see — that is how one number ended up on 13
 * accounts. Everything is stored in one shape from here on.
 */
export const normalizePhone = (phone, defaultCountryCode = '+91') => {
    const raw = String(phone ?? '').trim();
    if (!raw) return '';
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (raw.startsWith('+')) return `+${digits}`;
    //* A bare national number: prepend the default dial code. 10 digits is the
    //* Indian case; longer strings that already carry a country code are kept.
    if (digits.length <= 10) return `${defaultCountryCode}${digits}`;
    return `+${digits}`;
};

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

/** Display-safe phone: "+91 ****** 0243". Keeps the last 4 for recognition. */
export const maskPhone = (phone) => {
    const value = String(phone || '');
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4) return '';
    const last4 = digits.slice(-4);
    const prefix = value.startsWith('+') ? `+${digits.slice(0, digits.length - 10) || ''} ` : '';
    return `${prefix}${'*'.repeat(Math.max(digits.length - 4 - (prefix ? prefix.replace(/\D/g, '').length : 0), 3))} ${last4}`.trim();
};

/**
 * Masks the local part but keeps BOTH ends visible — "me********30@gmail.com".
 * Showing the tail as well as the head is what makes two of your own accounts
 * tellable apart; the head alone often matches for both.
 *
 * Local parts of six characters or fewer get a head only, because revealing
 * both ends of a short name reveals the whole name.
 */
export const maskEmail = (email) => {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at < 1) return '';
    const local = value.slice(0, at);
    const domain = value.slice(at);

    if (local.length <= 2) return `${local.slice(0, 1)}*${domain}`;
    if (local.length <= 6) {
        return `${local.slice(0, 1)}${'*'.repeat(local.length - 1)}${domain}`;
    }
    const head = local.slice(0, 2);
    const tail = local.slice(-2);
    return `${head}${'*'.repeat(local.length - 4)}${tail}${domain}`;
};

/**
 * Per-IP / per-device daily OTP cap, on top of the per-account one.
 *
 * The per-account cap alone does not stop a script walking a list of numbers:
 * each one is under its own limit while the SMS bill is not. Counted in Redis
 * with a 24h TTL.
 *
 * Fails OPEN if Redis is unavailable — a cache outage must not stop everyone
 * signing in. The per-account cap still applies in that case.
 */
export const assertIpOtpQuota = async (ip) => {
    if (!ip) return;
    const key = `otp:ip:${ip}`;
    try {
        const count = await redisClient.incr(key);
        if (count === 1) {
            await redisClient.expire(key, Math.floor(OTP_RATE_WINDOW_MS / 1000));
        }
        if (count > OTP_MAX_PER_IP) {
            throw new ApiError(429,
                "Too many OTP requests from this device today. Please try again tomorrow.");
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        console.error('[OTP] IP quota check skipped:', err.message);
    }
};

/** Best-effort client address, honouring the proxy in front of the API. */
export const clientIp = (req) =>
    (req?.headers?.['x-forwarded-for']?.split(',')[0] ?? '').trim()
    || req?.headers?.['x-real-ip']
    || req?.ip
    || req?.socket?.remoteAddress
    || '';

export const rateCheckAndUpsertOtp = async ({ identifier, type, purpose, hashedOtp, expiry, ip }) => {
    await assertIpOtpQuota(ip);

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
                throw new ApiError(429,
                    `You have requested the maximum of ${OTP_MAX_SENDS} OTPs for this account today. Please try again tomorrow.`);
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
