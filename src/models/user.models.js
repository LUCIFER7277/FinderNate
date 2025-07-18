import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const UserSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength:8 },
    fullName: { type: String, required: true },
    fullNameLower: { type: String, index: true },
    phoneNumber: String,
    dateOfBirth: String,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    bio: String,
    profileImageUrl: String,
    location: String,
    link: String,
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    posts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
    isBusinessProfile: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String },
    emailOTPExpiry: {type: Date},
    emailOTP: {type: String},
    passwordResetOTP: String,
    passwordResetOTPExpiry: Date,

    isPhoneVerified: { type: Boolean, default: false },
    phoneVerificationCode: { type: String },
    phoneVerificationExpiry: { type: Date },
    refreshToken: { type: String, select: false },
    accountStatus: {
        type: String,
        enum: ['active', 'deactivated', 'banned'],
        default: 'active'
    }
}, { timestamps: true });

// 🔐 Hash password before saving
UserSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    this.password = await bcrypt.hash(this.password, 10);

    if (this.isModified("fullName")) {
        this.fullNameLower = this.fullName.toLowerCase();
    }
    next();
}
);



// 🔐 Compare password
UserSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// 🔐 Access Token
UserSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            username: this.username,
            fullName: this.fullName
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY
        }
    );
};

// 🔐 Refresh Token
UserSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        {
            _id: this._id
        },
        process.env.REFRESH_TOKEN_SECRET,
        {
            expiresIn: process.env.REFRESH_TOKEN_EXPIRY
        }
    );
};


export const User = mongoose.model("User", UserSchema);
