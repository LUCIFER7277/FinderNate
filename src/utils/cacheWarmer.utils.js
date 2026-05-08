import Redis from 'ioredis';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { redisClient, RedisKeys, RedisTTL, FOLLOW_LIST_MAX } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Comment from '../models/comment.models.js';
import Follower from '../models/follower.models.js';
import { User } from '../models/user.models.js';

const ENGAGEMENT_TTL  = RedisTTL.POST_ENGAGEMENT;
const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;
const COUNT_TTL       = RedisTTL.FOLLOW_COUNT;
const LIST_TTL        = RedisTTL.FOLLOW_LIST;
const STATUS_TTL      = RedisTTL.FOLLOW_STATUS;
const MAX_LIKEDBY     = 50;
const DB = parseInt(process.env.REDIS_DB) || 0;

const LIKES_COUNT_RE    = /^fn:post:([^:]+):likes:count$/;
const COMMENTS_COUNT_RE = /^fn:post:([^:]+):comments:count$/;
const USER_LIKED_RE     = /^fn:user:([^:]+):liked$/;
const LIKEDBY_RE        = /^fn:post:([^:]+):likedby$/;
const FOLLOWERS_ZSET_RE = /^fn:user:([^:]+):followers$/;
const FOLLOWING_ZSET_RE = /^fn:user:([^:]+):following$/;
const FOLLOWERS_CNT_RE  = /^fn:user:([^:]+):followers:count$/;
const FOLLOWING_CNT_RE  = /^fn:user:([^:]+):following:count$/;
const FOLLOW_STATUS_RE  = /^fn:user:([^:]+):following:status$/;

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

async function reseedLikedByHash(postId) {
    const key = RedisKeys.postLikedBy(postId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] likedby already present, skipping reseed post=${postId}`);
        return;
    }

    const postOid = new mongoose.Types.ObjectId(postId);
    const dbLikes = await Like.find({ postId: postOid })
        .select('userId createdAt')
        .sort({ createdAt: -1 })
        .lean();

    if (!dbLikes.length) return;

    const userIds = [...new Set(dbLikes.map(l => l.userId.toString()))];
    const profiles = await User.find({ _id: { $in: userIds } }, 'username fullName profileImageUrl').lean();
    const profileMap = new Map(profiles.map(u => [u._id.toString(), u]));

    const lua = `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
        for i = 1, #ARGV - 1, 2 do
            redis.call("HSET", KEYS[1], ARGV[i], ARGV[i+1])
        end
        redis.call("EXPIRE", KEYS[1], ARGV[#ARGV])
        return 1
    `;
    const args = [key];
    let count = 0;
    for (const l of dbLikes.slice(0, MAX_LIKEDBY)) {
        const uid = l.userId.toString();
        const p = profileMap.get(uid);
        if (!p) continue;
        args.push(uid, JSON.stringify({
            _id: uid, userId: uid,
            username: p.username, fullName: p.fullName,
            profileImageUrl: p.profileImageUrl,
            likedAt: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
        }));
        count++;
    }
    if (!count) return;
    args.push(String(ENGAGEMENT_TTL));
    const result = await redisClient.eval(lua, 1, ...args);
    console.log(result
        ? `[CacheWarmer] likedby re-seeded post=${postId} users=${count}`
        : `[CacheWarmer] likedby refreshed concurrently, skipping post=${postId}`
    );
}

async function reseedFollowersZSet(userId) {
    const key = RedisKeys.userFollowers(userId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] followers ZSet already present, skipping reseed user=${userId}`);
        return;
    }

    const rows = await Follower.find({ userId })
        .sort({ createdAt: -1 })
        .limit(FOLLOW_LIST_MAX)
        .select('followerId createdAt')
        .lean();

    if (!rows.length) return;

    const lua = `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
        for i = 1, #ARGV - 1, 2 do
            redis.call("ZADD", KEYS[1], ARGV[i], ARGV[i+1])
        end
        redis.call("EXPIRE", KEYS[1], ARGV[#ARGV])
        return 1
    `;
    const args = [key];
    for (const r of rows) {
        args.push(String(r.createdAt ? new Date(r.createdAt).getTime() : Date.now()), r.followerId.toString());
    }
    args.push(String(LIST_TTL));
    const result = await redisClient.eval(lua, 1, ...args);
    console.log(result
        ? `[CacheWarmer] followers ZSet re-seeded user=${userId} count=${rows.length}`
        : `[CacheWarmer] followers ZSet refreshed concurrently, skipping user=${userId}`
    );
}

