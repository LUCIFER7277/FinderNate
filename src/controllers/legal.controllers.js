import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/user.models.js";
import { AcceptanceLog } from "../models/acceptanceLog.models.js";
import { LegalVersion } from "../models/legalVersion.models.js";
import { LEGAL_VERSIONS, LEGAL_TITLES, DOC_TYPES } from "../constants/legalVersions.js";
import { invalidateVersionCache } from "../middlewares/acceptanceCheck.middleware.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the effective (active) version for a document type.
 * Admin DB overrides take precedence over code constants.
 */
async function getEffectiveVersion(docType) {
  const override = await LegalVersion.findOne({ docType });
  return override ? override.version : LEGAL_VERSIONS[docType];
}

/**
 * Get effective versions for all document types at once.
 */
export async function getAllEffectiveVersions() {
  const overrides = await LegalVersion.find({});
  const map = {};
  for (const o of overrides) map[o.docType] = o.version;
  return {
    TERMS:     map.TERMS     || LEGAL_VERSIONS.TERMS,
    PRIVACY:   map.PRIVACY   || LEGAL_VERSIONS.PRIVACY,
    SELLER:    map.SELLER    || LEGAL_VERSIONS.SELLER,
    COMMUNITY: map.COMMUNITY || LEGAL_VERSIONS.COMMUNITY,
  };
}

export function extractClientMeta(req) {
  // `ip` is stored as LEGAL EVIDENCE — legalAcceptance.acceptanceIP and every
  // AcceptanceLog row — so it must be `req.ip`, which express resolves through
  // the `trust proxy` setting in app.js. The raw x-forwarded-for header this
  // used to read is entirely caller-supplied: anyone could prepend an address
  // and point their own consent record at a third party, or repudiate it later
  // ("the IP in your log is not mine"). guestAccount.js states the same rule.
  const ip = req.ip || req.socket?.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;
  return { ip, userAgent };
}

// ─── Signup consent checkbox (shared with controllers/user/auth.js) ───────────

/**
 * THE request field name for the consent checkbox on the signup form.
 *
 * One boolean covers BOTH documents: the form shows a single checkbox whose
 * label links to the Terms of Use and to the Privacy Policy, so ticking it is
 * one act of acceptance recorded against both. The name is deliberately the
 * one acceptAtSignup below already reads out of req.body, so there is exactly
 * one spelling of "the user ticked the box" across the whole API.
 *
 * Both clients (Flutter app and website) must send this key.
 */
export const SIGNUP_CONSENT_FIELD = "termsAccepted";

/**
 * Other spellings accepted on the way IN only. Nothing should send these —
 * they exist so that a client wired to the sibling names already used
 * elsewhere in this codebase (acceptAtSignup's `privacyAccepted`, guest
 * checkout's `acceptedTerms`) records consent instead of being rejected.
 */
const SIGNUP_CONSENT_ALIASES = [SIGNUP_CONSENT_FIELD, "privacyAccepted", "acceptedTerms"];

/**
 * Read the signup consent flag off a request body.
 *
 * @returns {true|false|null} `null` when the body carries NO flag at all —
 * an install that predates the checkbox. Callers MUST treat null as "unknown",
 * never as "refused": the shipped app has to keep being able to register.
 * `false` is a real refusal (the user unticked the box) and is rejected
 * by the caller.
 */
export function readSignupConsent(body) {
  for (const key of SIGNUP_CONSENT_ALIASES) {
    const raw = body?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    // multipart/form-data and query strings deliver booleans as strings.
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  }
  return null;
}

/**
 * The COMPLETE `legalAcceptance` sub-document for a brand-new account.
 *
 * Every key is set explicitly, including the ones left untouched: registration
 * inserts through the RAW driver (User.collection.insertOne), where none of the
 * schema defaults declared in user.models.js run, so an omitted key is simply
 * absent from the stored document rather than `false`/`null` — and
 * getAcceptanceStatus / the acceptance middleware would then read `undefined`.
 * Same shape guestAccount.js writes, so the admin history screens read it
 * unchanged.
 *
 * `ip` is LEGAL EVIDENCE and must come from extractClientMeta (i.e. `req.ip`),
 * never a raw x-forwarded-for value — see the note on that helper.
 */
export function buildSignupLegalAcceptance({ accepted, versions, ip, userAgent, acceptedAt }) {
  const at = accepted ? acceptedAt : null;
  return {
    termsAccepted:         !!accepted,
    termsAcceptedAt:       at,
    termsVersion:          accepted ? versions.TERMS : null,
    privacyAccepted:       !!accepted,
    privacyAcceptedAt:     at,
    privacyVersion:        accepted ? versions.PRIVACY : null,
    // Seller onboarding is a separate, later act — see acceptSellerOnboarding.
    sellerTermsAccepted:   false,
    sellerTermsAcceptedAt: null,
    sellerTermsVersion:    null,
    communityAccepted:     false,
    communityAcceptedAt:   null,
    communityVersion:      null,
    // Recorded only alongside an actual acceptance: an IP filed under
    // `acceptanceIP` when nothing was accepted is evidence of nothing.
    acceptanceIP:          accepted ? (ip || null) : null,
    acceptanceUserAgent:   accepted ? (userAgent || null) : null,
  };
}

