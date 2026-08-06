import { redisClient, RedisKeys, RedisTTL, FOLLOW_LIST_MAX } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';
import FollowRequest from '../models/followRequest.models.js';

const FOLLOW_STATUS_TTL = RedisTTL.FOLLOW_STATUS;
const COUNT_TTL         = RedisTTL.FOLLOW_COUNT;
const LIST_TTL          = RedisTTL.FOLLOW_LIST;

/**
 * Add one id to the viewer's following-status SET, but ONLY if that set has
 * already been built. Never create it.
 *
 * getFollowingIdSet treats the key's mere existence as "this is the complete
 * list" — it returns SMEMBERS without consulting MongoDB. A plain SADD onto an
 * expired/absent key therefore does not add one entry to a cache, it REPLACES
 * the entire cached following list with a single id, and every other account the
 * viewer follows begins reporting isFollowing:false. The home feed reads this
 * set; the profile page reads MongoDB; so the two disagree and the feed shows a
 * "Follow" pill for somebody whose profile shows "Unfollow".
 *
 * EXISTS and SADD must be one atomic step: between a JS-side check and the write
 * the key can expire, which is the very case that corrupts it.
 *
 * Skipping the write is always safe. The Follower row is committed to MongoDB
 * before this runs, so the next read finds no key and rebuilds the full, correct
 * set from the database.
 */
const ADD_TO_FOLLOWING_STATUS_IF_BUILT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

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

/**
 * Bulk counterpart to getFollowStatus.
 *
 * Feeds need the follow state of every author on the page. Calling
 * getFollowStatus once per post costs one Redis round-trip per post; this
 * returns the viewer's whole following SET in one, so a feed can answer
 * `isFollowing` with a Set.has() per post.
 *
 * Same seeding contract as getFollowStatus: key present → authoritative,
 * key missing → seed from DB and cache.
 */
export async function getFollowingIdSet(followerId) {
    if (!followerId) return new Set();
    const setKey = RedisKeys.userFollowingStatus(followerId.toString());
    try {
        const [[, exists], [, members]] = await redisClient.pipeline()
            .exists(setKey)
            .smembers(setKey)
            .exec();

        if (exists) return new Set(members);

        const allFollowing = await Follower.find({ followerId }).select('userId').lean();
        const ids = allFollowing.map(f => f.userId.toString());
        if (ids.length) {
            await redisClient.pipeline()
                .sadd(setKey, ...ids)
                .expire(setKey, FOLLOW_STATUS_TTL)
                .exec();
        }
        return new Set(ids);
    } catch {
        try {
            const rows = await Follower.find({ followerId }).select('userId').lean();
            return new Set(rows.map(f => f.userId.toString()));
        } catch {
            return new Set();
        }
    }
}

/**
 * Recipients of the viewer's still-pending follow requests (private accounts).
 *
 * Without this a viewer who requested a private account sees a plain "Follow"
 * pill again on the next refresh, and tapping it fails with
 * "Follow request already sent".
 */
export async function getPendingFollowRequestIdSet(requesterId) {
    if (!requesterId) return new Set();
    try {
        const rows = await FollowRequest.find({ requesterId, status: 'pending' })
            .select('recipientId')
            .lean();
        return new Set(rows.map(r => r.recipientId.toString()));
    } catch (err) {
        console.error('[FollowEngagement] getPendingFollowRequestIdSet:', err.message);
        return new Set();
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

        // NOT an unconditional SADD — see ADD_TO_FOLLOWING_STATUS_IF_BUILT.
        //
        // getFollowingIdSet's contract is "key present → authoritative". A plain
        // SADD on a key that has expired CREATES it holding this one id, so the
        // whole of the viewer's following list silently becomes that single
        // entry: everyone else they follow starts reading back as not-followed.
        // That is the "profile says Unfollow, feed says Follow" split, because
        // the profile asks MongoDB and the feed asks this set.
        //
        // When the key is absent we deliberately write nothing. The DB row is
        // already committed above, so the next read misses, rebuilds the FULL
        // set from Mongo, and is correct.
        await redisClient.eval(
            ADD_TO_FOLLOWING_STATUS_IF_BUILT, 1,
            followingStatusKey, targetIdStr, String(FOLLOW_STATUS_TTL)
        );

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
