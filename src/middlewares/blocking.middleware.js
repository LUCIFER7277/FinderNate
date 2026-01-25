import Block from "../models/block.models.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { redisClient } from "../config/redis.config.js";

/**
 * Middleware to get blocked users for the current user
 * Adds req.blockedUsers array to the request object
 * ✅ OPTIMIZED: Uses Redis caching to avoid repeated DB queries
 */
export const getBlockedUsers = asyncHandler(async (req, res, next) => {
    if (!req.user?._id) {
        req.blockedUsers = [];
        return next();
    }

    try {
        const userId = req.user._id.toString();
        const cacheKey = `blocked:${userId}`;

        // Try to get from cache first
        const cachedBlocked = await redisClient.get(cacheKey);

        if (cachedBlocked) {
            req.blockedUsers = JSON.parse(cachedBlocked);
            return next();
        }

        // Cache miss - query database
        const [blockedByMe, blockedByOthers] = await Promise.all([
            Block.find({ blockerId: req.user._id }).select('blockedId').lean(),
            Block.find({ blockedId: req.user._id }).select('blockerId').lean()
        ]);

        // Combine both arrays of user IDs
        const blockedUsers = [
            ...blockedByMe.map(block => block.blockedId.toString()),
            ...blockedByOthers.map(block => block.blockerId.toString())
        ];

        // Cache for 5 minutes
        await redisClient.setex(cacheKey, 300, JSON.stringify(blockedUsers));

        req.blockedUsers = blockedUsers;
        next();
    } catch (error) {
        console.error('Error getting blocked users:', error);
        req.blockedUsers = [];
        next();
    }
});

/**
 * Middleware to filter out blocked users from search results
 */
export const filterBlockedUsers = asyncHandler(async (req, res, next) => {
    if (!req.user?._id || !req.blockedUsers) {
        return next();
    }

    // If there are no blocked users, no filtering needed
    if (req.blockedUsers.length === 0) {
        return next();
    }

    // Add blocked users filter to the request for controllers to use
    req.blockedUsersFilter = { _id: { $nin: req.blockedUsers } };
    next();
});

/**
 * Helper function to get blocked users filter object
 * Can be used in controllers to filter queries
 * ✅ OPTIMIZED: Uses Redis caching
 */
export const getBlockedUsersFilter = (userId) => {
    if (!userId) return {};

    return new Promise(async (resolve) => {
        try {
            const cacheKey = `blocked:${userId}`;

            // Try cache first
            const cachedBlocked = await redisClient.get(cacheKey);
            let blockedUsers;

            if (cachedBlocked) {
                blockedUsers = JSON.parse(cachedBlocked);
            } else {
                // Cache miss - query database
                const [blockedByMe, blockedByOthers] = await Promise.all([
                    Block.find({ blockerId: userId }).select('blockedId').lean(),
                    Block.find({ blockedId: userId }).select('blockerId').lean()
                ]);

                blockedUsers = [
                    ...blockedByMe.map(block => block.blockedId.toString()),
                    ...blockedByOthers.map(block => block.blockerId.toString())
                ];

                // Cache for 5 minutes
                await redisClient.setex(cacheKey, 300, JSON.stringify(blockedUsers));
            }

            resolve({ _id: { $nin: blockedUsers } });
        } catch (error) {
            console.error('Error getting blocked users filter:', error);
            resolve({});
        }
    });
};

/**
 * Helper function to invalidate blocked users cache
 * Call this when a user blocks/unblocks someone
 */
export const invalidateBlockedUsersCache = async (userId, blockedUserId = null) => {
    try {
        const userIdStr = userId.toString();
        const cacheKey = `blocked:${userIdStr}`;
        await redisClient.del(cacheKey);

        // Also invalidate the blocked user's cache (they might have blocked this user)
        if (blockedUserId) {
            const blockedUserIdStr = blockedUserId.toString();
            const blockedCacheKey = `blocked:${blockedUserIdStr}`;
            await redisClient.del(blockedCacheKey);
        }
    } catch (error) {
        console.error('Error invalidating blocked users cache:', error);
    }
};
