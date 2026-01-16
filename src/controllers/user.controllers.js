import { asyncHandler } from "../utlis/asyncHandler.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { v4 as uuidv4 } from "uuid";
import { sendEmail } from "../utlis/sendEmail.js"
import { uploadBufferToBunny } from "../utlis/bunny.js";
import { setCache } from "../middlewares/cache.middleware.js";
import Follower from "../models/follower.models.js";
import Post from "../models/userPost.models.js";
import Reel from "../models/reels.models.js";
import Comment from "../models/comment.models.js";
import Like from "../models/like.models.js";
import Business from "../models/business.models.js";
import Story from "../models/story.models.js";
import mongoose from "mongoose";
import SearchSuggestion from "../models/searchSuggestion.models.js";
import SearchHistory from "../models/searchHistory.models.js";
import Media from "../models/mediaUser.models.js";
import Block from "../models/block.models.js";
import jwt from "jsonwebtoken";
import SavedPost from "../models/savedPost.models.js";
import Feedback from "../models/feedback.models.js";
import BusinessRating from "../models/businessRating.models.js";
import PostInteraction from "../models/postInteraction.models.js";
import Subscription from "../models/subscription.models.js";
import PushSubscription from "../models/pushSubscription.models.js";
import Draft from "../models/draft.models.js";
import Device from "../models/device.models.js";
import Chat from "../models/chat.models.js";
import Message from "../models/message.models.js";
import Activity from "../models/activity.models.js";
import Notification from "../models/notification.models.js";
import Report from "../models/report.models.js";
import Following from "../models/following.models.js";
import FollowRequest from "../models/followRequest.models.js";
import ContactRequest from "../models/contactRequest.models.js";
import {
    generateRealtimeUsernameSuggestions,
    isUsernameAvailable,
    validateUsername
} from "../utlis/usernameSuggestions.js";
import { invalidateBlockedUsersCache } from "../middlewares/blocking.middleware.js";


const generateAcessAndRefreshToken = async (userId) => {
    try {
        const user = await User.findById(userId);
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave: false });

        return { accessToken, refreshToken };
    } catch (error) {
        throw new ApiError(500, "something went wrong while generating tokens");
    }
}

const registerUser = asyncHandler(async (req, res) => {
    const { fullName, username, email, password, confirmPassword, phoneNumber, dateOfBirth, gender } = req.body;

    if (!fullName || !username || !email || !password || !confirmPassword) {
        throw new ApiError(400, "All fields are required");
    }

    if (password !== confirmPassword) {
        throw new ApiError(400, "Password and confirm password do not match");
    }

    const errors = [];

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
        errors.push({ field: "email", message: "Email already in use" });
    }

    const existingUsername = await User.findOne({ username: username.toLowerCase() });
    if (existingUsername) {
        errors.push({ field: "username", message: "Username already in use" });
    }

    if (errors.length > 0) {
        throw new ApiError(409, "User already exists with this username or email", errors);
    }

    // Directly create user (no OTP, no TempUser)
    const user = await User.create({
        uid: uuidv4(),
        fullName,
        fullNameLower: fullName.toLowerCase(),
        username: username.toLowerCase(),
        email,
        password,
        phoneNumber,
        dateOfBirth,
        gender,
        isEmailVerified: true,
    });

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    await user.save({ validateBeforeSave: false });

    const options = {
        httpOnly: true,
        secure: true
    };

    return res
        .status(201)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(201,
                {
                    user,
                    accessToken,
                    refreshToken
                }, "User registered successfully.")
        );
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, username, password } = req.body;

    // User must provide either email OR username, not both
    if (!email && !username) {
        throw new ApiError(400, "Please provide either email or username");
    }

    if (email && username) {
        throw new ApiError(400, "Please provide either email OR username, not both");
    }

    if (!password) {
        throw new ApiError(400, "Password is required");
    }

    // Find user based on provided field
    let user;
    if (email) {
        user = await User.findOne({ email });
    } else {
        user = await User.findOne({ username: username.toLowerCase() });
    }

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid credentials");
    }

    if (!user.isEmailVerified) {
        throw new ApiError(403, "Email is not verified. Please verify your email to login");
    }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const loggedUser = await User.findById(user._id).select("-password -refreshToken");

    const options = {
        httpOnly: true,
        secure: true
    };

    return res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(200, {
            user: loggedUser,
            accessToken,
            refreshToken
        }, "Login successful"));
});


const logOutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                refreshToken: undefined
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(
            new ApiResponse(200, {}, "User logged Out Successfully")
        )
});

