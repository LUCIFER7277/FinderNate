import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { uploadBufferToBunny } from "../../utils/bunny.js";
import mongoose from "mongoose";
import Business from "../../models/business.models.js";
import Post from "../../models/userPost.models.js";
import FollowRequest from "../../models/followRequest.models.js";
import Reel from "../../models/reels.models.js";
import Comment from "../../models/comment.models.js";
import Like from "../../models/like.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import Story from "../../models/story.models.js";
import Draft from "../../models/draft.models.js";
import SavedPost from "../../models/savedPost.models.js";
import SearchHistory from "../../models/searchHistory.models.js";
import PostInteraction from "../../models/postInteraction.models.js";
import Subscription from "../../models/subscription.models.js";
import PushSubscription from "../../models/pushSubscription.models.js";
import Device from "../../models/device.models.js";
import Chat from "../../models/chat.models.js";
import Message from "../../models/message.models.js";
import Activity from "../../models/activity.models.js";
import Notification from "../../models/notification.models.js";
import Report from "../../models/report.models.js";
import Feedback from "../../models/feedback.models.js";
import ContactRequest from "../../models/contactRequest.models.js";
import Block from "../../models/block.models.js";
import Follower from "../../models/follower.models.js";
import Following from "../../models/following.models.js";
import Media from "../../models/mediaUser.models.js";
import { validateUsername } from "../../utils/usernameSuggestions.js";
import { getFollowStatus } from "../../utils/followEngagement.utils.js";
import { assertValidPassword } from "./_helpers.js";

const getUserProfile = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    const userIdStr = userId.toString();

    const { RedisKeys, RedisTTL } = await import('../../config/redis.config.js');
    const { CacheManager } = await import('../../utils/cache.utils.js');
    const { getFollowersCount, getFollowingCount } = await import('../../utils/followEngagement.utils.js');

    const profileCacheKey = RedisKeys.userProfile(userIdStr);
    const cachedProfile = await CacheManager.get(profileCacheKey);

    const [followersCount, followingCount, postsCount] = await Promise.all([
        getFollowersCount(userIdStr),
        getFollowingCount(userIdStr),
        Post.countDocuments({ userId }),
    ]);

    if (cachedProfile) {
        return res.status(200).json(
            new ApiResponse(200, {
                ...cachedProfile,
                followersCount,
                followingCount,
                postsCount,
            }, "User profile retrieved successfully")
        );
    }

    const user = await User.findById(userId).select(
        "username fullName email phoneNumber address gender dateOfBirth bio profileImageUrl location link followers following posts isBusinessProfile businessProfileId isBlueTickVerified isEmailVerified isPhoneVerified isPhoneNumberHidden isAddressHidden privacy isFullPrivate createdAt"
    );

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    let businessInfo = null;
    let isContentVisible = true;
    if (user.isBusinessProfile) {
        businessInfo = await Business.findOne({ userId }).select('postSettings isVerified subscriptionStatus plan');
        if (businessInfo) {
            isContentVisible = businessInfo.subscriptionStatus === 'active' && businessInfo.plan !== 'plan1';
        }
    }

    const subscriptionBadge = await user.getSubscriptionBadge();

    const profileSnapshot = {
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
        productEnabled: user.isBusinessProfile ? (businessInfo?.postSettings?.allowProductPosts ?? true) : null,
        serviceEnabled: user.isBusinessProfile ? (businessInfo?.postSettings?.allowServicePosts ?? true) : null,
        isVerified: user.isBusinessProfile ? (businessInfo?.isVerified ?? false) : null,
        isContentVisible: user.isBusinessProfile ? isContentVisible : true,
        contentVisibilityMessage: user.isBusinessProfile && !isContentVisible
            ? 'Content is currently hidden. Activate your payment plan to make posts visible.'
            : null,
        subscriptionBadge,
        createdAt: user.createdAt,
        bio: user.bio,
        link: user.link,
        location: user.location,
        profileImageUrl: user.profileImageUrl,
    };

    await CacheManager.set(profileCacheKey, profileSnapshot, RedisTTL.USER_PROFILE);

    return res.status(200).json(
        new ApiResponse(200, {
            ...profileSnapshot,
            followersCount,
            followingCount,
            postsCount,
        }, "User profile retrieved successfully")
    );
});

