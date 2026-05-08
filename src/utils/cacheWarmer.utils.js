import Redis from 'ioredis';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Comment from '../models/comment.models.js';

const ENGAGEMENT_TTL  = RedisTTL.POST_ENGAGEMENT;
const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;
const DB = parseInt(process.env.REDIS_DB) || 0;

const LIKES_COUNT_RE    = /^fn:post:([^:]+):likes:count$/;
const COMMENTS_COUNT_RE = /^fn:post:([^:]+):comments:count$/;
const USER_LIKED_RE     = /^fn:user:([^:]+):liked$/;

async function reseedLikeCount(postId) {
    const key = RedisKeys.postLikesCount(postId);

    // A normal request may have already refreshed this key before the (late) expiry event fired.
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] likes:count already present, skipping reseed post=${postId}`);
        return;
    }

    const [row] = await Like.aggregate([
        { $match: { postId: new mongoose.Types.ObjectId(postId) } },
        { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    const count = row?.count ?? 0;

    // NX guards the narrow race between the EXISTS check above and this SET:
    // if a normal request created the key in between, we don't overwrite it.
    const set = await redisClient.set(key, count, 'EX', ENGAGEMENT_TTL, 'NX');
    if (set) {
        console.log(`[CacheWarmer] likes:count re-seeded post=${postId} count=${count}`);
    } else {
        console.log(`[CacheWarmer] likes:count refreshed concurrently, skipping post=${postId}`);
    }
}

async function reseedCommentCount(postId) {
    const key = RedisKeys.postCommentsCount(postId);

    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] comments:count already present, skipping reseed post=${postId}`);
        return;
    }

    const count = await Comment.countDocuments({
        postId: new mongoose.Types.ObjectId(postId),
        parentCommentId: null,
    });

    const set = await redisClient.set(key, count, 'EX', ENGAGEMENT_TTL, 'NX');
    if (set) {
        console.log(`[CacheWarmer] comments:count re-seeded post=${postId} count=${count}`);
    } else {
        console.log(`[CacheWarmer] comments:count refreshed concurrently, skipping post=${postId}`);
    }
}

async function reseedUserLikedSet(userId) {
    const key = RedisKeys.userLikedSet(userId);

    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] liked set already present, skipping reseed user=${userId}`);
        return;
    }

    const likes   = await Like.find({ userId }).select('postId').lean();
    const postIds = likes.map(l => l.postId.toString());

    if (!postIds.length) {
        console.log(`[CacheWarmer] liked set re-seeded user=${userId} posts=0`);
        return;
    }

    // HSETNX equivalent for Sets: use a Lua script to write only if the key
    // still does not exist, closing the race window between EXISTS and SADD.
    const lua = `
        if redis.call("EXISTS", KEYS[1]) == 1 then
            return 0
        end
        redis.call("SADD", KEYS[1], unpack(ARGV, 2))
        redis.call("EXPIRE", KEYS[1], ARGV[1])
        return 1
    `;
    const result = await redisClient.eval(lua, 1, key, LIKE_STATUS_TTL, ...postIds);
    if (result) {
        console.log(`[CacheWarmer] liked set re-seeded user=${userId} posts=${postIds.length}`);
    } else {
        console.log(`[CacheWarmer] liked set refreshed concurrently, skipping user=${userId}`);
    }
}

export function startCacheWarmer() {
    const REDIS_CONFIG = {
        host:     process.env.REDIS_HOST     || 'localhost',
        port:     parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db:       DB,
        enableAutoPipelining: false,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 100, 3000),
    };

    const subscriber = new Redis(REDIS_CONFIG);

    subscriber.on('ready', async () => {
        await subscriber.psubscribe(`__keyevent@${DB}__:expired`);
        console.log('[CacheWarmer] Subscribed to Redis key expiry events');
    });

    subscriber.on('pmessage', (_pattern, _channel, key) => {
        const likesMatch = LIKES_COUNT_RE.exec(key);
        if (likesMatch) {
            reseedLikeCount(likesMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedLikeCount error key=${key}:`, err.message)
            );
            return;
        }

        const commentsMatch = COMMENTS_COUNT_RE.exec(key);
        if (commentsMatch) {
            reseedCommentCount(commentsMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedCommentCount error key=${key}:`, err.message)
            );
            return;
        }

        const likedMatch = USER_LIKED_RE.exec(key);
        if (likedMatch) {
            reseedUserLikedSet(likedMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedUserLikedSet error key=${key}:`, err.message)
            );
        }
    });

    subscriber.on('error', (err) =>
        console.error('[CacheWarmer] subscriber error:', err.message)
    );

    // Expose quit so graceful shutdown can close this connection
    return subscriber;
}
