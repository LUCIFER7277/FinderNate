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
/**
 * Wrong codes that may be tried against ONE OTP before it is locked.
 *
 * The send caps above limit how many codes go out; nothing limited how many
 * were guessed, so the same 6-digit code could be walked from 000000 upwards
 * for the whole five minutes it was valid — an unassisted account takeover on
 * password reset. Five is enough for a mistyped code, far short of 10^6.
 */
export const OTP_MAX_ATTEMPTS   = 5;
/** How long a burnt OTP stays locked. It expires inside this window anyway. */
export const OTP_LOCK_MS        = 15 * 60 * 1000;

// ── Failed-login throttle ──────────────────────────────────────────────────
/** Consecutive failed sign-ins allowed per account before the cooldown. */
export const LOGIN_MAX_FAILURES  = 10;
/** How long the counter (and therefore the cooldown) lasts. */
export const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

// ── Password policy ────────────────────────────────────────────────────────
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 20;

// ── Age policy ─────────────────────────────────────────────────────────────
/**
 * Minimum age to hold an account, matching the declared store content rating.
 *
 * 18 to agree with the Terms, Privacy Policy and Seller Terms, and with the
 * 18+ target audience declared on the Play listing. Keep in step with
 * kMinimumSignupAgeYears in the app's personal_information_page_1.dart.
 */
export const MIN_SIGNUP_AGE = 18;

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

/**
 * The client address the per-IP OTP quota is keyed on.
 *
 * This used to read the LEFTMOST `x-forwarded-for` entry, with `x-real-ip`
 * behind it and `req.ip` only third. Both of those headers are supplied by the
 * caller, so the quota above was keyed on a string the attacker chooses: every
 * request with a fresh `X-Forwarded-For` landed in a fresh, empty bucket and
 * OTP_MAX_PER_IP bounded nothing at all. A script could send unlimited OTPs —
 * unlimited SMS spend, and unlimited codes at a chosen victim's number — from
 * one host without touching a proxy.
 *
 * `req.ip` is what express resolves through the `trust proxy` setting in
 * app.js: behind our proxy it is the last hop the proxy actually observed, and
 * in development (where trust proxy is off) it is the socket address. Either
 * way it is not caller-supplied, which is the whole point.
 *
 * EVERY caller of this helper feeds it straight into `rateCheckAndUpsertOtp({
 * ip })` → assertIpOtpQuota (controllers/user/auth.js and
 * controllers/user/otp.js), so nothing else changes behaviour here. Consent
 * records already went to req.ip directly for this same reason — see
 * recordGuestConsent in utils/guestCheckout.utils.js.
 */
export const clientIp = (req) =>
    req?.ip
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
        {
            otp: hashedOtp, expiry, sendCount, windowStart, retryAfter,
            //* A new code is a new secret, so it gets a fresh attempt budget and
            //* clears any lock. That is not a way around the lockout: sends are
            //* still capped at OTP_MAX_SENDS a day behind a 60s cooldown, which
            //* leaves at most OTP_MAX_SENDS * OTP_MAX_ATTEMPTS guesses out of a
            //* million. Without this, a genuine user who mistyped five times
            //* could not recover their account even with a brand-new code.
            attemptCount: 0,
            lockedUntil: null,
        },
        { upsert: true, new: true }
    );
};

/**
 * Refuses verification while an OTP is locked out.
 *
 * Call this BEFORE comparing the code, so a locked record costs the attacker a
 * 429 rather than another free guess.
 */
export const assertOtpNotLocked = (otpRecord) => {
    if (otpRecord?.lockedUntil && new Date() < otpRecord.lockedUntil) {
        const secondsLeft = Math.ceil((otpRecord.lockedUntil.getTime() - Date.now()) / 1000);
        throw new ApiError(429,
            "Too many incorrect codes. Please request a new OTP.",
            [{ retryAfterSeconds: secondsLeft }]
        );
    }
};

