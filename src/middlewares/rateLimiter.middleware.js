import rateLimit from 'express-rate-limit';
import { redisClient } from '../config/redis.config.js';

/**
 * Custom Redis store for express-rate-limit using existing ioredis client
 * This avoids IPv6 issues by using our already-configured Redis connection
 */
class RedisStore {
    constructor(options = {}) {
        this.client = options.client || redisClient;
        this.prefix = options.prefix || 'rl:';
        this.resetExpiryOnChange = options.resetExpiryOnChange ?? false;
    }

    async increment(key) {
        const prefixedKey = this.prefix + key;

        try {
            // Increment and get the new value
            const current = await this.client.incr(prefixedKey);

            // Set expiry on first increment
            if (current === 1) {
                await this.client.expire(prefixedKey, Math.ceil(this.windowMs / 1000));
            }

            // Get TTL
            const ttl = await this.client.pttl(prefixedKey);

            return {
                totalHits: current,
                resetTime: new Date(Date.now() + ttl)
            };
        } catch (error) {
            console.error('Redis rate limit increment error:', error);
            // Return undefined to fall back to allowing the request
            return undefined;
        }
    }

    async decrement(key) {
        const prefixedKey = this.prefix + key;

        try {
            const current = await this.client.decr(prefixedKey);
            return Math.max(0, current);
        } catch (error) {
            console.error('Redis rate limit decrement error:', error);
        }
    }

    async resetKey(key) {
        const prefixedKey = this.prefix + key;

        try {
            await this.client.del(prefixedKey);
        } catch (error) {
            console.error('Redis rate limit reset error:', error);
        }
    }

    init(options) {
        this.windowMs = options.windowMs;
    }
}

// General rate limiter for most endpoints
export const generalRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 50000, // 50000 requests per minute per user/IP (increased for high-traffic usage)
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: 60 // 60 seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for OPTIONS requests (CORS preflight)
    skip: (req) => req.method === 'OPTIONS',
    // In development, don't trust proxy headers for rate limiting
    trustProxy: process.env.NODE_ENV === 'production',
    // Use custom Redis store
    store: new RedisStore({ prefix: 'rl:general:' })
});

// Rate limiter for notification endpoints
export const notificationRateLimit = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    max: 10000, // 10000 requests per 30 seconds per user (increased for high polling frequency)
    message: {
        error: 'Too many notification requests, please try again later.',
        retryAfter: 30
    },
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: process.env.NODE_ENV === 'production',
    store: new RedisStore({ prefix: 'rl:notif:' })
});

// Rate limiter for unread counts endpoint
export const unreadCountsRateLimit = rateLimit({
    windowMs: 10 * 1000, // 10 seconds
    max: 5000, // 5000 requests per 10 seconds per user (increased to accommodate polling patterns)
    message: {
        error: 'Too many unread count requests. Consider using WebSocket events instead of polling.',
        retryAfter: 10,
        suggestion: 'Use real-time Socket.IO events for live updates instead of frequent API calls.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: process.env.NODE_ENV === 'production',
    store: new RedisStore({ prefix: 'rl:unread:' })
});

// Rate limiter for chat endpoints
export const chatRateLimit = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    max: 20000, // 20000 requests per 30 seconds per user (increased for active chat usage)
    message: {
        error: 'Too many chat requests, please try again later.',
        retryAfter: 30
    },
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: process.env.NODE_ENV === 'production',
    store: new RedisStore({ prefix: 'rl:chat:' })
});

// Health check rate limiter (more lenient)
export const healthCheckRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10000, // 10000 health checks per minute per user/IP (increased limit)
    message: {
        error: 'Too many health check requests.',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for OPTIONS requests (CORS preflight)
    skip: (req) => req.method === 'OPTIONS',
    trustProxy: process.env.NODE_ENV === 'production',
    store: new RedisStore({ prefix: 'rl:health:' })
});