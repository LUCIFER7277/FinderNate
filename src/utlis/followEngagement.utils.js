import { redisClient, RedisKeys, RedisTTL, FOLLOW_LIST_MAX } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';

const FOLLOW_STATUS_TTL = RedisTTL.FOLLOW_STATUS;
const COUNT_TTL = RedisTTL.FOLLOW_COUNT;

const LIST_TTL = 12 * 24 * 60 * 60;   // 12 days
const TEMP_TTL = 3 * 60 * 60;          // 3h safety TTL on temp SET
const TEMP_ACTIVE_TTL = 25 * 60 * 60;  // 25h


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

/**
 * Get followers count — Redis first, DB fallback with automatic seeding.
 */
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

/**
 * Get following count — Redis first, DB fallback with automatic seeding.
 */
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

/**
 * Check if followerId is following targetUserId.
 * Redis-first: '1'→following, '0'→not following, null→DB fallback.
 * If Redis is down, reads directly from DB.
 */
export async function getFollowStatus(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    const setKey = RedisKeys.userFollowingStatus(followerIdStr);
    try {
        // Pipeline EXISTS + SISMEMBER so we can distinguish "not cached" (EXISTS=0)
        // from "cached as not-following" (EXISTS=1, SISMEMBER=0).
        const [[, exists], [, isMember]] = await redisClient.pipeline()
            .exists(setKey)
            .sismember(setKey, targetIdStr)
            .exec();
        if (!exists) return !!(await Follower.findOne({ userId: targetUserId, followerId }));
        return isMember === 1;
    } catch {
        return !!(await Follower.findOne({ userId: targetUserId, followerId }));
    }
}

/**
 * Call when A follows B.
 *
 * All Redis writes happen in a single pipeline so they are committed together:
 *   - follow-status key → '1'
 *   - dirty set for 4-hourly DB sync
 *   - B's followers LIST  (lpush + ltrim, newest-first, max 15)
 *   - A's following LIST  (lpush + ltrim, newest-first, max 15)
 *   - B's followers:temp SET   (pending 2h flush to DB)
 *   - A's following:temp SET   (pending 2h flush to DB)
 *   - active-users tracking SET for the cron
 *   - INCR B's followers count
 *   - INCR A's following count
 *
 * Any missing count keys are seeded from DB before the pipeline so INCR
 * always starts from the correct base value.
 *
 * Returns { ok: true, followersCount, followingCount } on success,
 *         { ok: false } if Redis is down.
 */
