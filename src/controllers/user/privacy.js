import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import Reel from "../../models/reels.models.js";
import Story from "../../models/story.models.js";

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

const toggleFullPrivateAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    try {
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        const newPrivacyState = user.privacy === "private" ? "public" : "private";
        const newFullPrivateState = newPrivacyState === "private";

        user.privacy = newPrivacyState;
        user.isFullPrivate = newFullPrivateState;

        // Account privacy is NOT stamped onto individual posts.
        //
        // This used to write settings.privacy onto every Post, Reel and Story
        // the user owned, which broke private accounts in both directions:
        //
        //  - Going private marked every post "private", and the feeds exclude
        //    private posts from EVERYONE with `'settings.privacy': {$ne:
        //    'private'}`. So a private account's followers — the people who are
        //    supposed to see it — saw nothing. "Nobody can see it."
        //
        //  - Going public again reset every post to "public", silently undoing
        //    any post the user had deliberately made private one at a time.
        //
        // The two settings mean different things and are enforced in different
        // places. Account privacy is decided by getViewableUserIds, which
        // already resolves to "followers + own + all public accounts" for a
        // signed-in viewer and "public accounts only" for an anonymous one.
        // settings.privacy stays what it says on the tin: this one post is
        // private, whatever the account is.
        await user.save();

        const { invalidateAuthCache } = await import('../../middlewares/auth.middleware.js');
        await invalidateAuthCache(userId);

        const { UserCacheManager, FeedCacheManager } = await import('../../utils/cache.utils.js');
        await UserCacheManager.invalidateUserProfile(userId);
        await FeedCacheManager.invalidateUserFeed(userId);

        const { invalidateViewableUsersCache } = await import('../../middlewares/privacy.middleware.js');
        await invalidateViewableUsersCache(userId);

        if (newPrivacyState === 'public') {
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

const updateMessagingPrivacy = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { onlineStatus, lastSeen } = req.body;

    const validSettings = ['everyone', 'followers', 'nobody'];

    if (onlineStatus && !validSettings.includes(onlineStatus)) {
        throw new ApiError(400, 'Invalid onlineStatus setting. Must be: everyone, followers, or nobody');
    }

    if (lastSeen && !validSettings.includes(lastSeen)) {
        throw new ApiError(400, 'Invalid lastSeen setting. Must be: everyone, followers, or nobody');
    }

    const updateFields = {};
    if (onlineStatus) {
        updateFields['messagingPrivacy.onlineStatus'] = onlineStatus;
    }
    if (lastSeen) {
        updateFields['messagingPrivacy.lastSeen'] = lastSeen;
    }

    if (Object.keys(updateFields).length === 0) {
        throw new ApiError(400, 'At least one privacy setting must be provided');
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: updateFields },
        { new: true, runValidators: true }
    ).select('messagingPrivacy');

    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    const updatedOnlineStatus = user.messagingPrivacy?.onlineStatus || 'everyone';
    const updatedLastSeen = user.messagingPrivacy?.lastSeen || 'everyone';
    const canSeeOthersStatus = updatedOnlineStatus !== 'nobody' && updatedLastSeen !== 'nobody';

    return res.status(200).json(
        new ApiResponse(200, {
            privacy: {
                onlineStatus: updatedOnlineStatus,
                lastSeen: updatedLastSeen,
                canSeeOthersStatus
            }
        }, 'Messaging privacy settings updated successfully')
    );
});

const getMessagingPrivacy = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId).select('messagingPrivacy');

    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    const onlineStatus = user.messagingPrivacy?.onlineStatus || 'everyone';
    const lastSeen = user.messagingPrivacy?.lastSeen || 'everyone';
    const canSeeOthersStatus = onlineStatus !== 'nobody' && lastSeen !== 'nobody';

    const privacy = { onlineStatus, lastSeen, canSeeOthersStatus };

    return res.status(200).json(
        new ApiResponse(200, { privacy }, 'Messaging privacy settings retrieved successfully')
    );
});

export {
    togglePhoneNumberVisibility,
    toggleAddressVisibility,
    toggleFullPrivateAccount,
    updateMessagingPrivacy,
    getMessagingPrivacy,
};
