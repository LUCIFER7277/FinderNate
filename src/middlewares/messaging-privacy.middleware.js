import { User } from '../models/user.models.js';
import Follower from '../models/follower.models.js';

/**
 * Check if viewer can see target user's online status based on privacy settings
 * @param {string} viewerId - ID of user trying to view status
 * @param {string} targetUserId - ID of user whose status is being viewed
 * @param {Object} targetUser - Target user document (optional, will fetch if not provided)
 * @returns {Promise<boolean>} - true if viewer can see online status
 */
export const checkOnlineStatusPrivacy = async (viewerId, targetUserId, targetUser = null) => {
    // User can always see their own status
    if (viewerId.toString() === targetUserId.toString()) {
        return true;
    }

    // Fetch target user if not provided
    if (!targetUser) {
        targetUser = await User.findById(targetUserId).select('messagingPrivacy');
        if (!targetUser) {
            return false;
        }
    }

    // Check viewer's own privacy setting - if they hide their status, they can't see others'
    const viewerUser = await User.findById(viewerId).select('messagingPrivacy');
    if (viewerUser && viewerUser.messagingPrivacy?.onlineStatus === 'nobody') {
        return false; // If you hide your status, you can't see others'
    }

    const privacySetting = targetUser.messagingPrivacy?.onlineStatus || 'everyone';

    switch (privacySetting) {
        case 'nobody':
            return false;

        case 'followers':
            // Check if viewer follows target
            const isFollower = await Follower.findOne({
                followerId: viewerId,
                userId: targetUserId
            });
            return !!isFollower;

        case 'everyone':
        default:
            return true;
    }
};

/**
 * Check if viewer can see target user's last seen timestamp based on privacy settings
 * @param {string} viewerId - ID of user trying to view last seen
 * @param {string} targetUserId - ID of user whose last seen is being viewed
 * @param {Object} targetUser - Target user document (optional, will fetch if not provided)
 * @returns {Promise<boolean>} - true if viewer can see last seen
 */
export const checkLastSeenPrivacy = async (viewerId, targetUserId, targetUser = null) => {
    // User can always see their own last seen
    if (viewerId.toString() === targetUserId.toString()) {
        return true;
    }

    // Fetch target user if not provided
    if (!targetUser) {
        targetUser = await User.findById(targetUserId).select('messagingPrivacy');
        if (!targetUser) {
            return false;
        }
    }

    // Check viewer's own privacy setting - if they hide their last seen, they can't see others'
    const viewerUser = await User.findById(viewerId).select('messagingPrivacy');
    if (viewerUser && viewerUser.messagingPrivacy?.lastSeen === 'nobody') {
        return false; // If you hide your last seen, you can't see others'
    }

    const privacySetting = targetUser.messagingPrivacy?.lastSeen || 'everyone';

    switch (privacySetting) {
        case 'nobody':
            return false;

        case 'followers':
            // Check if viewer follows target
            const isFollower = await Follower.findOne({
                followerId: viewerId,
                userId: targetUserId
            });
            return !!isFollower;

        case 'everyone':
        default:
            return true;
    }
};

/**
 * Check if current user can see others' online status (reciprocity check)
 * If user hides their own status, they cannot see others'
 * @param {string} userId - ID of user to check
 * @returns {Promise<boolean>} - true if user can see others' status
 */
export const canUserSeeOthersStatus = async (userId) => {
    const user = await User.findById(userId).select('messagingPrivacy').lean();
    if (!user) return true;

    const onlinePrivacy = user.messagingPrivacy?.onlineStatus || 'everyone';
    const lastSeenPrivacy = user.messagingPrivacy?.lastSeen || 'everyone';

    // If user hides either status completely, they cannot see others'
    return onlinePrivacy !== 'nobody' && lastSeenPrivacy !== 'nobody';
};

/**
 * Get the online status and last seen for a user, respecting privacy settings
 * @param {string} viewerId - ID of user trying to view status
 * @param {string} targetUserId - ID of user whose status is being viewed
 * @param {Function} isUserOnline - Function to check if user is online (from socketManager)
 * @returns {Promise<Object>} - Object with online status, lastSeen, and canSeeStatus
 */
export const getPrivacyFilteredStatus = async (viewerId, targetUserId, isUserOnline) => {
    const targetUser = await User.findById(targetUserId)
        .select('messagingPrivacy lastSeenAt')
        .lean();

    if (!targetUser) {
        return {
            online: false,
            lastSeen: null,
            canSeeStatus: false
        };
    }

    const canSeeOnline = await checkOnlineStatusPrivacy(viewerId, targetUserId, targetUser);
    const canSeeLastSeen = await checkLastSeenPrivacy(viewerId, targetUserId, targetUser);
    const canSeeStatus = canSeeOnline || canSeeLastSeen;

    return {
        online: canSeeOnline ? await isUserOnline(targetUserId) : false,
        lastSeen: canSeeLastSeen ? targetUser.lastSeenAt : null,
        canSeeStatus
    };
};