const getUserProfile = asyncHandler(async (req, res) => {
    const userId = req.user?._id;

    const user = await User.findById(userId).select(
        "username fullName email phoneNumber address gender dateOfBirth bio profileImageUrl location link followers following posts isBusinessProfile businessProfileId isBlueTickVerified isEmailVerified isPhoneVerified isPhoneNumberHidden isAddressHidden privacy isFullPrivate createdAt"
    );

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    // Count from actual collections instead of using outdated User model arrays
    const followersCount = await Follower.countDocuments({ userId });
    const followingCount = await Follower.countDocuments({ followerId: userId });
    const postsCount = await Post.countDocuments({ userId });

    // Get business profile information if user is a business profile
    let businessInfo = null;
    if (user.isBusinessProfile) {
        businessInfo = await Business.findOne({ userId }).select('postSettings isVerified');
    }

    const userProfile = {
        _id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.isPhoneNumberHidden ? null : user.phoneNumber,
        address: user.isAddressHidden ? null : user.address,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        isBusinessProfile: user.isBusinessProfile,
        businessProfileId: user.businessProfileId,
        isBlueTickVerified: user.isBlueTickVerified,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        isPhoneNumberHidden: user.isPhoneNumberHidden,
        isAddressHidden: user.isAddressHidden,
        privacy: user.privacy,
        isFullPrivate: user.isFullPrivate,
        // Add business-specific fields
        productEnabled: user.isBusinessProfile ? (businessInfo?.postSettings?.allowProductPosts ?? true) : null,
        serviceEnabled: user.isBusinessProfile ? (businessInfo?.postSettings?.allowServicePosts ?? true) : null,
        isVerified: user.isBusinessProfile ? (businessInfo?.isVerified ?? false) : null,
        createdAt: user.createdAt,
        bio: user.bio,
        link: user.link,
        location: user.location,
        profileImageUrl: user.profileImageUrl,
        followersCount,
        followingCount,
        postsCount
    };

    // Cache the response if caching is available
    if (res.locals.cacheKey && res.locals.cacheTTL) {
        await setCache(res.locals.cacheKey, {
            success: true,
            data: userProfile,
            message: "User profile retrieved successfully"
        }, res.locals.cacheTTL);
    }

    return res.status(200).json(
        new ApiResponse(200, userProfile, "User profile retrieved successfully")
    );
});


const updateUserProfile = asyncHandler(async (req, res) => {
    // Access form data from req.body (multer parses it)
    const updates = { ...req.body };

    const disallowedFields = [
        "email",
        "password",
        "refreshToken",
        "isEmailVerified",
        "isPhoneVerified",
        "acccoutStatus",
        "followers",
        "following",
        "posts",
        "uid"
    ];
    for (const field of disallowedFields) {
        if (updates.hasOwnProperty(field)) {
            throw new ApiError(400, `Field '${field}' cannot be updated`);
        }
    }

    if (updates.fullName) {
        updates.fullNameLower = updates.fullName.toLowerCase();
    }

    // Handle profile image upload if file is provided
    if (req.file) {
        const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");

        if (!uploadResult || !uploadResult.secure_url) {
            throw new ApiError(500, "Failed to upload image to Bunny.net");
        }

        updates.profileImageUrl = uploadResult.secure_url;
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        updates,
        {
            new: true,
            runValidators: true,
        })
        .select("-password -refreshToken -emailVerificationToken ");

    // Invalidate auth cache after profile update
    const { invalidateAuthCache } = await import('../middlewares/auth.middleware.js');
    await invalidateAuthCache(req.user._id);

    // Also invalidate user profile cache
    const { UserCacheManager } = await import('../utlis/cache.utils.js');
    await UserCacheManager.invalidateUserProfile(req.user._id);

    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedUser, "User profile updated successfully")
        );
});

const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        throw new ApiError(400, "Current password and new password are required");
    }
    const user = await User.findById(req.user._id);
    const isMatch = await user.isPasswordCorrect(currentPassword);

    if (!isMatch) {
        throw new ApiError(401, "current Password is incorrect");
    }

    user.password = newPassword;
    await user.save();

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {},
                "Password changed Successfully"
            )
        )
});

