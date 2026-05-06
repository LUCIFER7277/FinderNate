import { redisClient, RedisKeys, RedisTTL, FOLLOW_LIST_MAX } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';

const FOLLOW_STATUS_TTL = RedisTTL.FOLLOW_STATUS;
const COUNT_TTL         = RedisTTL.FOLLOW_COUNT;
const LIST_TTL          = RedisTTL.FOLLOW_LIST;

// Atomically increment/decrement both count keys inside a single Lua call
// so no other command can run between the two operations.
const INCR_PAIR_SCRIPT = `
local fc  = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
local fgc = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return {fc, fgc}
`;

const DECR_PAIR_SCRIPT = `
local fc  = redis.call('DECR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
local fgc = redis.call('DECR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return {fc, fgc}
`;

// ── Count helpers ──────────────────────────────────────────────────────────

export async function getFollowersCount(userId) {
    const key = RedisKeys.userFollowersCount(userId);
    try {
        const val = await redisClient.get(key);
        if (val !== null) return parseInt(val, 10);
        const count = await Follower.countDocuments({ userId });
        await redisClient.set(key, count, 'EX', COUNT_TTL);
        return count;
    } catch (err) {
        console.error(`[FollowCount] getFollowersCount(${userId}):`, err.message);
        return Follower.countDocuments({ userId }).catch(() => 0);
    }
}

export async function getFollowingCount(userId) {
    const key = RedisKeys.userFollowingCount(userId);
    try {
        const val = await redisClient.get(key);
        if (val !== null) return parseInt(val, 10);
        const count = await Follower.countDocuments({ followerId: userId });
        await redisClient.set(key, count, 'EX', COUNT_TTL);
        return count;
    } catch (err) {
        console.error(`[FollowCount] getFollowingCount(${userId}):`, err.message);
        return Follower.countDocuments({ followerId: userId }).catch(() => 0);
    }
}

// ── Follow status ──────────────────────────────────────────────────────────

/**
 * Check if followerId is following targetUserId.
 * Key exists → SISMEMBER is authoritative (write-through keeps it current).
 * Key missing → seed full following SET from DB, then check.
 */
export async function getFollowStatus(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr   = targetUserId.toString();
    const setKey        = RedisKeys.userFollowingStatus(followerIdStr);
    try {
        const [[, exists], [, isMember]] = await redisClient.pipeline()
            .exists(setKey)
            .sismember(setKey, targetIdStr)
            .exec();

        if (!exists) {
            const allFollowing = await Follower.find({ followerId }).select('userId').lean();
            const ids = allFollowing.map(f => f.userId.toString());
            if (ids.length) {
                await redisClient.pipeline()
                    .sadd(setKey, ...ids)
                    .expire(setKey, FOLLOW_STATUS_TTL)
                    .exec();
            }
            return ids.includes(targetIdStr);
        }

        return isMember === 1;
    } catch {
        return !!(await Follower.findOne({ userId: targetUserId, followerId }));
    }
}

// ── onUserFollowed — write-through ─────────────────────────────────────────

/**
 * Call when A follows B (public account or approved request).
 *
 * Write-through: DB write is synchronous and immediate.
 * Redis updates: following status SET, followers/following Sorted Sets (score=now),
 * and atomic INCR of both count keys.
 *
 * Sorted Sets keep the newest FOLLOW_LIST_MAX entries (ZREMRANGEBYRANK trims oldest).
 *
 * Returns { ok: true, followersCount, followingCount } on success,
 *         { ok: false } if either DB or Redis fails.
 */
