import { CacheManager } from './cache.utils.js';
import { redisClient } from '../config/redis.config.js';

/**
 * Cache manager for expensive database operations
 * Optimized for operations like privacy checks, follower lookups, etc.
 */
export class ExpensiveOperationsCache {

    /**
     * Cache viewable user IDs for privacy filtering
     * @param {string} viewerId - Viewer user ID (null for anonymous)
     * @param {Array} userIds - Array of viewable user IDs
     * @param {number} ttl - Time to live in seconds (default: 5 minutes)
     */
    static async cacheViewableUserIds(viewerId, userIds, ttl = 300) {
        const key = `fn:privacy:viewable:${viewerId || 'anonymous'}`;
        await CacheManager.set(key, userIds, ttl);
        return userIds;
    }

    /**
     * Get cached viewable user IDs
     * @param {string} viewerId - Viewer user ID (null for anonymous)
     * @returns {Promise<Array|null>} Cached user IDs or null
     */
    static async getViewableUserIds(viewerId) {
        const key = `fn:privacy:viewable:${viewerId || 'anonymous'}`;
        return await CacheManager.get(key);
    }

    /**
     * Cache user's following list
     * @param {string} userId - User ID
     * @param {Array} followingIds - Array of following user IDs
     * @param {number} ttl - Time to live in seconds (default: 10 minutes)
     */
    static async cacheFollowingList(userId, followingIds, ttl = 600) {
        const key = `fn:user:${userId}:following:list`;
        await CacheManager.set(key, followingIds, ttl);
        return followingIds;
    }

    /**
     * Get cached following list
     * @param {string} userId - User ID
     * @returns {Promise<Array|null>} Cached following IDs or null
     */
    static async getFollowingList(userId) {
        const key = `fn:user:${userId}:following:list`;
        return await CacheManager.get(key);
    }

    /**
     * Cache user's followers list
     * @param {string} userId - User ID
     * @param {Array} followerIds - Array of follower user IDs
     * @param {number} ttl - Time to live in seconds (default: 10 minutes)
     */
    static async cacheFollowersList(userId, followerIds, ttl = 600) {
        const key = `fn:user:${userId}:followers:list`;
        await CacheManager.set(key, followerIds, ttl);
        return followerIds;
    }

    /**
     * Get cached followers list
     * @param {string} userId - User ID
     * @returns {Promise<Array|null>} Cached follower IDs or null
     */
    static async getFollowersList(userId) {
        const key = `fn:user:${userId}:followers:list`;
        return await CacheManager.get(key);
    }

    /**
     * Cache blocked users list
     * @param {string} userId - User ID
     * @param {Array} blockedIds - Array of blocked user IDs
     * @param {number} ttl - Time to live in seconds (default: 15 minutes)
     */
    static async cacheBlockedUsers(userId, blockedIds, ttl = 900) {
        const key = `fn:user:${userId}:blocked:list`;
        await CacheManager.set(key, blockedIds, ttl);
        return blockedIds;
    }

    /**
     * Get cached blocked users list
     * @param {string} userId - User ID
     * @returns {Promise<Array|null>} Cached blocked IDs or null
     */
    static async getBlockedUsers(userId) {
        const key = `fn:user:${userId}:blocked:list`;
        return await CacheManager.get(key);
    }

    /**
     * Cache post engagement counts
     * @param {string} postId - Post ID
     * @param {Object} engagement - Engagement data {likes, comments, shares, views}
     * @param {number} ttl - Time to live in seconds (default: 2 minutes)
     */
    static async cachePostEngagement(postId, engagement, ttl = 120) {
        const key = `fn:post:${postId}:engagement`;
        await CacheManager.set(key, engagement, ttl);
        return engagement;
    }

    /**
     * Get cached post engagement
     * @param {string} postId - Post ID
     * @returns {Promise<Object|null>} Cached engagement data or null
     */
    static async getPostEngagement(postId) {
        const key = `fn:post:${postId}:engagement`;
        return await CacheManager.get(key);
    }