const deleteAccount = asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
        throw new ApiError(400, "Password is required to delete your account");
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isMatch = await user.isPasswordCorrect(password);

    if (!isMatch) {
        throw new ApiError(401, "Password is incorrect");
    }

    const userId = user._id;

    // --- Delete all user media from Bunny.net and DB ---
    let mediaCleanup = { deleted: 0, failed: 0, errors: [] };
    try {
        const userMedia = await Media.find({ uploadedBy: userId });
        for (const media of userMedia) {
            try {
                // Delete media from Bunny.net using full URL
                const { deleteFromBunny } = await import("../utlis/bunny.js");
                await deleteFromBunny(media.url);
                mediaCleanup.deleted++;
            } catch (err) {
                mediaCleanup.failed++;
                mediaCleanup.errors.push({ mediaId: media._id, error: err.message });
            }
        }
        // Delete all media records for user
        await Media.deleteMany({ uploadedBy: userId });
    } catch (err) {
        mediaCleanup.errors.push({ error: 'Failed to clean up media', details: err.message });
    }
    // --- End media cleanup ---

    // Clean up all user-related data
    const cleanupResults = await Promise.allSettled([
        // Delete all posts by the user
        Post.deleteMany({ userId }),
        // Delete all reels by the user
        Reel.deleteMany({ userId }),
        // Delete all comments by the user
        Comment.deleteMany({ userId }),
        // Delete all likes by the user
        Like.deleteMany({ userId }),
        // Delete business profile if exists
        Business.deleteOne({ userId }),
        // Delete business ratings by the user
        BusinessRating.deleteMany({ userId }),
        // Delete all stories by the user
        Story.deleteMany({ userId }),
        // Delete all drafts by the user
        Draft.deleteMany({ userId }),
        // Delete saved posts by the user
        SavedPost.deleteMany({ userId }),
        // Delete search history
        SearchHistory.deleteMany({ userId }),
        // Delete post interactions
        PostInteraction.deleteMany({ userId }),
        // Delete subscriptions
        Subscription.deleteMany({ userId }),
        Subscription.deleteMany({ subscriberId: userId }),
        // Delete push subscriptions
        PushSubscription.deleteMany({ userId }),
        // Delete devices
        Device.deleteMany({ userId }),
        // Delete chats where user is participant
        Chat.deleteMany({ participants: userId }),
        // Delete messages by the user
        Message.deleteMany({ senderId: userId }),
        // Delete activities
        Activity.deleteMany({ userId }),
        Activity.deleteMany({ targetUserId: userId }),
        // Delete notifications
        Notification.deleteMany({ userId }),
        Notification.deleteMany({ senderId: userId }),
        // Delete reports by the user
        Report.deleteMany({ reporterId: userId }),
        // Delete feedback by the user
        Feedback.deleteMany({ userId }),
        // Delete follow requests
        FollowRequest.deleteMany({ from: userId }),
        FollowRequest.deleteMany({ to: userId }),
        // Delete contact requests
        ContactRequest.deleteMany({ userId }),
        ContactRequest.deleteMany({ contactUserId: userId }),
        // Delete blocking records
        Block.deleteMany({ blockerId: userId }),
        Block.deleteMany({ blockedUserId: userId }),
        // Remove user from followers/following lists
        User.updateMany(
            { followers: userId },
            { $pull: { followers: userId } }
        ),
        User.updateMany(
            { following: userId },
            { $pull: { following: userId } }
        ),
        // Remove user from mentions in posts
        Post.updateMany(
            { mentions: userId },
            { $pull: { mentions: userId } }
        ),
        // Remove likes on user's posts
        Like.deleteMany({ postId: { $in: user.posts || [] } }),
        // Remove comments on user's posts
        Comment.deleteMany({ postId: { $in: user.posts || [] } }),
        // Delete follower/following records
        Follower.deleteMany({ userId }),
        Follower.deleteMany({ followerId: userId }),
        Following.deleteMany({ userId }),
        Following.deleteMany({ followingId: userId })
    ]);

    // Delete the user account directly from the collection
    await User.findByIdAndDelete(userId);

    return res
        .status(200)
        .clearCookie("accessToken")
        .clearCookie("refreshToken")
        .json(
            new ApiResponse(
                200,
                {
                    message: "Account and all associated data deleted successfully",
                    mediaCleanup,
                    cleanupResults: cleanupResults.map((result, index) => ({
                        operation: [
                            "posts", "reels", "comments", "likes", "business", "business_ratings",
                            "stories", "drafts", "products", "cart", "wishlist", "orders",
                            "saved_posts", "search_history", "post_interactions",
                            "subscriptions_user", "subscriptions_subscriber", "push_subscriptions",
                            "payments", "devices", "chats", "messages", "activities_user",
                            "activities_target", "notifications_user", "notifications_sender",
                            "reports", "feedback", "follow_requests_from", "follow_requests_to",
                            "contact_requests_user", "contact_requests_contact", "blocks_blocker",
                            "blocks_blocked", "followers_cleanup", "following_cleanup",
                            "mentions_cleanup", "post_likes_cleanup", "post_comments_cleanup",
                            "follower_records", "follower_records_reverse", "following_records",
                            "following_records_reverse", "cart_products_cleanup", "wishlist_products_cleanup"
                        ][index],
                        status: result.status,
                        ...(result.status === 'rejected' && { error: result.reason?.message })
                    }))
                },
                "Account deleted Successfully"
            )
        )
});

const searchUsers = asyncHandler(async (req, res) => {
    const { query } = req.query;
    const userId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];
    let matchingBusinesses = [];

    if (!query || query.trim() == "") {
        throw new ApiError(400, "Search query is required");
    }



    // Track search keyword if it's 3+ characters
    if (query.trim().length >= 3) {
        const normalizedKeyword = query.trim().toLowerCase();
        try {
            const existingSuggestion = await SearchSuggestion.findOne({
                keyword: normalizedKeyword
            });

            if (existingSuggestion) {
                existingSuggestion.searchCount += 1;
                existingSuggestion.lastSearched = new Date();
                await existingSuggestion.save();
            } else {
                await SearchSuggestion.create({
                    keyword: normalizedKeyword,
                    searchCount: 1,
                    lastSearched: new Date()
                });
            }
        } catch (error) {
            console.log('Error tracking search keyword:', error);
        }
    }

    // Build search query excluding blocked users
    const searchQuery = {
        accountStatus: "active",
        $or: [
            { username: new RegExp(query, "i") },
            { fullName: new RegExp(query, "i") },
            { fullNameLower: new RegExp(query, "i") }
        ]
    };

    // Add blocked users filter if there are any
    if (blockedUsers.length > 0) {
        searchQuery._id = { $nin: blockedUsers };
    }



    let user = await User.find(searchQuery)
        .select("username fullName profileImageUrl bio location isBusinessProfile businessProfileId")
        .populate({
            path: 'businessProfileId',
            select: 'category subcategory businessName businessType'
        });


    // If no users found, try searching without fullNameLower (in case it's not populated)
    if (user.length === 0) {

        const fallbackQuery = {
            accountStatus: "active",
            $or: [
                { username: new RegExp(query, "i") },
                { fullName: new RegExp(query, "i") }
            ]
        };

        if (blockedUsers.length > 0) {
            fallbackQuery._id = { $nin: blockedUsers };
        }

        user = await User.find(fallbackQuery)
            .select("username fullName profileImageUrl bio location isBusinessProfile businessProfileId")
            .populate({
                path: 'businessProfileId',
                select: 'category subcategory businessName businessType'
            });
    }

    // Search through business categories and subcategories (always run in parallel)
    const businessSearchQuery = {
        $or: [
            { category: new RegExp(query, "i") },
            { subcategory: new RegExp(query, "i") },
            { businessName: new RegExp(query, "i") },
            { businessType: new RegExp(query, "i") },
            { tags: new RegExp(query, "i") }
        ],
        userId: { $nin: blockedUsers } // Exclude blocked users at Business level
    };

    // Find businesses matching the query
    matchingBusinesses = await Business.find(businessSearchQuery)
        .populate({
            path: 'userId',
            match: {
                accountStatus: "active"
            },
            select: "username fullName profileImageUrl bio location isBusinessProfile businessProfileId"
        })
        .select('category subcategory businessName businessType tags');



    // Filter out businesses where user population failed (due to blocked users or inactive accounts)
    const validBusinessUsers = matchingBusinesses
        .filter(business => business.userId)
        .map(business => {
            const userObj = business.userId.toObject();
            return {
                ...userObj,
                businessProfileId: {
                    category: business.category,
                    subcategory: business.subcategory,
                    businessName: business.businessName,
                    businessType: business.businessType
                }
            };
        });

    // Combine direct user search results with business search results
    if (validBusinessUsers.length > 0) {
        user = [...user, ...validBusinessUsers];
    }

    // Format the response to include business information
    const formattedUsersMap = new Map();

    const addFormattedUser = (rawUserObj, businessInfo) => {
        if (!rawUserObj || !rawUserObj._id) return;
        const id = rawUserObj._id.toString();
        if (formattedUsersMap.has(id)) return;

        const formatted = {
            _id: rawUserObj._id,
            username: rawUserObj.username,
            fullName: rawUserObj.fullName,
            bio: rawUserObj.bio,
            location: rawUserObj.location,
            profileImageUrl: rawUserObj.profileImageUrl
        };

        if (businessInfo) {
            formatted.businessCategory = businessInfo.category;
            formatted.businessSubcategory = businessInfo.subcategory;
            formatted.businessName = businessInfo.businessName;
            formatted.businessType = businessInfo.businessType;
        } else if (rawUserObj.isBusinessProfile && rawUserObj.businessProfileId) {
            formatted.businessCategory = rawUserObj.businessProfileId.category;
            formatted.businessSubcategory = rawUserObj.businessProfileId.subcategory;
            formatted.businessName = rawUserObj.businessProfileId.businessName;
            formatted.businessType = rawUserObj.businessProfileId.businessType;
        }

        formattedUsersMap.set(id, formatted);
    };

    // Add all users (direct search results and business-matched users) with deduplication
    for (const userDoc of user) {
        const obj = typeof userDoc?.toObject === 'function' ? userDoc.toObject() : userDoc;

        // Check if this user came from business search (has modified businessProfileId)
        if (obj.businessProfileId && obj.businessProfileId.category) {
            // This is from business search, use the business info
            addFormattedUser(obj, obj.businessProfileId);
        } else {
            // This is from direct user search
            addFormattedUser(obj, null);
        }
    }

    const formattedUsers = Array.from(formattedUsersMap.values());



    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                formattedUsers,
                "Users found successfully"
            )
        );
});

