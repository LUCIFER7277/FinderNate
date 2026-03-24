import mongoose from "mongoose";
import bcrypt from "bcrypt";

const AuthOtpSchema = new mongoose.Schema(
    {
        identifier: {
            type: String,
            required: true,
            index: true,
            // email address or phone number
        },
        type: {
            type: String,
            enum: ["email", "phone"],
            required: true,
        },
        purpose: {
            type: String,
            enum: ["registration", "email_verification", "password_reset", "phone_verification"],
            required: true,
        },
        otp: {
            type: String,
            required: true, // bcrypt-hashed before storage
        },
        expiry: {
            type: Date,
            required: true,
            // TTL index: MongoDB auto-deletes the document once expiry time passes
            index: { expireAfterSeconds: 0 },
        },
        // Rate-limiting: how many OTPs have been sent in the current window
        sendCount: { type: Number, default: 1 },
        windowStart: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Compound index for fast lookups by identifier + type + purpose
AuthOtpSchema.index({ identifier: 1, type: 1, purpose: 1 });

// Hash a plain OTP and return the hash
AuthOtpSchema.statics.hashOtp = async function (plainOtp) {
    return bcrypt.hash(plainOtp, 10);
};

// Verify a plain OTP against the stored hash
AuthOtpSchema.methods.verifyOtp = async function (plainOtp) {
    return bcrypt.compare(plainOtp, this.otp);
};

export const AuthOtp = mongoose.model("AuthOtp", AuthOtpSchema);
