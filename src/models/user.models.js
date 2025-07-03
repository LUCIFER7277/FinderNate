
import mongoose, { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const SavedPostSchema = new Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    savedAt: { type: Date, default: Date.now }
});

const UserSchema = new Schema({
    uid: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: true,
        unique: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    fullName: {
        type: String,
        required: true
    },
    fullNameLower: {
        type: String,
        required: true
    },
    phoneNumber: String,
    dateOfBirth: String,
    gender: {
        type: String,
        enum: ['male', 'female', 'other']
    },
    bio: {
        type: String,
        default: ''
    },
    profileImageUrl: {
        type: String,
        default: ''
    },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    posts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
    unReadChats: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Chat' }],
    postsSaved: [SavedPostSchema],

    isBusinessProfile: {
        type: Boolean,
        default: false
    },
    isBusinessDetails: {
        type: Boolean,
        default: false
    },
    businessDetails: {
        businessName: String,
        businessCategory: String,
        businessEmail: String,
        businessPhone: String,
        businessWebsite: String,
        businessAddress: String,
        gstNumber: String,
        panNumber: String,
        businessLogoUrl: String
    },

}, { timestamps: true });

// 🔐 Password Hashing Middleware
UserSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// ✅ Method to Compare Password
UserSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// ✅ Generate Access Token
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

// ✅ Generate Refresh Token
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

// ✅ Export Model
export const User = mongoose.model("User", UserSchema);