const sendVerificationOTPForEmail = asyncHandler(async (req, res) => {

    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "Email is required");
    }

    const user = await User.findOne({ email });

    if (!user) {
        throw new ApiError(404, "User not found with this email");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // valid for 10 minutes

    user.emailOTP = otp;
    user.emailOTPExpiry = expiry;
    await user.save({ validateBeforeSave: false });


    await sendEmail({
        to: user.email,
        subject: "Your OTP for Email Verification - Findernate",
        html: `
            <h3>Email Verification OTP</h3>
            <h2>Your OTP is: <b>${otp}</b></h2>
            <p>This OTP is valid for 10 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>
        `
    });

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "OTP sent to your email successfully"));
});


const verifyEmailWithOTP = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        throw new ApiError(400, "Email and OTP are required");
    }

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, "User not found");

    if (
        user.emailOTP !== otp ||
        !user.emailOTPExpiry ||
        user.emailOTPExpiry < new Date()
    ) {
        throw new ApiError(400, "Invalid or expired OTP");
    }

    user.isEmailVerified = true;
    user.emailOTP = undefined;
    user.emailOTPExpiry = undefined;
    user.emailVerificationToken = undefined;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, "Email verified successfully"));
})

const uploadProfileImage = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new ApiError(400, "Profile Image is required");
    }

    const userId = req.user._id;

    const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");

    if (!uploadResult || !uploadResult.secure_url) {
        throw new ApiError(500, "Failed to upload image to Bunny.net");
    }

    const user = await User.findByIdAndUpdate(userId,
        { profileImageUrl: uploadResult.secure_url },
        { new: true, runValidators: true }
    ).select("username fullName profileImageUrl")

    return res
        .status(200)
        .json(new ApiResponse(200, user, "profile image uploaded successfully"));
});

const sendPasswordResetOTP = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "Email is required");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "User not found with this email");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // valid for 10 minutes

    user.passwordResetOTP = otp;
    user.passwordResetOTPExpiry = expiry;
    await user.save({ validateBeforeSave: false });

    await sendEmail({
        to: user.email,
        subject: "Your OTP for Password Reset - FinderNate",
        html: `
            <h3>Password Reset OTP </h3>
            <h2>Your OTP is: <b>${otp}</b></h2>
            <p>This OTP is valid for 10 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>`
    });
    return res
        .status(200)
        .json(new ApiResponse(200, {}, "OTP sent to your email successfully for password reset"));
});
const resetPasswordWithOTP = asyncHandler(async (req, res) => {
    const { otp, newPassword, confirmPassword } = req.body;
    if (!otp || !newPassword || !confirmPassword) {
        throw new ApiError(400, "OTP, new password and confirm password are required");
    }

    if (newPassword !== confirmPassword) {
        throw new ApiError(400, "New password and confirm password do not match");
    }

    const user = await User.findOne({ passwordResetOTP: otp });

    if (!user) {
        throw new ApiError(404, "No user found with this OTP");
    }

    if (!user.passwordResetOTPExpiry || user.passwordResetOTPExpiry < new Date()) {
        throw new ApiError(400, "OTP has expired");
    }

    user.password = newPassword;
    user.passwordResetOTP = undefined;
    user.passwordResetOTPExpiry = undefined;

    await user.save({ validateBeforeSave: false });

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password reset successfully"));

})