// ─── Get current legal versions ───────────────────────────────────────────────

export const getCurrentVersions = asyncHandler(async (req, res) => {
  const versions = await getAllEffectiveVersions();
  return res.status(200).json(new ApiResponse(200, { versions }, "Current legal versions"));
});

// ─── Get user's acceptance status ─────────────────────────────────────────────

export const getAcceptanceStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "legalAcceptance sellerProfile"
  );
  if (!user) throw new ApiError(404, "User not found");

  const versions = await getAllEffectiveVersions();
  const acc = user.legalAcceptance || {};

  const status = {
    terms: {
      accepted: acc.termsAccepted || false,
      version: acc.termsVersion || null,
      currentVersion: versions.TERMS,
      needsReAcceptance: (acc.termsVersion !== versions.TERMS),
    },
    privacy: {
      accepted: acc.privacyAccepted || false,
      version: acc.privacyVersion || null,
      currentVersion: versions.PRIVACY,
      needsReAcceptance: (acc.privacyVersion !== versions.PRIVACY),
    },
    seller: {
      accepted: acc.sellerTermsAccepted || false,
      version: acc.sellerTermsVersion || null,
      currentVersion: versions.SELLER,
      needsReAcceptance: (acc.sellerTermsAccepted && acc.sellerTermsVersion !== versions.SELLER),
    },
    community: {
      accepted: acc.communityAccepted || false,
      version: acc.communityVersion || null,
      currentVersion: versions.COMMUNITY,
      needsReAcceptance: (acc.communityAccepted && acc.communityVersion !== versions.COMMUNITY),
    },
  };

  return res.status(200).json(new ApiResponse(200, { status }, "Acceptance status"));
});

// ─── Accept terms at signup (terms + privacy together) ────────────────────────

export const acceptAtSignup = asyncHandler(async (req, res) => {
  const { termsAccepted, privacyAccepted } = req.body;

  if (!termsAccepted || !privacyAccepted) {
    throw new ApiError(400, "You must accept both Terms of Use and Privacy Policy to continue");
  }

  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, "User not found");

  const versions = await getAllEffectiveVersions();
  const { ip, userAgent } = extractClientMeta(req);
  const now = new Date();

  user.legalAcceptance = user.legalAcceptance || {};
  user.legalAcceptance.termsAccepted = true;
  user.legalAcceptance.termsAcceptedAt = now;
  user.legalAcceptance.termsVersion = versions.TERMS;
  user.legalAcceptance.privacyAccepted = true;
  user.legalAcceptance.privacyAcceptedAt = now;
  user.legalAcceptance.privacyVersion = versions.PRIVACY;
  user.legalAcceptance.acceptanceIP = ip;
  user.legalAcceptance.acceptanceUserAgent = userAgent;

  await user.save();

  // Audit log
  await AcceptanceLog.insertMany([
    { userId: user._id, docType: "TERMS",   version: versions.TERMS,   acceptedAt: now, ipAddress: ip, userAgent },
    { userId: user._id, docType: "PRIVACY", version: versions.PRIVACY, acceptedAt: now, ipAddress: ip, userAgent },
  ]);

  return res.status(200).json(new ApiResponse(200, {}, "Terms and Privacy Policy accepted"));
});

// ─── Accept individual document ───────────────────────────────────────────────

export const acceptDocument = asyncHandler(async (req, res) => {
  const { docType } = req.params;

  if (!DOC_TYPES.includes(docType)) {
    throw new ApiError(400, `Invalid document type. Must be one of: ${DOC_TYPES.join(", ")}`);
  }

  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, "User not found");

  const version = await getEffectiveVersion(docType);
  const { ip, userAgent } = extractClientMeta(req);
  const now = new Date();

  user.legalAcceptance = user.legalAcceptance || {};

  const fieldMap = {
    TERMS:     { accepted: "termsAccepted",       at: "termsAcceptedAt",       ver: "termsVersion" },
    PRIVACY:   { accepted: "privacyAccepted",      at: "privacyAcceptedAt",     ver: "privacyVersion" },
    SELLER:    { accepted: "sellerTermsAccepted",  at: "sellerTermsAcceptedAt", ver: "sellerTermsVersion" },
    COMMUNITY: { accepted: "communityAccepted",    at: "communityAcceptedAt",   ver: "communityVersion" },
  };

  const fields = fieldMap[docType];
  user.legalAcceptance[fields.accepted] = true;
  user.legalAcceptance[fields.at]       = now;
  user.legalAcceptance[fields.ver]      = version;
  user.legalAcceptance.acceptanceIP          = ip;
  user.legalAcceptance.acceptanceUserAgent   = userAgent;

  await user.save();

  await AcceptanceLog.create({
    userId: user._id,
    docType,
    version,
    acceptedAt: now,
    ipAddress: ip,
    userAgent,
  });

  return res.status(200).json(
    new ApiResponse(200, { docType, version }, `${LEGAL_TITLES[docType]} accepted (${version})`)
  );
});

