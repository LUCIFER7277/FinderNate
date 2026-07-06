import mongoose from "mongoose";
import { DOC_TYPES } from "../constants/legalVersions.js";

const AcceptanceLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    docType: {
      type: String,
      enum: DOC_TYPES,
      required: true,
    },
    version: {
      type: String,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: Date.now,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
  },
  { timestamps: false }
);

// Compound index for efficient lookups
AcceptanceLogSchema.index({ userId: 1, docType: 1, version: 1 });

export const AcceptanceLog = mongoose.model("AcceptanceLog", AcceptanceLogSchema);