/**
 * Charges a wrong code to this OTP's attempt budget and throws.
 *
 * A wrong guess used to cost nothing at all — the record was left untouched and
 * a plain 400 came back — so the code could be brute-forced for its whole life.
 * Every failed verification now consumes one of OTP_MAX_ATTEMPTS, and the last
 * one locks the record until a new code is requested.
 */
export const registerFailedOtpAttempt = async (otpRecord) => {
    const attempts = (otpRecord.attemptCount || 0) + 1;
    const locked = attempts >= OTP_MAX_ATTEMPTS;

    await AuthOtp.updateOne(
        { _id: otpRecord._id },
        {
            $set: {
                attemptCount: attempts,
                lockedUntil: locked ? new Date(Date.now() + OTP_LOCK_MS) : (otpRecord.lockedUntil || null),
            },
        }
    );

    if (locked) {
        throw new ApiError(429, "Too many incorrect codes. Please request a new OTP.");
    }

    const remaining = OTP_MAX_ATTEMPTS - attempts;
    throw new ApiError(400,
        `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
};

/**
 * Per-account failed-sign-in throttle.
 *
 * /users/login had no limiter of its own and the general one allows 50,000
 * requests a minute, so passwords could be sprayed without resistance. Counted
 * per ACCOUNT rather than per IP on purpose: `x-forwarded-for` is caller-
 * supplied, so an IP-keyed counter is bypassed by rotating one header.
 *
 * Fails OPEN if Redis is unavailable — a cache outage must not lock everybody
 * out of signing in.
 */
export const assertLoginAttemptsAvailable = async (userId) => {
    if (!userId) return;
    try {
        const count = Number(await redisClient.get(`login:fail:${userId}`)) || 0;
        if (count >= LOGIN_MAX_FAILURES) {
            throw new ApiError(429,
                "Too many failed sign-in attempts. Please try again in a few minutes, or reset your password.");
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        console.error('[LOGIN] failure throttle check skipped:', err.message);
    }
};

/** Records one wrong password for this account. */
export const registerFailedLogin = async (userId) => {
    if (!userId) return;
    try {
        const key = `login:fail:${userId}`;
        const count = await redisClient.incr(key);
        if (count === 1) {
            await redisClient.expire(key, Math.floor(LOGIN_FAIL_WINDOW_MS / 1000));
        }
    } catch (err) {
        console.error('[LOGIN] failure counter skipped:', err.message);
    }
};

/** Clears the failure counter once the right password arrives. */
export const clearFailedLogins = async (userId) => {
    if (!userId) return;
    try {
        await redisClient.del(`login:fail:${userId}`);
    } catch (err) {
        console.error('[LOGIN] failure counter reset skipped:', err.message);
    }
};

/**
 * Minimum-age gate for signup.
 *
 * Nothing derived an age anywhere: the clients only blocked future dates and
 * the register handler wrote `dateOfBirth` straight to the document, so a
 * child could complete signup and get DMs and escrow checkout. Play and the
 * App Store both require an age gate on a social app carrying UGC and
 * messaging, and DPDP requires parental consent below 18.
 */
export const assertMinimumAge = (dateOfBirth) => {
    if (!dateOfBirth) {
        throw new ApiError(400, "Date of birth is required", [
            { field: "dateOfBirth", message: "Date of birth is required" },
        ]);
    }

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
        throw new ApiError(400, "Enter a valid date of birth", [
            { field: "dateOfBirth", message: "Enter a valid date of birth" },
        ]);
    }

    const now = new Date();
    if (dob > now) {
        throw new ApiError(400, "Date of birth cannot be in the future", [
            { field: "dateOfBirth", message: "Date of birth cannot be in the future" },
        ]);
    }

    //* Whole years, so a birthday later today does not count as reached.
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
        age -= 1;
    }

    if (age < MIN_SIGNUP_AGE) {
        throw new ApiError(400,
            `You must be at least ${MIN_SIGNUP_AGE} years old to create a Findernate account`, [
            { field: "dateOfBirth", message: `You must be at least ${MIN_SIGNUP_AGE} years old to create an account` },
        ]);
    }

    return dob;
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