const getOtherUserProfile = asyncHandler(async (req, res) => {
    const { identifier } = req.query;
    const blockedUsers = req.blockedUsers || [];

    if (!identifier) {
        throw new ApiError(400, "User identifier (userId or username) is required");
    }

    let targetUser;

    // Check if identifier is a valid MongoDB ObjectId
    if (mongoose.Types.ObjectId.isValid(identifier)) {
        targetUser = await User.findById(identifier).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    // If not found by ID or not a valid ObjectId, search by username
    if (!targetUser) {
        targetUser = await User.findOne({ username: identifier.toLowerCase() }).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    // Check if there's a blocking relationship between users
    if (blockedUsers.includes(targetUser._id.toString())) {
        throw new ApiError(403, "Cannot access this profile due to blocking");
    }

    // Check if current user follows the target user
    const isFollowing = await Follower.findOne({
        userId: targetUser._id,
        followerId: req.user._id
    });

    // Check if there's a pending follow request
    const pendingRequest = await FollowRequest.findOne({
        requesterId: req.user._id,
        recipientId: targetUser._id,
        status: 'pending'
    });

    // Calculate counts
    const followersCount = await Follower.countDocuments({ userId: targetUser._id });
    const followingCount = await Follower.countDocuments({ followerId: targetUser._id });
    // Count posts directly from Post collection
    const postsCount = await Post.countDocuments({ userId: targetUser._id });

    // Get business ID if user has a business profile
    let businessId = null;
    if (targetUser.isBusinessProfile) {
        const business = await Business.findOne({ userId: targetUser._id });
        if (business) {
            businessId = business._id;
        }
    }

    // Prepare user data with counts (respecting privacy settings)
    const userWithCounts = {
        _id: targetUser._id,
        username: targetUser.username,
        email: targetUser.email,
        fullName: targetUser.fullName,
        phoneNumber: targetUser.isPhoneNumberHidden ? null : (targetUser.phoneNumber || ""),
        address: targetUser.isAddressHidden ? null : (targetUser.address || ""),
        dateOfBirth: targetUser.dateOfBirth || "",
        gender: targetUser.gender || "",
        isBusinessProfile: targetUser.isBusinessProfile,
        businessId: businessId,
        isEmailVerified: targetUser.isEmailVerified,
        isPhoneVerified: targetUser.isPhoneVerified,
        isPhoneNumberHidden: targetUser.isPhoneNumberHidden,
        isAddressHidden: targetUser.isAddressHidden,
        bio: targetUser.bio || "",
        link: targetUser.link || "",
        location: targetUser.location || "",
        profileImageUrl: targetUser.profileImageUrl || "",
        followersCount,
        followingCount,
        postsCount,
        createdAt: targetUser.createdAt
    };

    const responseData = {
        _id: targetUser._id,
        isFollowedBy: !!isFollowing,
        isPending: !!pendingRequest,
        userId: userWithCounts
    };

    return res.status(200).json(
        new ApiResponse(200, responseData, "User profile retrieved successfully")
    );
});

// Check if token is expired
const checkTokenExpiry = asyncHandler(async (req, res) => {
    try {
        let token;

        // Extract token from cookies or Authorization header
        if (req.cookies?.accessToken) {
            token = req.cookies.accessToken;
        } else if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        // If no token is provided
        if (!token) {
            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: true,
                    message: "No token provided"
                }, "Token status checked")
            );
        }

        try {
            // Verify token with JWT
            const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

            // Check if user still exists
            const user = await User.findById(decodedToken?._id).select("-password -refreshToken");

            if (!user) {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: false,
                        message: "User no longer exists"
                    }, "Token status checked")
                );
            }

            // Token is valid and not expired
            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: true,
                    isExpired: false,
                    user: {
                        _id: user._id,
                        username: user.username,
                        fullName: user.fullName
                    },
                    expiresAt: new Date(decodedToken.exp * 1000),
                    message: "Token is valid"
                }, "Token status checked")
            );

        } catch (jwtError) {
            // Check if error is due to token expiration
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: true,
                        expiredAt: new Date(jwtError.expiredAt),
                        message: "Token has expired"
                    }, "Token status checked")
                );
            }

            // Other JWT errors (invalid signature, malformed token, etc.)
            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: false,
                    message: "Invalid token"
                }, "Token status checked")
            );
        }

    } catch (error) {
        throw new ApiError(500, "Error checking token status: " + error.message);
    }
});

// 📱 Toggle Phone Number Visibility
const togglePhoneNumberVisibility = asyncHandler(async (req, res) => {
    const { isHidden } = req.body;

    if (typeof isHidden !== 'boolean') {
        throw new ApiError(400, "isHidden must be a boolean value");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { isPhoneNumberHidden: isHidden },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken");

    if (!updatedUser) {
        throw new ApiError(404, "User not found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                isPhoneNumberHidden: updatedUser.isPhoneNumberHidden,
                phoneNumber: updatedUser.isPhoneNumberHidden ? null : updatedUser.phoneNumber
            },
            `Phone number ${isHidden ? 'hidden' : 'visible'} successfully`
        )
    );
});

// 🏠 Toggle Address Visibility
const toggleAddressVisibility = asyncHandler(async (req, res) => {
    const { isHidden } = req.body;

    if (typeof isHidden !== 'boolean') {
        throw new ApiError(400, "isHidden must be a boolean value");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { isAddressHidden: isHidden },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken");

    if (!updatedUser) {
        throw new ApiError(404, "User not found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                isAddressHidden: updatedUser.isAddressHidden,
                address: updatedUser.isAddressHidden ? null : updatedUser.address
            },
            `Address ${isHidden ? 'hidden' : 'visible'} successfully`
        )
    );
});