async function reseedFollowingZSet(userId) {
    const key = RedisKeys.userFollowing(userId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] following ZSet already present, skipping reseed user=${userId}`);
        return;
    }

    const rows = await Follower.find({ followerId: userId })
        .sort({ createdAt: -1 })
        .limit(FOLLOW_LIST_MAX)
        .select('userId createdAt')
        .lean();

    if (!rows.length) return;

    const lua = `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
        for i = 1, #ARGV - 1, 2 do
            redis.call("ZADD", KEYS[1], ARGV[i], ARGV[i+1])
        end
        redis.call("EXPIRE", KEYS[1], ARGV[#ARGV])
        return 1
    `;
    const args = [key];
    for (const r of rows) {
        args.push(String(r.createdAt ? new Date(r.createdAt).getTime() : Date.now()), r.userId.toString());
    }
    args.push(String(LIST_TTL));
    const result = await redisClient.eval(lua, 1, ...args);
    console.log(result
        ? `[CacheWarmer] following ZSet re-seeded user=${userId} count=${rows.length}`
        : `[CacheWarmer] following ZSet refreshed concurrently, skipping user=${userId}`
    );
}

async function reseedFollowersCount(userId) {
    const key = RedisKeys.userFollowersCount(userId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] followers:count already present, skipping reseed user=${userId}`);
        return;
    }

    const count = await Follower.countDocuments({ userId });
    const set = await redisClient.set(key, count, 'EX', COUNT_TTL, 'NX');
    console.log(set
        ? `[CacheWarmer] followers:count re-seeded user=${userId} count=${count}`
        : `[CacheWarmer] followers:count refreshed concurrently, skipping user=${userId}`
    );
}

async function reseedFollowingCount(userId) {
    const key = RedisKeys.userFollowingCount(userId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] following:count already present, skipping reseed user=${userId}`);
        return;
    }

    const count = await Follower.countDocuments({ followerId: userId });
    const set = await redisClient.set(key, count, 'EX', COUNT_TTL, 'NX');
    console.log(set
        ? `[CacheWarmer] following:count re-seeded user=${userId} count=${count}`
        : `[CacheWarmer] following:count refreshed concurrently, skipping user=${userId}`
    );
}

async function reseedFollowingStatus(userId) {
    const key = RedisKeys.userFollowingStatus(userId);
    const exists = await redisClient.exists(key);
    if (exists) {
        console.log(`[CacheWarmer] following:status already present, skipping reseed user=${userId}`);
        return;
    }

    const rows = await Follower.find({ followerId: userId }).select('userId').lean();
    const ids = rows.map(r => r.userId.toString());
    if (!ids.length) return;

    const lua = `
        if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
        redis.call("SADD", KEYS[1], unpack(ARGV, 2))
        redis.call("EXPIRE", KEYS[1], ARGV[1])
        return 1
    `;
    const result = await redisClient.eval(lua, 1, key, String(STATUS_TTL), ...ids);
    console.log(result
        ? `[CacheWarmer] following:status re-seeded user=${userId} count=${ids.length}`
        : `[CacheWarmer] following:status refreshed concurrently, skipping user=${userId}`
    );
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
            return;
        }

        const likedByMatch = LIKEDBY_RE.exec(key);
        if (likedByMatch) {
            reseedLikedByHash(likedByMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedLikedByHash error key=${key}:`, err.message)
            );
            return;
        }

        const followersCntMatch = FOLLOWERS_CNT_RE.exec(key);
        if (followersCntMatch) {
            reseedFollowersCount(followersCntMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedFollowersCount error key=${key}:`, err.message)
            );
            return;
        }

        const followingCntMatch = FOLLOWING_CNT_RE.exec(key);
        if (followingCntMatch) {
            reseedFollowingCount(followingCntMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedFollowingCount error key=${key}:`, err.message)
            );
            return;
        }

        const followStatusMatch = FOLLOW_STATUS_RE.exec(key);
        if (followStatusMatch) {
            reseedFollowingStatus(followStatusMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedFollowingStatus error key=${key}:`, err.message)
            );
            return;
        }

        const followersZSetMatch = FOLLOWERS_ZSET_RE.exec(key);
        if (followersZSetMatch) {
            reseedFollowersZSet(followersZSetMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedFollowersZSet error key=${key}:`, err.message)
            );
            return;
        }

        const followingZSetMatch = FOLLOWING_ZSET_RE.exec(key);
        if (followingZSetMatch) {
            reseedFollowingZSet(followingZSetMatch[1]).catch(err =>
                console.error(`[CacheWarmer] reseedFollowingZSet error key=${key}:`, err.message)
            );
        }
    });

    subscriber.on('error', (err) =>
        console.error('[CacheWarmer] subscriber error:', err.message)
    );

    // Expose quit so graceful shutdown can close this connection
    return subscriber;
}