export async function onUserFollowed(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    const dirtyKey = RedisKeys.followsDirty();
    const followingStatusKey = RedisKeys.userFollowingStatus(followerIdStr);
    const followersListKey = RedisKeys.userFollowers(targetIdStr);
    const followingListKey = RedisKeys.userFollowing(followerIdStr);
    const followersTempKey = RedisKeys.followersTemp(targetIdStr);
    const followingTempKey = RedisKeys.followingTemp(followerIdStr);
    const tempActiveKey = RedisKeys.followTempActiveUsers();
    const followersCountKey = RedisKeys.userFollowersCount(targetIdStr);
    const followingCountKey = RedisKeys.userFollowingCount(followerIdStr);

    try {
        // Pre-seed any missing count keys so INCR gives the correct new value.
        // The follow is not yet in DB (deferred), so DB count is the base to increment from.
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

        const pipeline = redisClient.pipeline();

        // Add targetId to follower's following SET + dirty set for deferred DB sync
        pipeline.sadd(followingStatusKey, targetIdStr);
        pipeline.expire(followingStatusKey, FOLLOW_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${followerIdStr}:${targetIdStr}`);
        pipeline.expire(dirtyKey, 25 * 60 * 60);

        // B's followers LIST — push A to front, trim to 15
        pipeline.lpush(followersListKey, followerIdStr);        // index 3
        pipeline.ltrim(followersListKey, 0, FOLLOW_LIST_MAX - 1);
        pipeline.expire(followersListKey, LIST_TTL);

        // A's following LIST — push B to front, trim to 15
        pipeline.lpush(followingListKey, targetIdStr);          // index 6
        pipeline.ltrim(followingListKey, 0, FOLLOW_LIST_MAX - 1);
        pipeline.expire(followingListKey, LIST_TTL);

        // B's followers:temp SET
        pipeline.sadd(followersTempKey, followerIdStr);
        pipeline.expire(followersTempKey, TEMP_TTL);

        // A's following:temp SET
        pipeline.sadd(followingTempKey, targetIdStr);
        pipeline.expire(followingTempKey, TEMP_TTL);

        // Active-users tracking for the cron
        pipeline.sadd(tempActiveKey, targetIdStr, followerIdStr);
        pipeline.expire(tempActiveKey, TEMP_ACTIVE_TTL);

        await pipeline.exec();

        // Atomically increment both counts via Lua — Redis guarantees no command
        // from any other client can run between the two INCRs inside the script.
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

/**
 * Call when A unfollows B.
 *
 * All Redis writes happen in a single pipeline:
 *   - follow-status key → '0'
 *   - dirty set for 4-hourly DB sync
 *   - remove A from B's followers LIST
 *   - remove B from A's following LIST
 *   - remove A from B's followers:temp SET
 *   - remove B from A's following:temp SET
 *   - DECR B's followers count
 *   - DECR A's following count
 *
 * Count keys are seeded from DB BEFORE the Follower doc is deleted so the
 * base value is correct and DECR gives the right post-unfollow count.
 *
 * Returns { ok: true, followersCount, followingCount } on success,
 *         { ok: false } if Redis is down.
 */
export async function onUserUnfollowed(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    const dirtyKey = RedisKeys.followsDirty();
    const followingStatusKey = RedisKeys.userFollowingStatus(followerIdStr);
    const followersListKey = RedisKeys.userFollowers(targetIdStr);
    const followingListKey = RedisKeys.userFollowing(followerIdStr);
    const followersTempKey = RedisKeys.followersTemp(targetIdStr);
    const followingTempKey = RedisKeys.followingTemp(followerIdStr);
    const followersCountKey = RedisKeys.userFollowersCount(targetIdStr);
    const followingCountKey = RedisKeys.userFollowingCount(followerIdStr);

    try {
        // Pre-seed any missing count keys BEFORE deleting the Follower doc.
        // Edge case: if this follow is still deferred (targetId still in following SET, not in DB yet),
        // DB count doesn't include it. Seed as dbCount+1 so DECR gives dbCount (correct net zero).
        const [followersVal, followingVal] = await redisClient.mget(followersCountKey, followingCountKey);
        if (followersVal === null || followingVal === null) {
            const isDeferred = await redisClient.sismember(followingStatusKey, targetIdStr)
                .catch(() => 0) === 1;

            const seeds = [];
            if (followersVal === null) {
                seeds.push(
                    Follower.countDocuments({ userId: targetUserId })
                        .then(n => redisClient.set(followersCountKey, isDeferred ? n + 1 : n, 'EX', COUNT_TTL))
                );
            }
            if (followingVal === null) {
                seeds.push(
                    Follower.countDocuments({ followerId })
                        .then(n => redisClient.set(followingCountKey, isDeferred ? n + 1 : n, 'EX', COUNT_TTL))
                );
            }
            await Promise.all(seeds);
        }

        const pipeline = redisClient.pipeline();

        // Remove targetId from follower's following SET + dirty set for deferred DB sync
        pipeline.srem(followingStatusKey, targetIdStr);
        pipeline.expire(followingStatusKey, FOLLOW_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${followerIdStr}:${targetIdStr}`);
        pipeline.expire(dirtyKey, 25 * 60 * 60);

        // Remove A from B's followers LIST
        pipeline.lrem(followersListKey, 0, followerIdStr);

        // Remove B from A's following LIST
        pipeline.lrem(followingListKey, 0, targetIdStr);

        // Remove from temp SETs
        pipeline.srem(followersTempKey, followerIdStr);
        pipeline.srem(followingTempKey, targetIdStr);

        await pipeline.exec();

        // Atomically decrement both counts via Lua
        let [followersCount, followingCount] = await redisClient.eval(
            DECR_PAIR_SCRIPT, 2,
            followersCountKey, followingCountKey,
            String(COUNT_TTL)
        );

        // Clamp negatives: shouldn't happen after pre-seed, but guard just in case
        if (followersCount < 0) {
            followersCount = 0;
            redisClient.set(followersCountKey, 0, 'EX', COUNT_TTL).catch(() => {});
        }
        if (followingCount < 0) {
            followingCount = 0;
            redisClient.set(followingCountKey, 0, 'EX', COUNT_TTL).catch(() => {});
        }

        // Delete Follower doc immediately so DB fallback never reads a stale "following" state
        await Follower.findOneAndDelete({ userId: targetUserId, followerId }).catch(() => {});

        return { ok: true, followersCount, followingCount };
    } catch (err) {
        console.error('[FollowEngagement] onUserUnfollowed error:', err.message);
        return { ok: false };
    }
}
