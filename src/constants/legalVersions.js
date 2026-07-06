// Legal document version constants
// Increment the version string whenever you update a document.
// The middleware will block access for users on older versions until they re-accept.

export const LEGAL_VERSIONS = {
  TERMS:      "v1.0",
  PRIVACY:    "v1.0",
  SELLER:     "v1.0",
  COMMUNITY:  "v1.0",
};

// Human-readable titles used in API responses and admin panel
export const LEGAL_TITLES = {
  TERMS:     "Terms of Use",
  PRIVACY:   "Privacy Policy",
  SELLER:    "Seller Terms & Conditions",
  COMMUNITY: "Community Guidelines",
};

// Document types enum (used in AcceptanceLog model)
export const DOC_TYPES = ["TERMS", "PRIVACY", "SELLER", "COMMUNITY"];
