import crypto from "crypto";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { User } from "../../models/user.models.js";
import { AcceptanceLog } from "../../models/acceptanceLog.models.js";
import { LegalVersion } from "../../models/legalVersion.models.js";
import { LEGAL_VERSIONS } from "../../constants/legalVersions.js";
import { MIN_SIGNUP_AGE, normalizePhone } from "./_helpers.js";
import { isUsernameAvailable, validateUsername } from "../../utils/usernameSuggestions.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Same cost factor as registerUser and the UserSchema pre-save hook. Keep the
// three in step: a guest account has to be usable by the ordinary login path.
const BCRYPT_ROUNDS = 10;

// Username generation is a loop over a random space, so it must terminate even
// if the space is unlucky or the DB is misbehaving.
const MAX_USERNAME_ATTEMPTS = 12;

// How many times the insert itself is retried after a duplicate-key error that
// was NOT about the email (i.e. a lost race on `username` or `uid`). Bounded,
// because each attempt costs a username generation round-trip.
const MAX_INSERT_ATTEMPTS = 3;

/**
 * Effective legal versions, matching legal.controllers.js: an admin DB override
 * wins over the code constant.
 */
const getEffectiveVersions = async () => {
    const map = {};
    try {
        const overrides = await LegalVersion.find({});
        for (const o of overrides) map[o.docType] = o.version;
    } catch (err) {
        // Never let a legal-version read break a paid checkout — fall back to
        // the code constants, which is what an un-overridden install uses.
        console.error('[guestAccount] Legal version lookup failed:', err.message);
    }
    return {
        TERMS:   map.TERMS   || LEGAL_VERSIONS.TERMS,
        PRIVACY: map.PRIVACY || LEGAL_VERSIONS.PRIVACY,
    };
};

/**
 * A collision-safe username derived from the buyer's email/name.
 *
 * usernameSuggestions.js was written for the interactive "pick one of these"
 * screen — it returns a LIST and its per-candidate check is a plain findOne, so
 * a suggestion can go stale between the check and the insert. Here nobody is
 * choosing anything, so we loop until one is genuinely free, cap the attempts,
 * and let the unique index have the final word (the caller retries on E11000).
 */
const generateGuestUsername = async ({ email, fullName }) => {
    const seed = String(email || '').split('@')[0] || String(fullName || '');
    let base = seed.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    // isUsernameAvailable rejects anything under 3 characters, and a username
    // becomes part of a public URL, so pad a too-short base rather than looping
    // forever on a candidate that can never validate.
    if (base.length < 3) base = `buyer${base}`;
    base = base.slice(0, 20);

    for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
        // Random, not sequential: sequential suffixes make the username of the
        // next guest account guessable from the last one.
        const suffix = crypto.randomInt(1000, 999999).toString();
        const candidate = `${base}${suffix}`.slice(0, 30);

        // validateUsername also rejects the reserved list ("support", "admin",
        // "findernate" …), which the availability check alone does not.
        if (!validateUsername(candidate).isValid) continue;
        if (await isUsernameAvailable(candidate)) return candidate;
    }

    // Last resort: a name nothing else can plausibly be holding.
    return `buyer_${crypto.randomBytes(6).toString('hex')}`;
};

/**
 * Resolve — or create — the account behind a guest checkout.
 *
 * Called ONLY after a payment is confirmed, so an abandoned checkout leaves no
 * orphan identity behind.
 *
 * Contract:
 *  - EXISTING EMAIL IS A HARD STOP. If the address already belongs to someone,
 *    this returns { collision: true } and does nothing else: no account, no
 *    order attachment, no token. Attaching a stranger's paid order to an
 *    existing account on nothing more than a typed email address is an account
 *    takeover, so the buyer is sent to sign in instead.
 *  - The buyer never chooses a password. A crypto-random one is hashed in, and
 *    never disclosed or logged; the buyer sets a real one through the public
 *    reset-OTP pair. The field is NEVER left unset — bcrypt.compare against
 *    undefined throws, which would 500 login, changePassword and deleteAccount
 *    and leave the buyer unable to even delete the account.
 *  - NO SESSION TOKEN IS EVER ISSUED FROM HERE.
 *
 * `ip` is stored as LEGAL EVIDENCE (legalAcceptance.acceptanceIP, the
 * AcceptanceLog rows and guestAgeAttestation.ip), so the caller must pass
 * `req.ip` — resolved by express through the `trust proxy` setting in app.js —
 * and never a raw x-forwarded-for value, which is caller-supplied and would let
 * anyone forge the address on their own consent record.
 *
 * @returns {Promise<{collision: true, email: string}
 *                 | {collision: false, created: boolean, user: object, username: string}>}
 */
