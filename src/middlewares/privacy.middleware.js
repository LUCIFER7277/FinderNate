import { User } from "../models/user.models.js";
import Follower from "../models/follower.models.js";
import Block from "../models/block.models.js";
import { redisClient } from "../config/redis.config.js";

/**
 * Privacy middleware to check if a user can view another user's content
 * based on account privacy settings, following relationship, and blocking
 */
export const checkContentVisibility = async (viewerId, targetUserId) => {
    // If viewing own content, always allow
    if (viewerId?.toString() === targetUserId?.toString()) {
        return true;
    }

    // Check for blocking relationship (either direction)
    if (viewerId) {
        const isBlocked = await Block.exists({
            $or: [
                { blockerId: viewerId, blockedId: targetUserId },
                { blockerId: targetUserId, blockedId: viewerId }
            ]
        });

        if (isBlocked) {
            return false; // Blocked users cannot view each other's content
        }
    }

    // Get the target user's privacy setting
    const targetUser = await User.findById(targetUserId).select('privacy');
    if (!targetUser) {
        return false;
    }

    // If target user has public account, allow viewing
    if (targetUser.privacy === 'public') {
        return true;
    }

    // If target user has private account, check if viewer is following
    if (!viewerId) {
        return false; // No viewer (anonymous), can't view private content
    }

    const isFollowing = await Follower.exists({
        userId: targetUserId,
        followerId: viewerId
    });

    return !!isFollowing;
};

/**
 * Middleware to filter posts/reels based on privacy settings
 * Adds privacy filtering to query conditions
 */
export const addPrivacyFilter = async (req, res, next) => {
    const viewerId = req.user?._id;
    
    // If no viewer, only show public content
    if (!viewerId) {
        req.privacyFilter = {
            'userId.privacy': 'public'
        };
        return next();
    }

    // Get list of users the viewer is following (with caching)
    const cacheKey = `following:${viewerId}`;
    let followingIds;

    try {
        const cachedFollowing = await redisClient.get(cacheKey);
        if (cachedFollowing) {
            followingIds = JSON.parse(cachedFollowing);
        }
    } catch (cacheError) {
        console.error('Error accessing following cache:', cacheError);
    }

    if (!followingIds) {
        const following = await Follower.find({ followerId: viewerId }).select('userId').lean();
        followingIds = following.map(f => f.userId);

        // Cache for 1 hour
        try {
            await redisClient.setex(cacheKey, 3600, JSON.stringify(followingIds));
        } catch (cacheError) {
            console.error('Error caching following list:', cacheError);
        }
    }

    // Add viewer's own ID to see their own content
    followingIds.push(viewerId);

    // Filter: show public posts OR posts from followed users
    req.privacyFilter = {
        $or: [
            { userId: { $in: followingIds } }, // Content from followed users or own content
            { 'userInfo.privacy': 'public' } // Public content from any user
        ]
    };

    next();
};

/**
 * Get users that the current user can view content from
 * (themselves + users they follow + public users)
 * ✅ OPTIMIZED: Uses Redis caching to avoid querying thousands of users on every feed request
 */
export const getViewableUserIds = async (viewerId) => {
    const cacheKey = viewerId ? `viewable_users:${viewerId}` : 'viewable_users:public';

    try {
        // Try to get from cache first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return JSON.parse(cachedData);
        }
    } catch (cacheError) {
        console.error('Error accessing viewable users cache:', cacheError);
        // Continue with DB query if cache fails
    }

    let viewableUserIds;

    if (!viewerId) {
        // Anonymous users can only see public content
        const publicUsers = await User.find({ privacy: 'public' }).select('_id').lean();
        viewableUserIds = publicUsers.map(u => u._id.toString()); // ✅ Convert to string
    } else {
        // Get users the viewer follows
        const following = await Follower.find({ followerId: viewerId }).select('userId').lean();
        const followingIds = following.map(f => f.userId.toString()); // ✅ Convert to string

        // Add viewer's own ID
        followingIds.push(viewerId.toString()); // ✅ Convert to string

        // Get all public users not already in the following list
        const publicUsers = await User.find({
            privacy: 'public',
            _id: { $nin: followingIds }
        }).select('_id').lean();

        // Combine following + own + public users
        viewableUserIds = [...followingIds, ...publicUsers.map(u => u._id.toString())]; // ✅ Convert to string
    }

    // Cache for 5 minutes
    try {
        await redisClient.setex(cacheKey, 300, JSON.stringify(viewableUserIds));
    } catch (cacheError) {
        console.error('Error caching viewable users:', cacheError);
        // Continue without caching
    }

    return viewableUserIds;
};

/**
 * Helper function to invalidate viewable users cache
 * Call this when:
 * - User follows/unfollows someone
 * - User changes their privacy settings
 * - Follow request is accepted/rejected
 */
export const invalidateViewableUsersCache = async (userId) => {
    try {
        const cacheKey = `viewable_users:${userId}`;
        await redisClient.del(cacheKey);
        // Also invalidate public cache as privacy changes affect it
        await redisClient.del('viewable_users:public');
    } catch (error) {
        console.error('Error invalidating viewable users cache:', error);
    }
};