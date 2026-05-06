import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import { ApiError } from './ApiError.js';

/**
 * Generic Cache Manager for FinderNate
 * Provides high-level caching operations with error handling
 */
export class CacheManager {

    /**
     * Get data from cache
     * @param {string} key - Cache key
     * @param {Object} options - Caching options
     * @returns {Promise<any|null>} Cached data or null
     */
    static async get(key, options = {}) {
        try {
            const { parseJSON = true } = options;
            const data = await redisClient.get(key);

            if (!data) return null;

            return parseJSON ? JSON.parse(data) : data;
        } catch (error) {
            console.error(`Cache GET error for key ${key}:`, error);
            return null; // Graceful degradation
        }
    }

    /**
     * Set data in cache
     * @param {string} key - Cache key
     * @param {any} data - Data to cache
     * @param {number} ttl - Time to live in seconds
     * @param {Object} options - Caching options
     */
    static async set(key, data, ttl, options = {}) {
        try {
            const { stringify = true } = options;
            const value = stringify ? JSON.stringify(data) : data;

            if (ttl) {
                await redisClient.setex(key, ttl, value);
            } else {
                await redisClient.set(key, value);
            }

            return true;
        } catch (error) {
            console.error(`Cache SET error for key ${key}:`, error);
            return false;
        }
    }

    /**
     * Delete data from cache
     * @param {string|string[]} keys - Cache key(s) to delete
     */
    static async del(keys) {
        try {
            const keyArray = Array.isArray(keys) ? keys : [keys];
            await redisClient.del(...keyArray);
            return true;
        } catch (error) {
            console.error(`Cache DEL error for keys ${keys}:`, error);
            return false;
        }
    }

    /**
     * Delete multiple keys by pattern
     * @param {string} pattern - Key pattern (e.g., 'fn:user:123:*')
     */
    static async delPattern(pattern) {
        try {
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(...keys);
            }
            return keys.length;
        } catch (error) {
            console.error(`Cache DEL pattern error for pattern ${pattern}:`, error);
            return 0;
        }
    }

    /**
     * Check if key exists in cache
     * @param {string} key - Cache key
     * @returns {Promise<boolean>}
     */
    static async exists(key) {
        try {
            const exists = await redisClient.exists(key);
            return exists === 1;
        } catch (error) {
            console.error(`Cache EXISTS error for key ${key}:`, error);
            return false;
        }
    }

    /**
     * Get or Set pattern (cache-aside)
     * @param {string} key - Cache key
     * @param {Function} fetchFunction - Function to fetch data if not cached
     * @param {number} ttl - Time to live in seconds
     * @param {Object} options - Additional options
     */
    static async getOrSet(key, fetchFunction, ttl, options = {}) {
        try {
            // Try to get from cache first
            let data = await this.get(key, options);

            if (data !== null) {
                return { data, fromCache: true };
            }

            // If not in cache, fetch from source
            data = await fetchFunction();

            // Cache the result
            if (data !== null && data !== undefined) {
                await this.set(key, data, ttl, options);
            }

            return { data, fromCache: false };
        } catch (error) {
            console.error(`Cache getOrSet error for key ${key}:`, error);
            // Return data from fetchFunction even if caching fails
            const data = await fetchFunction();
            return { data, fromCache: false };
        }
    }
}

/**
 * Feed Cache Manager - Specialized for social feeds
 */
export class FeedCacheManager extends CacheManager {

    /**
     * Cache user's home feed
     * @param {string} userId - User ID
     * @param {number} page - Page number
     * @param {Array} feedData - Feed data to cache
     */
    static async cacheUserFeed(userId, page, feedData) {
        const key = RedisKeys.userFeed(userId, page);
        await this.set(key, feedData, RedisTTL.USER_FEED);
    }

    /**
     * Get user's cached home feed
     * @param {string} userId - User ID
     * @param {number} page - Page number
     * @returns {Promise<Array|null>} Cached feed or null
     */
    static async getUserFeed(userId, page) {
        const key = RedisKeys.userFeed(userId, page);
        return await this.get(key);
    }

    /**
     * Invalidate user's feed cache
     * @param {string} userId - User ID
     */
    static async invalidateUserFeed(userId) {
        const pattern = RedisKeys.userFeed(userId, '*').replace('*', '\\*');
        return await this.delPattern(pattern);
    }

    /**
     * Cache explore/trending feed
     * @param {string} location - Location or 'global'
     * @param {Array} feedData - Trending posts data
     */
    static async cacheTrendingFeed(location, feedData) {
        const key = RedisKeys.trendingPosts(location);
        await this.set(key, feedData, RedisTTL.TRENDING_POSTS);
    }

    /**
     * Get trending feed from cache
     * @param {string} location - Location or 'global'
     * @returns {Promise<Array|null>} Cached trending posts
     */
    static async getTrendingFeed(location) {
        const key = RedisKeys.trendingPosts(location);
        return await this.get(key);
    }