const updateUserProfile = asyncHandler(async (req, res) => {
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

    if (updates.username !== undefined) {
        const cleaned = updates.username.trim().toLowerCase();
        const { isValid, errors } = validateUsername(cleaned);
        if (!isValid) {
            throw new ApiError(400, errors[0], errors.map(e => ({ field: "username", message: e })));
        }
        const taken = await User.findOne({ username: cleaned, _id: { $ne: req.user._id } }).select("_id");
        if (taken) {
            throw new ApiError(409, "Username is already taken", [{ field: "username", message: "Username is already taken" }]);
        }
        updates.username = cleaned;
    }

    if (req.file) {
        const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");
        if (!uploadResult || !uploadResult.secure_url) {
            throw new ApiError(500, "Failed to upload image to Bunny.net");
        }
        updates.profileImageUrl = uploadResult.secure_url;
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken ");

    const { invalidateAuthCache } = await import('../../middlewares/auth.middleware.js');
    await invalidateAuthCache(req.user._id);

    const { UserCacheManager } = await import('../../utils/cache.utils.js');
    await UserCacheManager.invalidateUserProfile(req.user._id);

    if (updates.username || updates.profileImageUrl || updates.fullName) {
        const { updateUserInLikedByHashes } = await import('../../utils/postEngagement.utils.js');
        updateUserInLikedByHashes(req.user._id, {
            username: updatedUser.username,
            fullName: updatedUser.fullName,
            profileImageUrl: updatedUser.profileImageUrl,
        }).catch(() => {});
    }

    return res
        .status(200)
        .json(new ApiResponse(200, updatedUser, "User profile updated successfully"));
});

const uploadProfileImage = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new ApiError(400, "Profile Image is required");
    }

    const userId = req.user._id;
    const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");

    if (!uploadResult || !uploadResult.secure_url) {
        throw new ApiError(500, "Failed to upload image to Bunny.net");
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { profileImageUrl: uploadResult.secure_url },
        { new: true, runValidators: true }
    ).select("username fullName profileImageUrl");

    return res
        .status(200)
        .json(new ApiResponse(200, user, "profile image uploaded successfully"));
});

const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        throw new ApiError(400, "Current password and new password are required");
    }

    //* save() below DOES run validators, but minlength alone would allow a
    //* 200-character password; this applies the same 8-20 policy as signup
    //* and reset so the rule lives in one place.
    assertValidPassword(newPassword);

    const user = await User.findById(req.user._id);
    const isMatch = await user.isPasswordCorrect(currentPassword);

    if (!isMatch) {
        throw new ApiError(401, "current Password is incorrect");
    }

    user.password = newPassword;
    await user.save();

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password changed Successfully"));
});

