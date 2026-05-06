import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Redis Configuration
const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,

    // Connection options
    connectTimeout: 10000,
    commandTimeout: 5000,
    lazyConnect: false, // ✅ FIXED: Connect immediately instead of waiting for first command

    // Pool settings optimized for limited connections
    family: 4,
    keepAlive: true,
    maxLoadingTimeout: 10000,

    // Connection pooling to limit connections
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,

    // Error handling
    enableOfflineQueue: true,

    // Retry configuration
    retryDelayOnFailover: 1000,
    retryDelayOnClusterDown: 300,
    maxRetriesPerRequest: 3,

    // Reconnection settings
    reconnectOnError: (err) => {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
    },

    // Better timeout handling
    socketTimeout: 30000,

    // Retry strategy
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
};

// Create Redis instances for this process
const createRedisInstance = () => new Redis(REDIS_CONFIG);

// Primary Redis instance for caching and general operations
export const redisClient = createRedisInstance();

// Socket.IO Redis adapter requires dedicated pub/sub instances
const PUBSUB_CONFIG = {
    ...REDIS_CONFIG,
    enableOfflineQueue: true,
    lazyConnect: false,
    enableAutoPipelining: false // Disable for subscriber
};

const PUBLISHER_CONFIG = {
    ...REDIS_CONFIG,
    enableOfflineQueue: true,
    lazyConnect: false,
    enableAutoPipelining: true // Enable for publisher
};

// Socket.IO Redis adapter connections (handles all pub/sub needs)
export const redisPubSub = new Redis(PUBSUB_CONFIG);
export const redisPublisher = new Redis(PUBLISHER_CONFIG);

// Removed: redisAppSubscriber and redisAppPublisher (use Socket.IO adapter instead)

// Redis connection event handlers
redisClient.on('connect', () => {
    console.log('🔄 Redis Client connecting...');
});

redisClient.on('ready', () => {
    console.log('✅ Redis Client ready');
});

redisClient.on('error', (err) => {
    console.error('❌ Redis Client Error:', err);
});

redisClient.on('close', () => {
    console.warn('⚠️ Redis Client connection closed');
});

// PubSub Redis event handlers
redisPubSub.on('connect', () => {
    console.log('🔄 Redis PubSub connecting...');
});

redisPubSub.on('ready', () => {
    console.log('✅ Redis PubSub ready');
});

redisPubSub.on('error', (err) => {
    console.error('❌ Redis PubSub Error:', err);
});

// Publisher Redis event handlers
redisPublisher.on('connect', () => {
    console.log('🔄 Redis Publisher connecting...');
});

redisPublisher.on('ready', () => {
    console.log('✅ Redis Publisher ready');
});

redisPublisher.on('error', (err) => {
    console.error('❌ Redis Publisher Error:', err);
});


// Graceful shutdown
process.on('SIGINT', async () => {
    await redisClient.quit();
    await redisPubSub.quit();
    await redisPublisher.quit();
    process.exit(0);
});

// Health check function
export const redisHealthCheck = async () => {
    try {
        const pong = await redisClient.ping();
        return pong === 'PONG';
    } catch (error) {
        console.error('Redis health check failed:', error);
        return false;
    }
};

// Max entries kept in the followers/following Redis LIST per user
export const FOLLOW_LIST_MAX = 15;

