import Block from "../models/block.models.js";
import { asyncHandler } from "../utils/asyncHandler.js";
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
 * Is there a block between these two users, in EITHER direction?
 *
 * Authoritative (reads Block directly, no cache) because the callers are
 * write paths and read paths that must not act on a five-minute-old answer:
 * sending a message, opening a conversation, fetching a post. The cached list
 * above is for bulk filtering, where being briefly stale only affects
 * ordering; here it would mean a blocked user's message actually landing.
 *
 * Returns false when either id is missing, so an anonymous viewer is simply
 * "not blocked" rather than throwing.
 */
export const isBlockedBetween = async (userA, userB) => {
    if (!userA || !userB) return false;
    if (userA.toString() === userB.toString()) return false;

    try {
        const block = await Block.exists({
            $or: [
                { blockerId: userA, blockedId: userB },
                { blockerId: userB, blockedId: userA }
            ]
        });
        return !!block;
    } catch (error) {
        console.error('Error checking block relationship:', error);
        // Fail CLOSED would break every chat if Mongo hiccups; fail open here
        // matches how the rest of the block filtering degrades.
        return false;
    }
};

/**
 * The ids blocked in either direction for one user, as strings.
 *
 * Same data req.blockedUsers carries, for controllers whose route does not
 * mount getBlockedUsers (e.g. the profile-posts route). Shares the cache key
 * with the middleware so one warm-up serves both.
 */
export const getBlockedUserIds = async (userId) => {
    if (!userId) return [];

    const userIdStr = userId.toString();
    const cacheKey = `blocked:${userIdStr}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (error) {
        console.error('Error reading blocked users cache:', error);
    }

    try {
        const [blockedByMe, blockedByOthers] = await Promise.all([
            Block.find({ blockerId: userId }).select('blockedId').lean(),
            Block.find({ blockedId: userId }).select('blockerId').lean()
        ]);

        const blockedUsers = [
            ...blockedByMe.map(block => block.blockedId.toString()),
            ...blockedByOthers.map(block => block.blockerId.toString())
        ];

        try {
            await redisClient.setex(cacheKey, 300, JSON.stringify(blockedUsers));
        } catch (cacheError) {
            console.error('Error caching blocked users:', cacheError);
        }

        return blockedUsers;
    } catch (error) {
        console.error('Error loading blocked users:', error);
        return [];
    }
};

/**
 * Helper function to invalidate blocked users cache
 * Call this when a user blocks/unblocks someone
 *
 * The blocked LIST is only half of it. Both users' home feeds are cached per
 * viewer (fn:user:<id>:feed:*) with the block filter already baked in, so
 * without dropping those a freshly blocked account's posts stayed in the feed
 * until the TTL expired — and, worse the other way round, an UNBLOCKED
 * account's posts and stories stayed missing for the same window, which reads
 * as "unblocking did nothing". Same for the cached profile snapshots.
 */
export const invalidateBlockedUsersCache = async (userId, blockedUserId = null) => {
    const ids = [userId, blockedUserId].filter(Boolean).map(id => id.toString());

    try {
        await Promise.all(ids.map(id => redisClient.del(`blocked:${id}`)));
    } catch (error) {
        console.error('Error invalidating blocked users cache:', error);
    }

    try {
        const { FeedCacheManager, UserCacheManager } = await import('../utils/cache.utils.js');
        const { invalidateViewableUsersCache } = await import('./privacy.middleware.js');

        await Promise.allSettled(ids.flatMap(id => [
            FeedCacheManager.invalidateUserFeed(id),
            UserCacheManager.invalidateUserProfile(id),
            invalidateViewableUsersCache(id),
            // getUserChats caches its own page-by-page result, and that result
            // now hides direct chats with blocked users — so both blocking and
            // unblocking have to drop it or the chat list disagrees with what
            // opening the chat does. Same key shape the chat controllers write.
            ...[1, 2, 3].flatMap(page => [
                redisClient.del(`chats:user:${id}:status:active:page:${page}:limit:20`),
                redisClient.del(`chats:user:${id}:status:requested:page:${page}:limit:20`)
            ])
        ]));
    } catch (error) {
        console.error('Error invalidating block-dependent caches:', error);
    }
};
