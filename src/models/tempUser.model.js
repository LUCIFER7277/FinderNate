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

export const TempUser = mongoose.model("TempUser", TempUserSchema); 