    /**
     * Invalidate trending feed cache (all locations)
     */
    static async invalidateTrendingFeed() {
        const pattern = 'fn:posts:trending:*';
        return await this.delPattern(pattern);
    }

    /**
     * Invalidate explore feed cache (all pages)
     */
    static async invalidateExploreFeed() {
        const pattern = 'fn:explore:feed:*';
        return await this.delPattern(pattern);
    }
}

/**
 * User Cache Manager - Specialized for user data
 */
export class UserCacheManager extends CacheManager {

    /**
     * Cache user profile
     * @param {string} userId - User ID
     * @param {Object} userData - User profile data
     */
    static async cacheUserProfile(userId, userData) {
        const key = RedisKeys.userProfile(userId);
        await this.set(key, userData, RedisTTL.USER_PROFILE);
    }

    /**
     * Get user profile from cache
     * @param {string} userId - User ID
     * @returns {Promise<Object|null>} Cached user profile
     */
    static async getUserProfile(userId) {
        const key = RedisKeys.userProfile(userId);
        return await this.get(key);
    }

    /**
     * Invalidate user profile and related caches
     * @param {string} userId - User ID
     */
    static async invalidateUserProfile(userId) {
        const keys = [
            RedisKeys.userProfile(userId),
            RedisKeys.userFollowers(userId),
            RedisKeys.userFollowing(userId)
        ];
        await this.del(keys);

        // Also invalidate user's feed since profile info appears in feeds
        await FeedCacheManager.invalidateUserFeed(userId);
    }
}

/**
 * Search Cache Manager - Specialized for search and discovery
 */
export class SearchCacheManager extends CacheManager {

    /**
     * Cache search results
     * @param {string} query - Search query
     * @param {number} page - Page number
     * @param {Array} results - Search results
     */
    static async cacheSearchResults(query, page, results) {
        const key = RedisKeys.searchResults(query, page);
        await this.set(key, results, RedisTTL.SEARCH_RESULTS);
    }

    /**
     * Get cached search results
     * @param {string} query - Search query
     * @param {number} page - Page number
     * @returns {Promise<Array|null>} Cached search results
     */
    static async getSearchResults(query, page) {
        const key = RedisKeys.searchResults(query, page);
        return await this.get(key);
    }

    /**
     * Cache user suggestions
     * @param {string} userId - User ID
     * @param {Array} suggestions - User suggestions
     */
    static async cacheUserSuggestions(userId, suggestions) {
        const key = RedisKeys.userSuggestions(userId);
        await this.set(key, suggestions, RedisTTL.USER_PROFILE);
    }

    /**
     * Get user suggestions from cache
     * @param {string} userId - User ID
     * @returns {Promise<Array|null>} Cached user suggestions
     */
    static async getUserSuggestions(userId) {
        const key = RedisKeys.userSuggestions(userId);
        return await this.get(key);
    }
}

/**
 * Session Cache Manager - Specialized for authentication
 */
export class SessionCacheManager extends CacheManager {

    /**
     * Cache user session
     * @param {string} userId - User ID
     * @param {string} deviceId - Device ID
     * @param {Object} sessionData - Session data
     */
    static async cacheSession(userId, deviceId, sessionData) {
        const key = RedisKeys.userSession(userId, deviceId);
        await this.set(key, sessionData, RedisTTL.USER_SESSION);
    }

    /**
     * Get user session from cache
     * @param {string} userId - User ID
     * @param {string} deviceId - Device ID
     * @returns {Promise<Object|null>} Cached session data
     */
    static async getSession(userId, deviceId) {
        const key = RedisKeys.userSession(userId, deviceId);
        return await this.get(key);
    }

    /**
     * Blacklist a JWT token
     * @param {string} jti - JWT ID
     * @param {number} ttl - Time until token expires
     */
    static async blacklistToken(jti, ttl) {
        const key = RedisKeys.tokenBlacklist(jti);
        await this.set(key, 'revoked', ttl, { stringify: false });
    }

    /**
     * Check if token is blacklisted
     * @param {string} jti - JWT ID
     * @returns {Promise<boolean>} True if blacklisted
     */
    static async isTokenBlacklisted(jti) {
        const key = RedisKeys.tokenBlacklist(jti);
        return await this.exists(key);
    }

    /**
     * Rate limiting for authentication attempts
     * @param {string} ip - IP address
     * @param {number} maxAttempts - Maximum attempts allowed
     * @returns {Promise<Object>} Rate limit info
     */
    static async checkRateLimit(ip, maxAttempts = 5) {
        const key = RedisKeys.authRateLimit(ip);

        try {
            const current = await redisClient.incr(key);

            if (current === 1) {
                await redisClient.expire(key, RedisTTL.RATE_LIMIT);
            }

            const ttl = await redisClient.ttl(key);
            const remaining = Math.max(0, maxAttempts - current);

            return {
                attempts: current,
                remaining,
                resetTime: Date.now() + (ttl * 1000),
                blocked: current > maxAttempts
            };
        } catch (error) {
            console.error('Rate limit check error:', error);
            return { attempts: 0, remaining: maxAttempts, resetTime: 0, blocked: false };
        }
    }
}