// ─── Accept seller onboarding (seller terms + community together) ─────────────

export const acceptSellerOnboarding = asyncHandler(async (req, res) => {
  const { sellerTermsAccepted, communityAccepted } = req.body;

  if (!sellerTermsAccepted || !communityAccepted) {
    throw new ApiError(
      400,
      "You must accept both Seller Terms & Conditions and Community Guidelines to become a Seller"
    );
  }

  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, "User not found");

  const versions = await getAllEffectiveVersions();
  const { ip, userAgent } = extractClientMeta(req);
  const now = new Date();

  user.legalAcceptance = user.legalAcceptance || {};
  user.legalAcceptance.sellerTermsAccepted  = true;
  user.legalAcceptance.sellerTermsAcceptedAt= now;
  user.legalAcceptance.sellerTermsVersion   = versions.SELLER;
  user.legalAcceptance.communityAccepted    = true;
  user.legalAcceptance.communityAcceptedAt  = now;
  user.legalAcceptance.communityVersion     = versions.COMMUNITY;
  user.legalAcceptance.acceptanceIP          = ip;
  user.legalAcceptance.acceptanceUserAgent   = userAgent;

  await user.save();

  await AcceptanceLog.insertMany([
    { userId: user._id, docType: "SELLER",    version: versions.SELLER,    acceptedAt: now, ipAddress: ip, userAgent },
    { userId: user._id, docType: "COMMUNITY", version: versions.COMMUNITY, acceptedAt: now, ipAddress: ip, userAgent },
  ]);

  return res.status(200).json(
    new ApiResponse(200, {}, "Seller Terms and Community Guidelines accepted. Seller onboarding complete.")
  );
});

// ─── Get acceptance history for a user ────────────────────────────────────────

export const getAcceptanceHistory = asyncHandler(async (req, res) => {
  const logs = await AcceptanceLog.find({ userId: req.user._id })
    .sort({ acceptedAt: -1 })
    .lean();

  return res.status(200).json(new ApiResponse(200, { logs }, "Acceptance history"));
});

// ─── ADMIN: Get all current versions ──────────────────────────────────────────

export const adminGetVersions = asyncHandler(async (req, res) => {
  const overrides = await LegalVersion.find({}).populate("updatedBy", "username fullName").lean();
  const versions = await getAllEffectiveVersions();

  return res.status(200).json(
    new ApiResponse(200, { versions, overrides }, "Admin: current legal versions")
  );
});

// ─── ADMIN: Update a document version and force re-acceptance ─────────────────

export const adminUpdateVersion = asyncHandler(async (req, res) => {
  const { docType, version, changeNote } = req.body;

  if (!DOC_TYPES.includes(docType)) {
    throw new ApiError(400, `Invalid document type. Must be one of: ${DOC_TYPES.join(", ")}`);
  }
  if (!version || typeof version !== "string" || !version.startsWith("v")) {
    throw new ApiError(400, "Version must be a string starting with 'v' e.g. 'v1.1'");
  }

  // Upsert the override record
  await LegalVersion.findOneAndUpdate(
    { docType },
    {
      version,
      effectiveDate: new Date(),
      updatedBy: req.user._id,
      changeNote: changeNote || "",
    },
    { upsert: true, new: true }
  );

  // We don't clear the users' stored versions — we just leave the old version
  // on the record. The acceptance middleware detects the mismatch and forces
  // re-acceptance.
  //
  // That middleware caches the effective versions for 60 s per process, and this
  // handler never invalidated it, so the new version was ignored until the TTL
  // happened to lapse — and every process cached independently. Drop the cache
  // here so the change takes effect the moment the admin saves it.
  invalidateVersionCache();

  return res.status(200).json(
    new ApiResponse(
      200,
      { docType, version },
      `${LEGAL_TITLES[docType]} updated to ${version}. All users will be required to re-accept.`
    )
  );
});

// ─── ADMIN: View acceptance history for any user ──────────────────────────────

export const adminGetUserAcceptanceHistory = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const logs = await AcceptanceLog.find({ userId })
    .sort({ acceptedAt: -1 })
    .lean();

  const user = await User.findById(userId).select("username fullName legalAcceptance").lean();
  if (!user) throw new ApiError(404, "User not found");

  return res.status(200).json(
    new ApiResponse(200, { user, logs }, "User acceptance history")
  );
});