export async function onUserFollowed(followerId, targetUserId) {
    const followerIdStr     = followerId.toString();
    const targetIdStr       = targetUserId.toString();
    const followingStatusKey = RedisKeys.userFollowingStatus(followerIdStr);
    const followersZSetKey   = RedisKeys.userFollowers(targetIdStr);
    const followingZSetKey   = RedisKeys.userFollowing(followerIdStr);
    const followersCountKey  = RedisKeys.userFollowersCount(targetIdStr);
    const followingCountKey  = RedisKeys.userFollowingCount(followerIdStr);

    try {
        // Pre-seed count keys from DB before the write so INCR starts from correct base.
        const [followersVal, followingVal] = await redisClient.mget(followersCountKey, followingCountKey);
        if (followersVal === null || followingVal === null) {
            const seeds = [];
            if (followersVal === null) {
                seeds.push(
                    Follower.countDocuments({ userId: targetUserId })
                        .then(n => redisClient.set(followersCountKey, n, 'EX', COUNT_TTL))
                );
            }
            if (followingVal === null) {
                seeds.push(
                    Follower.countDocuments({ followerId })
                        .then(n => redisClient.set(followingCountKey, n, 'EX', COUNT_TTL))
                );
            }
            await Promise.all(seeds);
        }

        // Write-through: DB first, idempotent upsert
        await Follower.updateOne(
            { userId: targetUserId, followerId },
            { $setOnInsert: { userId: targetUserId, followerId } },
            { upsert: true }
        );

        // Redis: status SET + Sorted Sets (trim to FOLLOW_LIST_MAX newest)
        const now = Date.now();
        const pipeline = redisClient.pipeline();

        pipeline.sadd(followingStatusKey, targetIdStr);
        pipeline.expire(followingStatusKey, FOLLOW_STATUS_TTL);

        pipeline.zadd(followersZSetKey, now, followerIdStr);
        pipeline.zremrangebyrank(followersZSetKey, 0, -(FOLLOW_LIST_MAX + 1));
        pipeline.expire(followersZSetKey, LIST_TTL);

        pipeline.zadd(followingZSetKey, now, targetIdStr);
        pipeline.zremrangebyrank(followingZSetKey, 0, -(FOLLOW_LIST_MAX + 1));
        pipeline.expire(followingZSetKey, LIST_TTL);

        await pipeline.exec();

        // Atomic INCR of both count keys via Lua
        const [followersCount, followingCount] = await redisClient.eval(
            INCR_PAIR_SCRIPT, 2,
            followersCountKey, followingCountKey,
            String(COUNT_TTL)
        );

        return { ok: true, followersCount, followingCount };
    } catch (err) {
        console.error('[FollowEngagement] onUserFollowed error:', err.message);
        return { ok: false };
    }
}

// ── onUserUnfollowed — write-through ───────────────────────────────────────

/**
 * Call when A unfollows B.
 *
 * Write-through: DB delete is synchronous and immediate.
 * Redis cleanup: SREM from status SET, ZREM from Sorted Sets, atomic DECR counts.
 *
 * Returns { ok: true, followersCount, followingCount } on success,
 *         { ok: false } if either fails.
 */
export async function onUserUnfollowed(followerId, targetUserId) {
    const followerIdStr     = followerId.toString();
    const targetIdStr       = targetUserId.toString();
    const followingStatusKey = RedisKeys.userFollowingStatus(followerIdStr);
    const followersZSetKey   = RedisKeys.userFollowers(targetIdStr);
    const followingZSetKey   = RedisKeys.userFollowing(followerIdStr);
    const followersCountKey  = RedisKeys.userFollowersCount(targetIdStr);
    const followingCountKey  = RedisKeys.userFollowingCount(followerIdStr);

    try {
        // Pre-seed count keys before DB delete so DECR starts from correct base.
        const [followersVal, followingVal] = await redisClient.mget(followersCountKey, followingCountKey);
        if (followersVal === null || followingVal === null) {
            const seeds = [];
            if (followersVal === null) {
                seeds.push(
                    Follower.countDocuments({ userId: targetUserId })
                        .then(n => redisClient.set(followersCountKey, n, 'EX', COUNT_TTL))
                );
            }
            if (followingVal === null) {
                seeds.push(
                    Follower.countDocuments({ followerId })
                        .then(n => redisClient.set(followingCountKey, n, 'EX', COUNT_TTL))
                );
            }
            await Promise.all(seeds);
        }

        // Write-through: DB delete first
        await Follower.findOneAndDelete({ userId: targetUserId, followerId });

        // Redis cleanup
        const pipeline = redisClient.pipeline();
        pipeline.srem(followingStatusKey, targetIdStr);
        pipeline.expire(followingStatusKey, FOLLOW_STATUS_TTL);
        pipeline.zrem(followersZSetKey, followerIdStr);
        pipeline.zrem(followingZSetKey, targetIdStr);
        await pipeline.exec();

        // Atomic DECR
        let [followersCount, followingCount] = await redisClient.eval(
            DECR_PAIR_SCRIPT, 2,
            followersCountKey, followingCountKey,
            String(COUNT_TTL)
        );

        if (followersCount < 0) {
            followersCount = 0;
            redisClient.set(followersCountKey, 0, 'EX', COUNT_TTL).catch(() => {});
        }
        if (followingCount < 0) {
            followingCount = 0;
            redisClient.set(followingCountKey, 0, 'EX', COUNT_TTL).catch(() => {});
        }

        return { ok: true, followersCount, followingCount };
    } catch (err) {
        console.error('[FollowEngagement] onUserUnfollowed error:', err.message);
        return { ok: false };
    }
}