// Track search - increment search count or create new entry
const trackSearch = asyncHandler(async (req, res) => {
    const { keyword } = req.body;

    if (!keyword || !keyword.trim()) {
        throw new ApiError(400, "Keyword is required");
    }

    const normalizedKeyword = keyword.trim().toLowerCase();

    try {
        // Check if the keyword already exists in SearchSuggestion
        const existingSuggestion = await SearchSuggestion.findOne({
            keyword: normalizedKeyword
        });

        if (existingSuggestion) {
            // Increment search count and update last searched
            existingSuggestion.searchCount += 1;
            existingSuggestion.lastSearched = new Date();
            await existingSuggestion.save();
        } else {
            // Create new entry
            await SearchSuggestion.create({
                keyword: normalizedKeyword,
                searchCount: 1,
                lastSearched: new Date()
            });
        }

        return res.status(200).json(
            new ApiResponse(200, null, "Search tracked successfully")
        );
    } catch (error) {
        console.error("Error tracking search:", error);
        throw new ApiError(500, "Failed to track search");
    }
});

// Get popular searches sorted by search count
const getPopularSearches = asyncHandler(async (req, res) => {
    const MAX_LIMIT = 50; // Prevent excessive data requests
    const requestedLimit = parseInt(req.query.limit) || 10;
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    try {
        const popularSearches = await SearchSuggestion.find({})
            .sort({ searchCount: -1, lastSearched: -1 })
            .limit(limit)
            .select('keyword searchCount');

        const formattedResults = popularSearches.map(search => ({
            keyword: search.keyword,
            searchCount: search.searchCount
        }));

        return res.status(200).json(
            new ApiResponse(200, formattedResults, "Popular searches retrieved successfully")
        );
    } catch (error) {
        console.error("Error fetching popular searches:", error);
        throw new ApiError(500, "Failed to fetch popular searches");
    }
});

// Block user functionality
const blockUser = asyncHandler(async (req, res) => {
    const { blockedUserId, reason } = req.body;
    const blockerId = req.user._id;

    if (!blockedUserId) {
        throw new ApiError(400, "User ID to block is required");
    }

    if (blockerId.toString() === blockedUserId) {
        throw new ApiError(400, "You cannot block yourself");
    }

    // Check if user to block exists
    const userToBlock = await User.findById(blockedUserId);
    if (!userToBlock) {
        throw new ApiError(404, "User to block not found");
    }

    // Check if already blocked
    const existingBlock = await Block.findOne({
        blockerId,
        blockedId: blockedUserId
    });

    if (existingBlock) {
        throw new ApiError(409, "User is already blocked");
    }

    // Create block record
    const block = await Block.create({
        blockerId,
        blockedId: blockedUserId,
        reason: reason || null
    });

    // Invalidate blocked users cache for both users
    await invalidateBlockedUsersCache(blockerId, blockedUserId);

    // Remove follow relationships if they exist
    await Follower.findOneAndDelete({
        followerId: blockerId,
        followingId: blockedUserId
    });

    await Follower.findOneAndDelete({
        followerId: blockedUserId,
        followingId: blockerId
    });

    return res.status(200).json(
        new ApiResponse(200, { block }, "User blocked successfully")
    );
});

// Unblock user functionality
const unblockUser = asyncHandler(async (req, res) => {
    const { blockedUserId } = req.body;
    const blockerId = req.user._id;

    if (!blockedUserId) {
        throw new ApiError(400, "User ID to unblock is required");
    }

    // Check if block exists
    const existingBlock = await Block.findOne({
        blockerId,
        blockedId: blockedUserId
    });

    if (!existingBlock) {
        throw new ApiError(404, "User is not blocked");
    }

    // Remove block record
    await Block.findByIdAndDelete(existingBlock._id);

    // Invalidate blocked users cache for both users
    await invalidateBlockedUsersCache(blockerId, blockedUserId);

    return res.status(200).json(
        new ApiResponse(200, null, "User unblocked successfully")
    );
});

// Get blocked users list
const getBlockedUsers = asyncHandler(async (req, res) => {
    const blockerId = req.user._id;

    const blockedUsers = await Block.find({ blockerId })
        .populate('blockedId', 'fullName username profileImage')
        .sort({ createdAt: -1 });

    const formattedBlockedUsers = blockedUsers.map(block => ({
        blockedUserId: block.blockedId._id,
        fullName: block.blockedId.fullName,
        username: block.blockedId.username,
        profileImage: block.blockedId.profileImage,
        blockedAt: block.createdAt,
        reason: block.reason
    }));

    return res.status(200).json(
        new ApiResponse(200, { blockedUsers: formattedBlockedUsers }, "Blocked users retrieved successfully")
    );
});

// Check if user is blocked
const checkIfUserBlocked = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const currentUserId = req.user._id;

    if (!userId) {
        throw new ApiError(400, "User ID is required");
    }

    const block = await Block.findOne({
        $or: [
            { blockerId: currentUserId, blockedId: userId },
            { blockerId: userId, blockedId: currentUserId }
        ]
    });

    const isBlocked = !!block;

    return res.status(200).json(
        new ApiResponse(200, { isBlocked }, "Block status checked successfully")
    );
});

// Real-time username suggestions (as user types)
const getUsernameSuggestions = asyncHandler(async (req, res) => {
    const { username } = req.query;

    if (!username) {
        throw new ApiError(400, "Username query parameter is required");
    }

    if (username.length < 3) {
        return res.status(200).json(
            new ApiResponse(200, {
                suggestions: [],
                isAvailable: false,
                message: "Username must be at least 3 characters"
            }, "Username too short")
        );
    }

    try {
        const result = await generateRealtimeUsernameSuggestions(username, 8);

        return res.status(200).json(
            new ApiResponse(200, result, "Username suggestions generated successfully")
        );
    } catch (error) {
        console.error('Error generating username suggestions:', error);
        throw new ApiError(500, "Failed to generate username suggestions");
    }
});

