import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const UserSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 8 },
    fullName: { type: String, required: true },
    fullNameLower: { type: String, index: true },
    phoneNumber: String,
    dateOfBirth: String,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    bio: String,
    profileImageUrl: String,
    location: String,
    address: String,
    // Privacy settings
    isPhoneNumberHidden: { type: Boolean, default: false },
    isAddressHidden: { type: Boolean, default: false },
    privacy: { type: String, enum: ['private', 'public'], default: 'public' },
    isFullPrivate: { type: Boolean, default: false },
    // Messaging privacy settings
    messagingPrivacy: {
        onlineStatus: {
            type: String,
            enum: ['everyone', 'followers', 'nobody'],
            default: 'everyone'
        },
        lastSeen: {
            type: String,
            enum: ['everyone', 'followers', 'nobody'],
            default: 'everyone'
        }
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    link: String,
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    posts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
    isBusinessProfile: { type: Boolean, default: false },
    businessProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    isBlueTickVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String },
    emailOTPExpiry: { type: Date },
    emailOTP: { type: String },
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
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    adminActionReason: { type: String, default: null },
    // Service post preferences
    servicePostPreferences: {
        enableAutoFill: { type: Boolean, default: true }
    },
    // Product post preferences
    productPostPreferences: {
        enableAutoFill: { type: Boolean, default: true }
    },
    // FCM Token for push notifications
    fcmToken: {
        type: String,
        default: null
    },
    fcmTokenUpdatedAt: {
        type: Date,
        default: null
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

// 📞 Check if user has calling features access
UserSchema.methods.hasCallingAccess = async function () {
    const Subscription = mongoose.model('Subscription');

    // Business profiles always have calling access
    if (this.isBusinessProfile) {
        return true;
    }

    // Check if user has an active paid subscription
    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    // Free users don't have calling access
    if (!subscription || subscription.plan === 'free') {
        return false;
    }

    // All paid plans (basic, pro, premium, business) have calling access
    return true;
};

// 📋 Get user subscription tier
UserSchema.methods.getSubscriptionTier = async function () {
    const Subscription = mongoose.model('Subscription');

    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    return subscription ? subscription.plan : 'free';
};

// 🏅 Get user subscription badge
UserSchema.methods.getSubscriptionBadge = async function () {
    const Subscription = mongoose.model('Subscription');

    // Check active subscription first
    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    if (!subscription || subscription.plan === 'free') {
        return null; // No badge for free users
    }

    // Return badge based on subscription plan
    const badgeMap = {
        small_business: {
            type: 'small_business',
            label: 'Small Business',
            color: '#22C55E', // green tick
            isPaid: true
        },
        corporate: {
            type: 'corporate',
            label: 'Corporate',
            color: '#3B82F6', // blue tick
            isPaid: true
        }
    };

    return badgeMap[subscription.plan] || null;
};


export const User = mongoose.model("User", UserSchema);