    /**
     * Batch cache post engagements
     * @param {Array} posts - Array of posts with engagement data
     * @param {number} ttl - Time to live in seconds (default: 2 minutes)
     */
    static async batchCachePostEngagements(posts, ttl = 120) {
        const pipeline = redisClient.pipeline();

        posts.forEach(post => {
            const key = `fn:post:${post._id}:engagement`;
            const engagement = {
                likes: post.engagement?.likes || 0,
                comments: post.engagement?.comments || 0,
                shares: post.engagement?.shares || 0,
                views: post.engagement?.views || 0
            };
            pipeline.setex(key, ttl, JSON.stringify(engagement));
        });

        await pipeline.exec();
    }

    /**
     * Cache user likes for posts (used in feed)
     * @param {string} userId - User ID
     * @param {Array} postIds - Array of liked post IDs
     * @param {number} ttl - Time to live in seconds (default: 5 minutes)
     */
    static async cacheUserLikes(userId, postIds, ttl = 300) {
        const key = `fn:user:${userId}:likes:set`;
        // Store as Set in Redis for O(1) lookup
        await redisClient.del(key);
        if (postIds.length > 0) {
            await redisClient.sadd(key, ...postIds.map(id => id.toString()));
            await redisClient.expire(key, ttl);
        }
        return postIds;
    }

    /**
     * Check if user liked specific posts (batch)
     * @param {string} userId - User ID
     * @param {Array} postIds - Array of post IDs to check
     * @returns {Promise<Set>} Set of liked post IDs
     */
    static async getUserLikedPosts(userId, postIds) {
        const key = `fn:user:${userId}:likes:set`;
        const exists = await redisClient.exists(key);

        if (!exists) {
            return null; // Cache miss - need to fetch from DB
        }

        // Check which posts are in the set
        const results = await Promise.all(
            postIds.map(postId => redisClient.sismember(key, postId.toString()))
        );

        const likedPostIds = new Set();
        results.forEach((isLiked, index) => {
            if (isLiked) {
                likedPostIds.add(postIds[index].toString());
            }
        });

        return likedPostIds;
    }

    /**
     * Invalidate following/followers cache on follow/unfollow
     * @param {string} userId - User who performed action
     * @param {string} targetUserId - Target user ID
     */
    static async invalidateFollowCache(userId, targetUserId) {
        const keys = [
            `fn:user:${userId}:following:list`,
            `fn:user:${targetUserId}:followers:list`,
            `fn:privacy:viewable:${userId}`,
            `fn:privacy:viewable:${targetUserId}`,
            // OPTIMIZED: Also clear profile caches to update follower/following counts
            `fn:user:${userId}:profile`,
            `fn:user:${targetUserId}:profile`,
            // Clear auth cache to update user data
            `fn:user:${userId}:auth`,
            `fn:user:${targetUserId}:auth`
        ];
        await CacheManager.del(keys);
    }

    /**
     * Invalidate user likes cache
     * @param {string} userId - User ID
     * @param {string} postId - Post ID (optional)
     */
    static async invalidateUserLikesCache(userId, postId = null) {
        const keys = [`fn:user:${userId}:likes:set`];
        if (postId) {
            keys.push(`fn:post:${postId}:engagement`);
        }
        await CacheManager.del(keys);
    }

    /**
     * Get or compute viewable user IDs with caching
     * @param {string} viewerId - Viewer user ID
     * @param {Function} computeFunction - Function to compute viewable IDs
     * @returns {Promise<Array>} Array of viewable user IDs
     */
    static async getOrComputeViewableUserIds(viewerId, computeFunction) {
        // Try cache first
        const cached = await this.getViewableUserIds(viewerId);
        if (cached) {
            return cached;
        }

        // Compute if not cached
        const userIds = await computeFunction();

        // Cache the result
        await this.cacheViewableUserIds(viewerId, userIds);

        return userIds;
    }

    /**
     * Clear all expensive operations cache for a user
     * @param {string} userId - User ID
     */
    static async clearUserCache(userId) {
        const pattern = `fn:user:${userId}:*`;
        await CacheManager.delPattern(pattern);

        // Also clear privacy cache
        const privacyKey = `fn:privacy:viewable:${userId}`;
        await CacheManager.del(privacyKey);
    }
}

export default ExpensiveOperationsCache;