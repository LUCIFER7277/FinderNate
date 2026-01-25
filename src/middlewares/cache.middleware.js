import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';

// Re-export redisClient for controllers that need direct access
export { redisClient };

// Generic Redis caching middleware
export const cacheMiddleware = (keyGenerator, ttl = RedisTTL.USER_FEED) => {
    return async (req, res, next) => {
        try {
            const cacheKey = typeof keyGenerator === 'function' 
                ? keyGenerator(req) 
                : keyGenerator;
            
            // Try to get data from cache
            const cachedData = await redisClient.get(cacheKey);
            
            if (cachedData) {
                // Cache hit - return cached data
                return res.status(200).json(JSON.parse(cachedData));
            }
            
            // Cache miss - continue to controller
            // Store cache info in res.locals for controller to use
            res.locals.cacheKey = cacheKey;
            res.locals.cacheTTL = ttl;
            
            next();
        } catch (error) {
            // If Redis is down, just continue without caching
            console.error('Cache middleware error:', error);
            next();
        }
    };
};

// Helper function for controllers to set cache
export const setCache = async (key, data, ttl = RedisTTL.USER_FEED) => {
    try {
        await redisClient.setex(key, ttl, JSON.stringify(data));
    } catch (error) {
        console.error('Failed to set cache:', error);
    }
};

// Helper function to invalidate cache patterns
export const invalidateCache = async (pattern) => {
    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
    } catch (error) {
        console.error('Failed to invalidate cache:', error);
    }
};



export const cacheUserFeed = cacheMiddleware(
    (req) => RedisKeys.userFeed(req.user?.id, req.query.page || 1),
    RedisTTL.USER_FEED
);

export const cacheTrendingPosts = cacheMiddleware(
    (req) => RedisKeys.trendingPosts(req.query.location || 'global'),
    RedisTTL.TRENDING_POSTS
);

export const cacheSearchResults = cacheMiddleware(
    (req) => RedisKeys.searchResults(req.query.q || req.query.query, req.query.page || 1),
    RedisTTL.SEARCH_RESULTS
);

export const cacheBusinessProfile = cacheMiddleware(
    (req) => RedisKeys.businessProfile(req.params.businessId),
    RedisTTL.BUSINESS_PROFILE
);