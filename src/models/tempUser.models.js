import mongoose from "mongoose";

const TempUserSchema = new mongoose.Schema({
    fullName: String,
    fullNameLower: String,
    username: String,
    email: String,
    password: String,
    phoneNumber: String,
    dateOfBirth: String,
    gender: String,
    emailOTP: String,
    emailOTPExpiry: Date
    }, { timestamps: true });

/**
 * Abandoned signups expire.
 *
 * A row is written when someone submits the signup form, and deleted when they
 * verify the OTP. Anyone who closed the app at the OTP screen left their name,
 * email, phone number and password hash sitting here permanently — there was
 * no TTL and nothing else swept the collection. That is personal data retained
 * for a registration that never happened, and it accumulates for every
 * abandoned attempt.
 *
 * 24 hours is generous next to the OTP itself, which expires in minutes, so a
 * genuine "come back and finish tomorrow" still resolves to a fresh OTP rather
 * than a lost session.
 *
 * MongoDB removes expired documents on a background sweep that runs about once
 * a minute, so deletion is prompt but not instantaneous.
 */
TempUserSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const TempUser = mongoose.model("TempUser", TempUserSchema);