// Check username availability
const checkUsernameAvailability = asyncHandler(async (req, res) => {
    const { username } = req.query;

    if (!username) {
        throw new ApiError(400, "Username query parameter is required");
    }

    // Validate username format
    const validation = validateUsername(username);
    if (!validation.isValid) {
        return res.status(200).json(
            new ApiResponse(200, {
                isAvailable: false,
                isValid: false,
                errors: validation.errors
            }, "Username validation failed")
        );
    }

    try {
        const isAvailable = await isUsernameAvailable(username);

        return res.status(200).json(
            new ApiResponse(200, {
                isAvailable,
                isValid: true,
                username: username.toLowerCase()
            }, isAvailable ? "Username is available" : "Username is already taken")
        );
    } catch (error) {
        console.error('Error checking username availability:', error);
        throw new ApiError(500, "Failed to check username availability");
    }
});


// Toggle Account Privacy Mode (like Instagram)
const toggleFullPrivateAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    try {
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        // Toggle privacy: private <-> public
        const newPrivacyState = user.privacy === "private" ? "public" : "private";
        const newFullPrivateState = newPrivacyState === "private";

        user.privacy = newPrivacyState;
        user.isFullPrivate = newFullPrivateState;

        // Update ALL posts to match account privacy (like Instagram)
        await Post.updateMany(
            { userId: userId },
            { $set: { "settings.privacy": newPrivacyState } }
        );

        // Also update Reels privacy
        await Reel.updateMany(
            { userId: userId },
            { $set: { "settings.privacy": newPrivacyState } }
        );

        // Also update Stories privacy
        await Story.updateMany(
            { userId: userId },
            { $set: { "settings.privacy": newPrivacyState } }
        );

        await user.save();

        // Invalidate auth cache after privacy update
        const { invalidateAuthCache } = await import('../middlewares/auth.middleware.js');
        await invalidateAuthCache(userId);

        // Also invalidate user profile cache and feeds
        const { UserCacheManager, FeedCacheManager } = await import('../utlis/cache.utils.js');
        await UserCacheManager.invalidateUserProfile(userId);
        await FeedCacheManager.invalidateUserFeed(userId);

        // Invalidate viewable users cache for this user AND all other users
        const { invalidateViewableUsersCache } = await import('../middlewares/privacy.middleware.js');
        await invalidateViewableUsersCache(userId);

        // When going from private to public, invalidate all users' feeds
        // so they can see this user's newly public posts
        if (newPrivacyState === 'public') {
            // Invalidate explore and trending feeds
            await FeedCacheManager.invalidateExploreFeed();
            await FeedCacheManager.invalidateTrendingFeed();
        }

        return res.status(200).json(
            new ApiResponse(200, {
                privacy: user.privacy,
                isPrivate: user.privacy === "private",
                isFullPrivate: user.isFullPrivate,
                message: newFullPrivateState
                    ? "Account is now private - all content is private"
                    : "Account is now public - all content is public"
            }, `Account privacy ${newFullPrivateState ? 'enabled' : 'disabled'}`)
        );
    } catch (error) {
        throw new ApiError(500, "Error toggling account privacy", [error.message]);
    }
});

// Toggle service post auto-fill preference
const toggleServiceAutoFill = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    // Toggle the auto-fill preference
    const currentSetting = user.servicePostPreferences?.enableAutoFill ?? true;
    user.servicePostPreferences = {
        enableAutoFill: !currentSetting
    };

    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
        new ApiResponse(200, {
            enableAutoFill: user.servicePostPreferences.enableAutoFill
        }, "Service auto-fill preference updated successfully")
    );
});

// Get previous service post data for auto-fill
const getPreviousServicePostData = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    // Check if auto-fill is enabled for this user
    const user = await User.findById(userId).select('servicePostPreferences');
    const autoFillEnabled = user?.servicePostPreferences?.enableAutoFill ?? true;

    if (!autoFillEnabled) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: false, data: null }, "Auto-fill is disabled")
        );
    }

    // Find the most recent service post by this user
    const latestServicePost = await Post.findOne({
        userId,
        contentType: "service"
    })
        .sort({ createdAt: -1 })
        .select('customization.service')
        .lean();

    if (!latestServicePost || !latestServicePost.customization?.service) {
        return res.status(200).json(
            new ApiResponse(200, {
                autoFillEnabled: true,
                data: null
            }, "No previous service post found")
        );
    }

    // Extract relevant fields for auto-fill
    const serviceData = latestServicePost.customization.service;
    const autoFillData = {
        serviceName: serviceData.serviceName || "",
        currency: serviceData.currency || "INR",
        description: serviceData.description || "",
        price: serviceData.price || null,
        location: serviceData.location || null
    };

    return res.status(200).json(
        new ApiResponse(200, {
            autoFillEnabled: true,
            data: autoFillData
        }, "Previous service post data retrieved successfully")
    );
});

// Toggle product post auto-fill preference
const toggleProductAutoFill = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    // Toggle the auto-fill preference
    const currentSetting = user.productPostPreferences?.enableAutoFill ?? true;
    user.productPostPreferences = {
        enableAutoFill: !currentSetting
    };

    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
        new ApiResponse(200, {
            enableAutoFill: user.productPostPreferences.enableAutoFill
        }, "Product auto-fill preference updated successfully")
    );
});