export const resolveOrCreateGuestBuyer = async ({
    email,
    fullName,
    phoneNumber,
    ageAttested,
    acceptedTerms,
    ip,
    userAgent,
}) => {
    // The insert below goes through User.collection — the RAW driver — so the
    // schema's `trim`/`lowercase` setters never run and whatever case was typed
    // would be stored verbatim. Every later lookup goes through the model,
    // where Mongoose DOES lowercase the filter, so an un-normalised address
    // would be permanently unreachable by login and password reset. Normalise
    // here, exactly as registration does.
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail) {
        return { collision: false, created: false, user: null, username: null };
    }

    const normalizedPhone = normalizePhone(phoneNumber);
    const displayName = String(fullName ?? '').trim() || normalizedEmail.split('@')[0];

    // Case-insensitive: the unique index is byte-wise, so "Foo@Gmail.com" and
    // "foo@gmail.com" are two different keys to it and a plain equality check
    // would miss an existing account.
    const existing = await User.findOne({
        email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i')
    }).select('_id');

    if (existing) {
        // Deliberately does NOT return the user document. Nothing downstream
        // may attach an order to it or mint a token for it.
        return { collision: true, email: normalizedEmail };
    }

    const versions = await getEffectiveVersions();
    const now = new Date();

    // Unguessable and never disclosed. 48 random bytes, hashed at the same cost
    // as every other password in this codebase.
    const randomPassword = crypto.randomBytes(48).toString('base64url');
    const hashedPassword = await bcrypt.hash(randomPassword, BCRYPT_ROUNDS);

    // Regenerated on a duplicate-key retry, so they are `let`, not `const`.
    let uid = uuidv4();
    let username = await generateGuestUsername({ email: normalizedEmail, fullName: displayName });

    // RAW DRIVER INSERT: no mongoose validators, setters or defaults run, so
    // every field this account needs has to be written explicitly here.
    const buildUserDoc = () => ({
        uid,
        fullName: displayName,
        fullNameLower: displayName.toLowerCase(),
        username,
        email: normalizedEmail,
        password: hashedPassword,
        phoneNumber: normalizedPhone,
        gender: 'prefer-not-to-say',
        // dateOfBirth is deliberately ABSENT. The buyer attested to being 13+
        // on the checkout form; inventing a birth date to satisfy the age gate
        // would be fabricating a fact about a person.
        isEmailVerified: false,
        isPhoneVerified: false,
        accountStatus: "active",
        isDeleted: false,
        deletedAt: null,
        adminActionReason: null,
        // RESTRICTED state. Consenting to buy something is not consent to have
        // a public social profile: the account is private, not discoverable in
        // people search, and its contact details are hidden until the buyer
        // signs in and opens it up themselves.
        privacy: "private",
        isFullPrivate: true,
        isPhoneNumberHidden: true,
        isAddressHidden: true,
        messagingPrivacy: { onlineStatus: "nobody", lastSeen: "nobody" },
        isBusinessProfile: false,
        isBlueTickVerified: false,
        servicePostPreferences: { enableAutoFill: true },
        productPostPreferences: { enableAutoFill: true },
        followers: [],
        following: [],
        posts: [],
        fcmToken: null,
        fcmTokenUpdatedAt: null,
        lastSeenAt: now,
        // Written inline rather than through POST /legal/accept-signup: that
        // endpoint requires a JWT, and a guest has none (and is never issued
        // one). Same shape legal.controllers.js stores, so the acceptance
        // middleware and the admin history screens read it unchanged.
        legalAcceptance: {
            termsAccepted:         !!acceptedTerms,
            termsAcceptedAt:       acceptedTerms ? now : null,
            termsVersion:          acceptedTerms ? versions.TERMS : null,
            privacyAccepted:       !!acceptedTerms,
            privacyAcceptedAt:     acceptedTerms ? now : null,
            privacyVersion:        acceptedTerms ? versions.PRIVACY : null,
            sellerTermsAccepted:   false,
            sellerTermsAcceptedAt: null,
            sellerTermsVersion:    null,
            communityAccepted:     false,
            communityAcceptedAt:   null,
            communityVersion:      null,
            acceptanceIP:          ip || null,
            acceptanceUserAgent:   userAgent || null,
        },
        // The 13+ attestation from the checkout checkbox. A REAL SCHEMA PATH
        // (see user.models.js): it used to be written only through the raw
        // driver, so Mongoose's strict mode silently dropped it from every
        // ordinary read and the compliance record was invisible to all the
        // code that might one day have to produce it.
        guestAgeAttestation: {
            attested:    !!ageAttested,
            minimumAge:  MIN_SIGNUP_AGE,
            attestedAt:  ageAttested ? now : null,
            source:      'guest_checkout',
            ip:          ip || null,
            userAgent:   userAgent || null,
        },
        createdAt: now,
        updatedAt: now,
    });

    // ── The duplicate-key race ───────────────────────────────────────────────
    //
    // THIS IS WHERE AN ACCOUNT TAKEOVER USED TO LIVE. On E11000 the old code
    // re-read `User.findOne({ email })` and handed THAT document back as the
    // account for this checkout, which payments.controllers.js then wrote into
    // order.buyerId. But the winner of a duplicate-key race is not necessarily
    // the document this call was creating: if the clash came from the EMAIL
    // index, the winning document belongs to somebody else, and a stranger's
    // paid order was attached to their account — exactly the takeover this
    // module's contract forbids.
    //
    // The only safe discriminator is the `uid` generated by THIS invocation.
    // A re-read document is ours if and only if it carries that uid (which
    // happens when the driver replays a retryable write whose first attempt
    // actually landed). Anything else is refused:
    //   - the email now belongs to another uid → { collision: true }, buyerId
    //     stays null, and the order is marked claimable instead;
    //   - the clash was on username/uid → nobody owns the email, so a fresh
    //     username is generated and the insert retried.
    //
    // Same shape as verifyRegistrationOTP in auth.js, which also refuses rather
    // than adopting the winning document.
    //
    // NOTE ON THE SIBLING RACE: two confirmations of the SAME payment (webhook
    // + verify) can both reach this point, and the loser refuses with
    // { collision: true } even though the winning account was created for this
    // very buyer. That is deliberate — it is indistinguishable here from a
    // stranger's account, and failing closed is the contract. It costs nothing:
    // the order-level attach is the real idempotency point, so the winner still
    // attaches the buyer and sends the claim link, and the winner's attach
    // clears any claimable marker the loser wrote.
    let created = false;
    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
        try {
            await User.collection.insertOne(buildUserDoc());
            created = true;
            break;
        } catch (e) {
            if (e?.code !== 11000) throw e;

            const emailOwner = await User.findOne({
                email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i')
            }).select('uid');

            if (emailOwner?.uid === uid) {
                // Our own insert, seen twice (a replayed retryable write).
                created = true;
                break;
            }

            if (emailOwner) {
                // Somebody else owns this address now. HARD STOP.
                return { collision: true, email: normalizedEmail };
            }

            // The email is still free, so the clash was on username (or uid).
            // Take a different name and try again.
            uid = uuidv4();
            username = await generateGuestUsername({ email: normalizedEmail, fullName: displayName });
        }
    }

    // Always re-read by OUR uid — never by email. A lookup by email can return
    // a document this call did not create.
    const user = created
        ? await User.findOne({ uid }).select("-password -refreshToken")
        : null;

    if (!user) {
        // Either every insert attempt lost a username race, or the document
        // vanished between insert and read. Nothing was created for this buyer
        // and nothing may be attached to the order.
        return { collision: false, created: false, user: null, username: null };
    }

    if (created && acceptedTerms) {
        // Audit trail, mirroring acceptAtSignup. Best effort: a failure here
        // must not undo a completed payment.
        try {
            await AcceptanceLog.insertMany([
                { userId: user._id, docType: "TERMS",   version: versions.TERMS,   acceptedAt: now, ipAddress: ip || null, userAgent: userAgent || null },
                { userId: user._id, docType: "PRIVACY", version: versions.PRIVACY, acceptedAt: now, ipAddress: ip || null, userAgent: userAgent || null },
            ]);
        } catch (err) {
            console.error('[guestAccount] Acceptance log write failed:', err.message);
        }
    }

    // No token. Not here, not anywhere on the checkout path — the buyer reaches
    // this account through /users/send-reset-otp + /users/reset-password.
    return { collision: false, created, user, username: user.username };
};

export default resolveOrCreateGuestBuyer;
