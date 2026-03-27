import mongoose from "mongoose";
import { DOC_TYPES } from "../constants/legalVersions.js";

// Admin-managed version overrides.
// If a record exists here for a docType, it OVERRIDES the constant in legalVersions.js.
// This allows admins to bump versions without a code deploy.
const LegalVersionSchema = new mongoose.Schema(
  {
    docType: {
      type: String,
      enum: DOC_TYPES,
      required: true,
      unique: true,
    },
    version: {
      type: String,
      required: true,
    },
    effectiveDate: {
      type: Date,
      default: Date.now,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    changeNote: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

export const LegalVersion = mongoose.model("LegalVersion", LegalVersionSchema);