/**
 * Cache invalidation utilities
 */
export class CacheInvalidator {

    // Debounce timers to prevent excessive invalidation
    static _trendingInvalidationTimer = null;
    static _exploreInvalidationTimer = null;

    /**
     * Invalidate cache on new post creation
     * @param {Object} post - Post data
     * @param {string} authorId - Post author ID
     * @param {Array<string>} followerIds - Optional array of follower IDs (for targeted invalidation)
     */
    static async onNewPost(post, authorId, followerIds = null) {
        try {
            // Only invalidate the author's own feed cache (they'll see their new post)
            await FeedCacheManager.invalidateUserFeed(authorId);

            // If follower IDs are provided, invalidate their feeds specifically
            if (followerIds && Array.isArray(followerIds) && followerIds.length > 0) {
                // Limit to first 100 followers to prevent excessive operations
                const limitedFollowers = followerIds.slice(0, 100);

                // Batch invalidate follower feeds
                const invalidationPromises = limitedFollowers.map(followerId =>
                    FeedCacheManager.invalidateUserFeed(followerId)
                );

                await Promise.allSettled(invalidationPromises);
            }

            // Debounce trending feed invalidation (wait 5 seconds for multiple posts)
            this._debounceTrendingInvalidation();

            // Debounce explore feed invalidation
            this._debounceExploreInvalidation();
        } catch (error) {
            console.error('Cache invalidation error in onNewPost:', error);
            // Don't throw - cache invalidation failures shouldn't break post creation
        }
    }

    /**
     * Debounced trending feed invalidation
     */
    static _debounceTrendingInvalidation() {
        if (this._trendingInvalidationTimer) {
            clearTimeout(this._trendingInvalidationTimer);
        }

        this._trendingInvalidationTimer = setTimeout(async () => {
            try {
                // Use SCAN instead of KEYS for better performance
                await this._scanAndDelete('fn:posts:trending:*');
            } catch (error) {
                console.error('Trending invalidation error:', error);
            }
        }, 5000); // 5 second debounce
    }

    /**
     * Debounced explore feed invalidation
     */
    static _debounceExploreInvalidation() {
        if (this._exploreInvalidationTimer) {
            clearTimeout(this._exploreInvalidationTimer);
        }

        this._exploreInvalidationTimer = setTimeout(async () => {
            try {
                await this._scanAndDelete('fn:explore:feed:*');
            } catch (error) {
                console.error('Explore invalidation error:', error);
            }
        }, 5000); // 5 second debounce
    }

    /**
     * Use SCAN instead of KEYS for safe pattern deletion
     * @param {string} pattern - Redis key pattern
     */
    static async _scanAndDelete(pattern) {
        try {
            const keys = [];
            let cursor = '0';

            // Use SCAN to iterate through keys (non-blocking)
            do {
                const result = await redisClient.scan(
                    cursor,
                    'MATCH', pattern,
                    'COUNT', 100
                );
                cursor = result[0];
                keys.push(...result[1]);

                // Delete in batches of 50
                if (keys.length >= 50) {
                    const batch = keys.splice(0, 50);
                    if (batch.length > 0) {
                        await redisClient.del(...batch);
                    }
                }
            } while (cursor !== '0');

            // Delete remaining keys
            if (keys.length > 0) {
                await redisClient.del(...keys);
            }
        } catch (error) {
            console.error('SCAN and delete error:', error);
        }
    }

    /**
     * Invalidate cache on user follow/unfollow
     * @param {string} userId - User who performed action
     * @param {string} targetId - Target user
     */
    static async onFollowAction(userId, targetId) {
        const keys = [
            RedisKeys.userFollowers(targetId),
            RedisKeys.userFollowing(userId),
            RedisKeys.userSuggestions(userId),
            RedisKeys.userSuggestions(targetId)
        ];

        await CacheManager.del(keys);

        // Invalidate feeds for both users
        await FeedCacheManager.invalidateUserFeed(userId);
        await FeedCacheManager.invalidateUserFeed(targetId);
    }

    /**
     * Invalidate cache on post interaction (like, comment)
     * @param {string} postId - Post ID
     * @param {string} authorId - Post author ID
     */
    static async onPostInteraction(postId, authorId) {
        const keys = [
            RedisKeys.postStats(postId),
            RedisKeys.postDetails(postId)
        ];

        await CacheManager.del(keys);

        // Debounce trending invalidation instead of immediate
        this._debounceTrendingInvalidation();
    }
}

export default CacheManager;