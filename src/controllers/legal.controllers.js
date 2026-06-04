import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/user.models.js";
import { AcceptanceLog } from "../models/acceptanceLog.models.js";
import { LegalVersion } from "../models/legalVersion.models.js";
import { LEGAL_VERSIONS, LEGAL_TITLES, DOC_TYPES } from "../constants/legalVersions.js";

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
async function getAllEffectiveVersions() {
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

function extractClientMeta(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    null;
  const userAgent = req.headers["user-agent"] || null;
  return { ip, userAgent };
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

  // Bulk-clear acceptance for this document so all users must re-accept
  const fieldMap = {
    TERMS:     "legalAcceptance.termsVersion",
    PRIVACY:   "legalAcceptance.privacyVersion",
    SELLER:    "legalAcceptance.sellerTermsVersion",
    COMMUNITY: "legalAcceptance.communityVersion",
  };

  // We don't delete the field — we just leave the old version stored.
  // The middleware detects the mismatch and forces re-acceptance.

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
