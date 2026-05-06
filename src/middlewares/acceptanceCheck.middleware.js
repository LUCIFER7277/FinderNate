import { User } from "../models/user.models.js";
import { LegalVersion } from "../models/legalVersion.models.js";
import { LEGAL_VERSIONS } from "../constants/legalVersions.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Get effective version, preferring DB overrides over code constants.
 * Results are cached for 60 s per process to avoid hammering the DB.
 */
const _versionCache = { data: null, expiry: 0 };

async function getCachedVersions() {
  if (_versionCache.data && Date.now() < _versionCache.expiry) {
    return _versionCache.data;
  }
  const overrides = await LegalVersion.find({}).lean();
  const map = {};
  for (const o of overrides) map[o.docType] = o.version;
  const versions = {
    TERMS:     map.TERMS     || LEGAL_VERSIONS.TERMS,
    PRIVACY:   map.PRIVACY   || LEGAL_VERSIONS.PRIVACY,
    SELLER:    map.SELLER    || LEGAL_VERSIONS.SELLER,
    COMMUNITY: map.COMMUNITY || LEGAL_VERSIONS.COMMUNITY,
  };
  _versionCache.data   = versions;
  _versionCache.expiry = Date.now() + 60_000; // 60 s TTL
  return versions;
}

/**
 * requireCoreAcceptance — protects routes that need the latest Terms + Privacy.
 * Attach after verifyJWT.
 */
export const requireCoreAcceptance = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) return next(new ApiError(401, "Unauthenticated"));

    // Admins bypass acceptance checks
    if (user.role === "admin") return next();

    const versions = await getCachedVersions();
    const acc = user.legalAcceptance || {};

    if (!acc.termsAccepted || acc.termsVersion !== versions.TERMS) {
      return next(
        new ApiError(403, "TERMS_REACCEPTANCE_REQUIRED", [
          {
            code: "TERMS_REACCEPTANCE_REQUIRED",
            currentVersion: versions.TERMS,
            acceptedVersion: acc.termsVersion || null,
          },
        ])
      );
    }

    if (!acc.privacyAccepted || acc.privacyVersion !== versions.PRIVACY) {
      return next(
        new ApiError(403, "PRIVACY_REACCEPTANCE_REQUIRED", [
          {
            code: "PRIVACY_REACCEPTANCE_REQUIRED",
            currentVersion: versions.PRIVACY,
            acceptedVersion: acc.privacyVersion || null,
          },
        ])
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * requireSellerAcceptance — protects seller-only routes.
 * Ensures the user has accepted the latest Seller Terms AND Community Guidelines.
 */
export const requireSellerAcceptance = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) return next(new ApiError(401, "Unauthenticated"));

    if (user.role === "admin") return next();

    const versions = await getCachedVersions();
    const acc = user.legalAcceptance || {};

    if (!acc.sellerTermsAccepted || acc.sellerTermsVersion !== versions.SELLER) {
      return next(
        new ApiError(403, "SELLER_TERMS_REACCEPTANCE_REQUIRED", [
          {
            code: "SELLER_TERMS_REACCEPTANCE_REQUIRED",
            currentVersion: versions.SELLER,
            acceptedVersion: acc.sellerTermsVersion || null,
          },
        ])
      );
    }

    if (!acc.communityAccepted || acc.communityVersion !== versions.COMMUNITY) {
      return next(
        new ApiError(403, "COMMUNITY_GUIDELINES_REACCEPTANCE_REQUIRED", [
          {
            code: "COMMUNITY_GUIDELINES_REACCEPTANCE_REQUIRED",
            currentVersion: versions.COMMUNITY,
            acceptedVersion: acc.communityVersion || null,
          },
        ])
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Invalidates the in-process version cache.
 * Call this from the admin route after updating a version.
 */
export const invalidateVersionCache = () => {
  _versionCache.data   = null;
  _versionCache.expiry = 0;
};