// Key generation utilities
export const RedisKeys = {
    // User data keys
    userProfile: (userId) => `fn:user:${userId}:profile`,
    userFeed: (userId, page = 1) => `fn:user:${userId}:feed:p${page}`,
    userFollowers: (userId) => `fn:user:${userId}:followers`,
    userFollowing: (userId) => `fn:user:${userId}:following`,
    userNotifications: (userId) => `fn:user:${userId}:notifications`,
    
    // Post data keys
    postDetails: (postId) => `fn:post:${postId}:details`,
    postStats: (postId) => `fn:post:${postId}:stats`,
    trendingPosts: (location = 'global') => `fn:posts:trending:${location}`,
    
    // Search and exploration
    searchResults: (query, page = 1) => {
        const queryHash = Buffer.from(query).toString('base64').slice(0, 16);
        return `fn:search:${queryHash}:p${page}`;
    },
    exploreFeed: (page = 1) => `fn:explore:feed:p${page}`,
    userSuggestions: (userId) => `fn:suggestions:user:${userId}`,
    
    // Business and products
    businessProfile: (businessId) => `fn:business:${businessId}:profile`,
    businessProducts: (businessId) => `fn:business:${businessId}:products`,
    productDetails: (productId) => `fn:product:${productId}:details`,
    categories: () => 'fn:categories:all',
    
    // Authentication and sessions
    userSession: (userId, deviceId) => `fn:session:${userId}:${deviceId}`,
    tokenBlacklist: (jti) => `fn:auth:blacklist:${jti}`,
    authRateLimit: (ip) => `fn:auth:rate:${ip}`,
    
    // Follow counts (real-time counters, updated on every follow/unfollow)
    userFollowersCount: (userId) => `fn:user:${userId}:followers:count`,
    userFollowingCount: (userId) => `fn:user:${userId}:following:count`,

    // Post engagement counters
    postLikesCount: (postId) => `fn:post:${postId}:likes:count`,
    postCommentsCount: (postId) => `fn:post:${postId}:comments:count`,

    // Universal default search page (no query — browse mode)
    defaultResults: () => 'fn:default:results',
    defaultNewPosts: () => 'fn:default:new_posts', // Redis LIST of recently published postIds

    userFollowingStatus: (userId) => `fn:user:${userId}:following:status`,

    postLikedBy: (postId) => `fn:post:${postId}:likedby`,

    userLikedSet: (userId) => `fn:user:${userId}:liked`,

    // Real-time features
    chatMessages: (chatId, page = 1) => `fn:chat:${chatId}:messages:p${page}`,
    onlineUsers: () => 'fn:live:online_users',
    tempUpload: (userId) => `fn:temp:upload:${userId}`,
};

export const RedisTTL = {
    // Real-time data (short TTL)
    USER_FEED: 5 * 60,              // 5 minutes
    NOTIFICATIONS: 2 * 60,          // 2 minutes  
    CHAT_MESSAGES: 1 * 60,          // 1 minute
    TRENDING_POSTS: 5 * 60,         // 5 minutes
    
    // Semi-static data (medium TTL)
    USER_PROFILE: 1 * 60 * 60,      // 1 hour
    POST_DETAILS: 30 * 60,          // 30 minutes
    SEARCH_RESULTS: 15 * 60,        // 15 minutes
    BUSINESS_PROFILE: 2 * 60 * 60,  // 2 hours
    
    // Static data (long TTL)
    USER_FOLLOWERS: 4 * 60 * 60,    // 4 hours
    PRODUCT_CATALOG: 12 * 60 * 60,  // 12 hours
    CATEGORIES: 24 * 60 * 60,       // 24 hours
    
    // Authentication (custom TTL)
    USER_SESSION: 30 * 24 * 60 * 60, // 30 days
    TOKEN_BLACKLIST: 24 * 60 * 60,   // 24 hours
    RATE_LIMIT: 15 * 60,             // 15 minutes
    
    // Follow counters (long-lived, updated in-place on follow/unfollow)
    FOLLOW_COUNT: 7 * 24 * 60 * 60,  // 7 days

    // Followers/following LISTs (top-15 newest IDs, rebuilt by cron or on expiry)
    FOLLOW_LIST: 12 * 24 * 60 * 60,  // 12 days

    // Post engagement counters + per-user like status Set
    POST_ENGAGEMENT: 7 * 24 * 60 * 60,  // 7 days
    POST_LIKE_STATUS: 7 * 24 * 60 * 60, // 7 days

    // Per-user follow status Set
    FOLLOW_STATUS: 7 * 24 * 60 * 60, // 7 days

    // Universal default search snapshot (safety TTL; explicit invalidation preferred)
    DEFAULT_RESULTS: 24 * 60 * 60, // 24 hours

    // Temporary data
    TEMP_UPLOAD: 10 * 60,            // 10 minutes
    PASSWORD_RESET: 15 * 60,         // 15 minutes
};

export default redisClient;