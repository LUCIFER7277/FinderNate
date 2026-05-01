import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';

const FOLLOW_STATUS_TTL = RedisTTL.FOLLOW_STATUS;

const MAX_FOLLOW_LIST = 15;
const LIST_TTL = 12 * 24 * 60 * 60;   // 12 days
const TEMP_TTL = 3 * 60 * 60;          // 3h safety TTL on temp SET
const TEMP_ACTIVE_TTL = 25 * 60 * 60;  // 25h

/**
 * Check if followerId is following targetUserId.
 * Redis-first: '1'→following, '0'→not following, null→DB fallback.
 * If Redis is down, reads directly from DB.
 */
export async function getFollowStatus(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    try {
        const val = await redisClient.get(RedisKeys.userFollowStatus(followerIdStr, targetIdStr));
        if (val !== null) return val === '1';
        return !!(await Follower.findOne({ userId: targetUserId, followerId }));
    } catch {
        return !!(await Follower.findOne({ userId: targetUserId, followerId }));
    }
}

/**
 * Call when A follows B.
 * - Sets follow-status key to '1' and marks dirty for 4-hourly DB sync.
 * - LPUSH+LTRIM A's ID into B's followers LIST (newest-first, max 15).
 * - LPUSH+LTRIM B's ID into A's following LIST (newest-first, max 15).
 * - SADD A's ID into B's followers:temp SET (pending 2h flush to DB).
 * - SADD B's ID into A's following:temp SET (pending 2h flush to DB).
 * - SADD both A and B into fn:follows:temp:active so the cron knows who to flush.
 * Returns true on success, false if Redis is down.
 */
export async function onUserFollowed(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    const dirtyKey = RedisKeys.followsDirty();
    const followersListKey = RedisKeys.userFollowers(targetIdStr);
    const followingListKey = RedisKeys.userFollowing(followerIdStr);
    const followersTempKey = RedisKeys.followersTemp(targetIdStr);
    const followingTempKey = RedisKeys.followingTemp(followerIdStr);
    const tempActiveKey = RedisKeys.followTempActiveUsers();

    try {
        const pipeline = redisClient.pipeline();

        // Follow-status + dirty set (existing behaviour)
        pipeline.set(RedisKeys.userFollowStatus(followerIdStr, targetIdStr), '1', 'EX', FOLLOW_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${followerIdStr}:${targetIdStr}`);
        pipeline.expire(dirtyKey, 25 * 60 * 60);

        // B's followers LIST — push A to front, trim to 15
        pipeline.lpush(followersListKey, followerIdStr);
        pipeline.ltrim(followersListKey, 0, MAX_FOLLOW_LIST - 1);
        pipeline.expire(followersListKey, LIST_TTL);

        // A's following LIST — push B to front, trim to 15
        pipeline.lpush(followingListKey, targetIdStr);
        pipeline.ltrim(followingListKey, 0, MAX_FOLLOW_LIST - 1);
        pipeline.expire(followingListKey, LIST_TTL);

        // B's followers:temp SET — A's ID is pending DB flush
        pipeline.sadd(followersTempKey, followerIdStr);
        pipeline.expire(followersTempKey, TEMP_TTL);

        // A's following:temp SET — B's ID is pending DB flush
        pipeline.sadd(followingTempKey, targetIdStr);
        pipeline.expire(followingTempKey, TEMP_TTL);

        // Track active temp users so the cron knows who to flush
        pipeline.sadd(tempActiveKey, targetIdStr, followerIdStr);
        pipeline.expire(tempActiveKey, TEMP_ACTIVE_TTL);

        await pipeline.exec();
        return true;
    } catch (err) {
        console.error('[FollowEngagement] onUserFollowed error:', err.message);
        return false;
    }
}

/**
 * Call when A unfollows B.
 * - Sets follow-status key to '0' and marks dirty for 4-hourly sync.
 * - LREM A's ID from B's followers LIST.
 * - LREM B's ID from A's following LIST.
 * - SREM A's ID from B's followers:temp SET.
 * - SREM B's ID from A's following:temp SET.
 * - Immediately deletes Follower doc so DB fallback never returns a stale state.
 * Returns true on success, false if Redis is down.
 */
export async function onUserUnfollowed(followerId, targetUserId) {
    const followerIdStr = followerId.toString();
    const targetIdStr = targetUserId.toString();
    const dirtyKey = RedisKeys.followsDirty();
    const followersListKey = RedisKeys.userFollowers(targetIdStr);
    const followingListKey = RedisKeys.userFollowing(followerIdStr);
    const followersTempKey = RedisKeys.followersTemp(targetIdStr);
    const followingTempKey = RedisKeys.followingTemp(followerIdStr);

    try {
        const pipeline = redisClient.pipeline();

        // Follow-status + dirty set (existing behaviour)
        pipeline.set(RedisKeys.userFollowStatus(followerIdStr, targetIdStr), '0', 'EX', FOLLOW_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${followerIdStr}:${targetIdStr}`);
        pipeline.expire(dirtyKey, 25 * 60 * 60);

        // Remove A from B's followers LIST
        pipeline.lrem(followersListKey, 0, followerIdStr);

        // Remove B from A's following LIST
        pipeline.lrem(followingListKey, 0, targetIdStr);

        // Remove A from B's followers:temp SET
        pipeline.srem(followersTempKey, followerIdStr);

        // Remove B from A's following:temp SET
        pipeline.srem(followingTempKey, targetIdStr);

        await pipeline.exec();

        // Immediately delete Follower doc so DB fallback never returns a stale "following" state.
        // (Follows are deferred; unfollows must be synchronous for correctness.)
        await Follower.findOneAndDelete({ userId: targetUserId, followerId }).catch(() => {});

        return true;
    } catch (err) {
        console.error('[FollowEngagement] onUserUnfollowed error:', err.message);
        return false;
    }
}