const getOtherUserProfile = asyncHandler(async (req, res) => {
    const { identifier } = req.query;
    const blockedUsers = req.blockedUsers || [];

    if (!identifier) {
        throw new ApiError(400, "User identifier (userId or username) is required");
    }

    let targetUser;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
        targetUser = await User.findById(identifier).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    if (!targetUser) {
        targetUser = await User.findOne({ username: identifier.toLowerCase() }).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    if (blockedUsers.includes(targetUser._id.toString())) {
        throw new ApiError(403, "Cannot access this profile due to blocking");
    }

    const isFollowing = await getFollowStatus(req.user._id, targetUser._id);

    const pendingRequest = await FollowRequest.findOne({
        requesterId: req.user._id,
        recipientId: targetUser._id,
        status: 'pending'
    });

    const { getFollowersCount, getFollowingCount } = await import('../../utils/followEngagement.utils.js');
    const targetIdStr = targetUser._id.toString();
    const [followersCount, followingCount, postsCount] = await Promise.all([
        getFollowersCount(targetIdStr),
        getFollowingCount(targetIdStr),
        Post.countDocuments({ userId: targetUser._id }),
    ]);

    let businessId = null;
    let isContentVisible = true;
    if (targetUser.isBusinessProfile) {
        const business = await Business.findOne({ userId: targetUser._id }).select('postSettings isVerified subscriptionStatus plan');
        if (business) {
            businessId = business._id;
            isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';
        }
    }

    const subscriptionBadge = await targetUser.getSubscriptionBadge();

    const userWithCounts = {
        _id: targetUser._id,
        username: targetUser.username,
        fullName: targetUser.fullName,
        phoneNumber: targetUser.isPhoneNumberHidden ? null : (targetUser.phoneNumber || ""),
        address: targetUser.isAddressHidden ? null : (targetUser.address || ""),
        dateOfBirth: targetUser.dateOfBirth || "",
        gender: targetUser.gender || "",
        isBusinessProfile: targetUser.isBusinessProfile,
        businessId: businessId,
        isEmailVerified: targetUser.isEmailVerified,
        isPhoneVerified: targetUser.isPhoneVerified,
        isContentVisible: targetUser.isBusinessProfile ? isContentVisible : true,
        contentVisibilityMessage: targetUser.isBusinessProfile && !isContentVisible
            ? 'Content is currently hidden. Activate your payment plan to make posts visible.'
            : null,
        subscriptionBadge: subscriptionBadge,
        bio: targetUser.bio || "",
        link: targetUser.link || "",
        location: targetUser.location || "",
        profileImageUrl: targetUser.profileImageUrl || "",
        followersCount,
        followingCount,
        postsCount,
        isPrivate: targetUser.privacy === 'private',
        createdAt: targetUser.createdAt
    };

    const responseData = {
        _id: targetUser._id,
        isFollowedBy: isFollowing,
        isPending: !!pendingRequest,
        userId: userWithCounts
    };

    return res.status(200).json(
        new ApiResponse(200, responseData, "User profile retrieved successfully")
    );
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

    let mediaCleanup = { deleted: 0, failed: 0, errors: [] };
    try {
        const userMedia = await Media.find({ uploadedBy: userId });
        for (const media of userMedia) {
            try {
                const { deleteFromBunny } = await import("../../utils/bunny.js");
                await deleteFromBunny(media.url);
                mediaCleanup.deleted++;
            } catch (err) {
                mediaCleanup.failed++;
                mediaCleanup.errors.push({ mediaId: media._id, error: err.message });
            }
        }
        await Media.deleteMany({ uploadedBy: userId });
    } catch (err) {
        mediaCleanup.errors.push({ error: 'Failed to clean up media', details: err.message });
    }

    const cleanupResults = await Promise.allSettled([
        Post.deleteMany({ userId }),
        Reel.deleteMany({ userId }),
        Comment.deleteMany({ userId }),
        Like.deleteMany({ userId }),
        Business.deleteOne({ userId }),
        BusinessRating.deleteMany({ userId }),
        Story.deleteMany({ userId }),
        Draft.deleteMany({ userId }),
        SavedPost.deleteMany({ userId }),
        SearchHistory.deleteMany({ userId }),
        PostInteraction.deleteMany({ userId }),
        Subscription.deleteMany({ userId }),
        Subscription.deleteMany({ subscriberId: userId }),
        PushSubscription.deleteMany({ userId }),
        Device.deleteMany({ userId }),
        Chat.deleteMany({ participants: userId }),
        Message.deleteMany({ senderId: userId }),
        Activity.deleteMany({ userId }),
        Activity.deleteMany({ targetUserId: userId }),
        Notification.deleteMany({ userId }),
        Notification.deleteMany({ senderId: userId }),
        Report.deleteMany({ reporterId: userId }),
        Feedback.deleteMany({ userId }),
        FollowRequest.deleteMany({ from: userId }),
        FollowRequest.deleteMany({ to: userId }),
        ContactRequest.deleteMany({ userId }),
        ContactRequest.deleteMany({ contactUserId: userId }),
        Block.deleteMany({ blockerId: userId }),
        Block.deleteMany({ blockedUserId: userId }),
        User.updateMany({ followers: userId }, { $pull: { followers: userId } }),
        User.updateMany({ following: userId }, { $pull: { following: userId } }),
        Post.updateMany({ mentions: userId }, { $pull: { mentions: userId } }),
        Like.deleteMany({ postId: { $in: user.posts || [] } }),
        Comment.deleteMany({ postId: { $in: user.posts || [] } }),
        Follower.deleteMany({ userId }),
        Follower.deleteMany({ followerId: userId }),
        Following.deleteMany({ userId }),
        Following.deleteMany({ followingId: userId })
    ]);

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
        );
});

export {
    getUserProfile,
    updateUserProfile,
    uploadProfileImage,
    changePassword,
    getOtherUserProfile,
    deleteAccount,
};