// Get previous product post data for auto-fill
const getPreviousProductPostData = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    // Check if auto-fill is enabled for this user
    const user = await User.findById(userId).select('productPostPreferences');
    const autoFillEnabled = user?.productPostPreferences?.enableAutoFill ?? true;

    if (!autoFillEnabled) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: false, data: null }, "Auto-fill is disabled")
        );
    }

    // Find the most recent product post by this user
    const latestProductPost = await Post.findOne({
        userId,
        contentType: "product"
    })
        .sort({ createdAt: -1 })
        .select('customization.product')
        .lean();

    if (!latestProductPost || !latestProductPost.customization?.product) {
        return res.status(200).json(
            new ApiResponse(200, {
                autoFillEnabled: true,
                data: null
            }, "No previous product post found")
        );
    }

    // Extract relevant fields for auto-fill
    const productData = latestProductPost.customization.product;
    const autoFillData = {
        productName: productData.name || "",
        currency: productData.currency || "INR",
        description: productData.description || "",
        price: productData.price || null,
        brand: productData.brand || "",
        category: productData.category || "",
        subcategory: productData.subcategory || "",
        location: productData.location || null
    };

    return res.status(200).json(
        new ApiResponse(200, {
            autoFillEnabled: true,
            data: autoFillData
        }, "Previous product post data retrieved successfully")
    );
});

/**
 * Save FCM Token for push notifications
 * @route POST /api/v1/users/fcm-token
 * Note: Uses optionalVerifyJWT middleware - saves token if authenticated, returns message if not
 */
const saveFCMToken = asyncHandler(async (req, res) => {
    const { fcmToken } = req.body;
    const userId = req.user?._id;

    if (!fcmToken) {
        throw new ApiError(400, "FCM token is required");
    }

    // If user is not authenticated, return a message (not an error)
    // This allows the frontend to retry after login
    if (!userId) {
        return res.status(200).json(
            new ApiResponse(200, {
                saved: false,
                reason: "not_authenticated"
            }, "User not authenticated. FCM token will be saved after login.")
        );
    }

    // Update user's FCM token
    const user = await User.findByIdAndUpdate(
        userId,
        {
            fcmToken,
            fcmTokenUpdatedAt: new Date()
        },
        { new: true }
    ).select('fcmToken fcmTokenUpdatedAt');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            saved: true,
            fcmToken: user.fcmToken,
            updatedAt: user.fcmTokenUpdatedAt
        }, "FCM token saved successfully")
    );
});

/**
 * Check Firebase configuration status
 * @route GET /api/v1/users/firebase-status
 */
const checkFirebaseStatus = asyncHandler(async (req, res) => {
    const status = {
        envVarsPresent: {
            FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
            FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
            FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY
        },
        envVarsValues: {
            FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'NOT SET',
            FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || 'NOT SET',
            FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ?
                `${process.env.FIREBASE_PRIVATE_KEY.substring(0, 50)}... (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` :
                'NOT SET'
        }
    };

    return res.status(200).json(
        new ApiResponse(200, status, "Firebase configuration status")
    );
});

/**
 * Test FCM notification sending
 * @route POST /api/v1/users/test-fcm
 */
const testFCMNotification = asyncHandler(async (req, res) => {
    const userId = req.user?._id;

    if (!userId) {
        throw new ApiError(401, "User not authenticated");
    }

    // Get user's FCM token
    const user = await User.findById(userId).select('fcmToken username fullName');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.fcmToken) {
        throw new ApiError(400, "No FCM token found for this user. Please refresh the app.");
    }

    // Try to send a test notification
    try {
        const { sendNotification } = await import('../config/firebase-admin.config.js');

        const notification = {
            title: "Test Notification",
            body: "This is a test FCM notification from FinderNate backend"
        };

        const data = {
            type: 'test',
            timestamp: new Date().toISOString()
        };

        console.log('🧪 Sending test FCM notification to:', user.username);
        console.log('📱 FCM Token:', user.fcmToken.substring(0, 20) + '...');

        const result = await sendNotification(user.fcmToken, notification, data);

        if (result.success) {
            console.log('✅ Test FCM sent successfully:', result.messageId);
            return res.status(200).json(
                new ApiResponse(200, {
                    success: true,
                    messageId: result.messageId,
                    fcmToken: user.fcmToken.substring(0, 20) + '...'
                }, "Test FCM notification sent successfully")
            );
        } else {
            console.error('❌ Test FCM failed:', result.error);
            return res.status(500).json(
                new ApiResponse(500, {
                    success: false,
                    error: result.error,
                    invalidToken: result.invalidToken
                }, "Failed to send test FCM notification")
            );
        }
    } catch (error) {
        console.error('❌ FCM test error:', error);
        throw new ApiError(500, `FCM test failed: ${error.message}`);
    }
});

export {
    registerUser,
    loginUser,
    logOutUser,
    getUserProfile,
    updateUserProfile,
    changePassword,
    deleteAccount,
    searchUsers,
    verifyEmailWithOTP,
    sendVerificationOTPForEmail,
    uploadProfileImage,
    sendPasswordResetOTP,
    resetPasswordWithOTP,
    getOtherUserProfile,
    checkTokenExpiry,
    togglePhoneNumberVisibility,
    toggleAddressVisibility,
    trackSearch,
    getPopularSearches,
    blockUser,
    unblockUser,
    getBlockedUsers,
    checkIfUserBlocked,
    getUsernameSuggestions,
    checkUsernameAvailability,
    toggleFullPrivateAccount,
    toggleServiceAutoFill,
    getPreviousServicePostData,
    toggleProductAutoFill,
    getPreviousProductPostData,
    saveFCMToken,
    testFCMNotification,
    checkFirebaseStatus
};
