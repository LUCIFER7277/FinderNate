/**
 * Redis Integration Examples for FinderNate Controllers
 * 
 * This file demonstrates how to integrate Redis caching into existing controllers
 * for maximum performance improvement with minimal code changes.
 */

import { 
    CacheManager, 
    FeedCacheManager, 
    UserCacheManager, 
    SearchCacheManager,
    CacheInvalidator 
} from '../utlis/cache.utils.js';
import { RedisKeys, RedisTTL } from '../config/redis.config.js';
import { 
    feedCacheMiddleware,
    searchCacheMiddleware,
    profileCacheMiddleware,
    trendingCacheMiddleware
} from '../middlewares/cache.middleware.js';

/**
 * EXAMPLE 1: Enhanced Home Feed with Redis Caching
 * Original: src/controllers/homeFeed.controllers.js
 */
export const getHomeFeedCached = async (req, res) => {
    try {
        const userId = req.user?._id;
        const page = parseInt(req.query.page) || 1;
        const refresh = req.query.refresh === 'true';

        // Skip cache if refresh requested
        if (!refresh) {
            // Try to get from cache first
            const cachedFeed = await FeedCacheManager.getUserFeed(userId, page);
            if (cachedFeed) {
                return res.json({
                    success: true,
                    data: cachedFeed,
                    fromCache: true,
                    page,
                    message: "Home feed retrieved from cache"
                });
            }
        }

        // Original feed generation logic here...
        // const feedData = await generateHomeFeed(userId, page);
        const feedData = []; // Placeholder

        // Cache the result
        await FeedCacheManager.cacheUserFeed(userId, page, feedData);

        res.json({
            success: true,
            data: feedData,
            fromCache: false,
            page,
            message: "Home feed retrieved successfully"
        });

    } catch (error) {
        console.error('Home feed error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * EXAMPLE 2: Cached User Profile with Invalidation
 * Original: src/controllers/user.controllers.js
 */
export const getUserProfileCached = async (req, res) => {
    try {
        const { userId } = req.params;

        // Use cache-aside pattern
        const { data: userProfile, fromCache } = await CacheManager.getOrSet(
            RedisKeys.userProfile(userId),
            async () => {
                // Original database query
                const user = await User.findById(userId)
                    .select('-password -refreshToken')
                    .populate('businessProfileId');
                
                if (!user) {
                    throw new Error('User not found');
                }
                
                return user;
            },
            RedisTTL.USER_PROFILE
        );

        res.json({
            success: true,
            data: userProfile,
            fromCache,
            message: "User profile retrieved successfully"
        });

    } catch (error) {
        console.error('User profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * EXAMPLE 3: Search Results with Smart Caching
 * Original: src/controllers/searchAllContent.controllers.js
 */
export const searchContentCached = async (req, res) => {
    try {
        const { q: query, page = 1, type = 'all' } = req.query;

        if (!query || query.length < 2) {
            return res.status(400).json({
                error: 'Query must be at least 2 characters long'
            });
        }

        // Check cache first
        const cachedResults = await SearchCacheManager.getSearchResults(query, page);
        if (cachedResults) {
            return res.json({
                success: true,
                data: cachedResults,
                fromCache: true,
                query,
                page,
                message: "Search results retrieved from cache"
            });
        }

        // Perform actual search (original logic)
        const searchResults = await performSearch(query, page, type);

        // Cache results
        await SearchCacheManager.cacheSearchResults(query, page, searchResults);

        res.json({
            success: true,
            data: searchResults,
            fromCache: false,
            query,
            page,
            message: "Search completed successfully"
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * EXAMPLE 4: Trending Posts with Location-based Caching
 * Original: src/controllers/explore.controllers.js
 */
export const getTrendingPostsCached = async (req, res) => {
    try {
        const { location = 'global', limit = 20 } = req.query;

        // Try cache first
        const cachedTrending = await FeedCacheManager.getTrendingFeed(location);
        if (cachedTrending) {
            return res.json({
                success: true,
                data: cachedTrending.slice(0, limit),
                fromCache: true,
                location,
                message: "Trending posts retrieved from cache"
            });
        }

        // Generate trending posts (original logic)
        const trendingPosts = await generateTrendingPosts(location);

        // Cache results
        await FeedCacheManager.cacheTrendingFeed(location, trendingPosts);

        res.json({
            success: true,
            data: trendingPosts.slice(0, limit),
            fromCache: false,
            location,
            message: "Trending posts retrieved successfully"
        });

    } catch (error) {
        console.error('Trending posts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * EXAMPLE 5: Post Creation with Cache Invalidation
 * Original: src/controllers/post.controllers.js
 */
export const createPostWithCacheInvalidation = async (req, res) => {
    try {
        // Create post (original logic)
        const newPost = await createPost(req.body, req.user._id);

        // Invalidate related caches
        await CacheInvalidator.onNewPost(newPost, req.user._id);

        // Additional specific invalidations
        await Promise.all([
            // Invalidate author's followers' feeds
            CacheManager.delPattern(`fn:user:*:feed:*`),
            
            // Invalidate trending content
            CacheManager.delPattern(`fn:posts:trending:*`),
            
            // Invalidate explore feed
            CacheManager.delPattern(`fn:explore:feed:*`),
            
            // Invalidate user's profile cache (post count may change)
            UserCacheManager.invalidateUserProfile(req.user._id)
        ]);

        res.status(201).json({
            success: true,
            data: newPost,
            message: "Post created successfully"
        });

    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * EXAMPLE 6: Follow/Unfollow with Cache Invalidation
 * Original: src/controllers/follower.controllers.js
 */
export const followUserWithCacheInvalidation = async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const userId = req.user._id;

        // Perform follow action (original logic)
        const result = await performFollowAction(userId, targetUserId);

        // Invalidate related caches
        await CacheInvalidator.onFollowAction(userId, targetUserId);

        // Specific cache invalidations
        await Promise.all([
            // Invalidate follower/following lists
            CacheManager.del([
                RedisKeys.userFollowers(targetUserId),
                RedisKeys.userFollowing(userId)
            ]),
            
            // Invalidate user suggestions
            CacheManager.del([
                RedisKeys.userSuggestions(userId),
                RedisKeys.userSuggestions(targetUserId)
            ]),
            
            // Invalidate user's feed (will now include target user's posts)
            FeedCacheManager.invalidateUserFeed(userId)
        ]);

        res.json({
            success: true,
            data: result,
            message: "Follow action completed successfully"
        });

    } catch (error) {
        console.error('Follow error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * MIDDLEWARE INTEGRATION EXAMPLES
 * How to apply caching middleware to existing routes
 */

// Example route definitions with caching middleware
export const exampleRouteIntegrations = {
    
    // Home feed with caching
    homeFeed: [
        feedCacheMiddleware({ ttl: RedisTTL.USER_FEED }),
        getHomeFeedCached
    ],
    
    // Search with caching
    search: [
        searchCacheMiddleware({ ttl: RedisTTL.SEARCH_RESULTS }),
        searchContentCached
    ],
    
    // User profile with caching
    userProfile: [
        profileCacheMiddleware({ ttl: RedisTTL.USER_PROFILE }),
        getUserProfileCached
    ],
    
    // Trending content with caching
    trending: [
        trendingCacheMiddleware({ ttl: RedisTTL.TRENDING_POSTS }),
        getTrendingPostsCached
    ]
};

/**
 * PERFORMANCE MONITORING
 * Add cache hit/miss tracking to monitor effectiveness
 */
export const addCacheMetrics = (req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const cacheStatus = res.get('X-Cache') || 'UNKNOWN';
        
        // Log performance metrics
        console.log(`Cache ${cacheStatus}: ${req.method} ${req.path} - ${duration}ms`);
        
        // Could also send to monitoring service
        // analytics.track('cache_performance', {
        //     cacheStatus,
        //     endpoint: req.path,
        //     duration,
        //     userId: req.user?._id
        // });
    });
    
    next();
};

/**
 * HELPER FUNCTIONS
 * Placeholder functions for the examples above
 */
async function generateHomeFeed(userId, page) {
    // Original home feed generation logic
    return [];
}

async function performSearch(query, page, type) {
    // Original search logic
    return [];
}

async function generateTrendingPosts(location) {
    // Original trending posts logic
    return [];
}

async function createPost(postData, authorId) {
    // Original post creation logic
    return {};
}

async function performFollowAction(userId, targetUserId) {
    // Original follow logic
    return {};
}

/**
 * INTEGRATION CHECKLIST
 * 
 * 1. ✅ Install Redis dependencies (redis, ioredis)
 * 2. ✅ Configure Redis connection (redis.config.js)
 * 3. ✅ Create cache utilities (cache.utils.js)
 * 4. ✅ Create caching middleware (cache.middleware.js)
 * 5. ✅ Create PubSub utilities (pubsub.utils.js)
 * 6. ⏳ Update existing controllers with caching
 * 7. ⏳ Apply middleware to route definitions
 * 8. ⏳ Add cache invalidation to write operations
 * 9. ⏳ Integrate PubSub for real-time features
 * 10. ⏳ Add monitoring and metrics
 * 
 * EXPECTED PERFORMANCE IMPROVEMENTS:
 * - Home Feed: 70-90% faster response time
 * - User Profiles: 60-80% faster response time
 * - Search Results: 60-90% faster response time
 * - Trending Content: 80-95% faster response time
 * - Overall Database Load: 40-70% reduction
 */

export default {
    getHomeFeedCached,
    getUserProfileCached,
    searchContentCached,
    getTrendingPostsCached,
    createPostWithCacheInvalidation,
    followUserWithCacheInvalidation,
    exampleRouteIntegrations,
    addCacheMetrics
};