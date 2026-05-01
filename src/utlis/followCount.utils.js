import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';

const TTL = RedisTTL.FOLLOW_COUNT;

async function _dbFollowersCount(userId) {
    return Follower.countDocuments({ userId });
}

async function _dbFollowingCount(userId) {
    return Follower.countDocuments({ followerId: userId });
}

/**
 * Get followers count — Redis first, DB fallback with automatic seeding.
 */
export async function getFollowersCount(userId) {
    const key = RedisKeys.userFollowersCount(userId);
    try {
        const val = await redisClient.get(key);
        if (val !== null) return parseInt(val, 10);
        const count = await _dbFollowersCount(userId);
        await redisClient.set(key, count, 'EX', TTL);
        return count;
    } catch (err) {
        console.error(`[FollowCount] getFollowersCount(${userId}):`, err.message);
        return _dbFollowersCount(userId).catch(() => 0);
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
        const count = await _dbFollowingCount(userId);
        await redisClient.set(key, count, 'EX', TTL);
        return count;
    } catch (err) {
        console.error(`[FollowCount] getFollowingCount(${userId}):`, err.message);
        return _dbFollowingCount(userId).catch(() => 0);
    }
}

/**
 * Increment followers count.
 * Uses INCR-first so the operation is atomic. If INCR returns 1 the key was
 * missing (Redis created it at 0 then incremented), so we re-seed from DB + 1
 * to account for the deferred follow that hasn't been written to DB yet.
 */
export async function incrFollowersCount(userId) {
    const key = RedisKeys.userFollowersCount(userId);
    try {
        const next = await redisClient.incr(key);
        if (next === 1) {
            // Key was just created — DB doesn't have the deferred follow yet, so +1
            const dbCount = await _dbFollowersCount(userId);
            const correct = dbCount + 1;
            await redisClient.set(key, correct, 'EX', TTL);
            return correct;
        }
        await redisClient.expire(key, TTL);
        return next;
    } catch (err) {
        console.error(`[FollowCount] incrFollowersCount(${userId}):`, err.message);
    }
}

/**
 * Decrement followers count.
 * Uses DECR-first so the operation is atomic. If DECR returns < 0 the key was
 * missing (Redis created it at 0 then decremented to -1), so we re-seed from DB.
 * The Follower doc is deleted synchronously by onUserUnfollowed before this runs,
 * so the DB count already reflects the removal.
 */
export async function decrFollowersCount(userId) {
    const key = RedisKeys.userFollowersCount(userId);
    try {
        const next = await redisClient.decr(key);
        if (next < 0) {
            const dbCount = await _dbFollowersCount(userId);
            const correct = Math.max(0, dbCount);
            await redisClient.set(key, correct, 'EX', TTL);
            return correct;
        }
        await redisClient.expire(key, TTL);
        return next;
    } catch (err) {
        console.error(`[FollowCount] decrFollowersCount(${userId}):`, err.message);
    }
}

/**
 * Increment following count.
 * Uses INCR-first so the operation is atomic. If INCR returns 1 the key was
 * missing, so we re-seed from DB + 1 to account for the deferred follow.
 */
export async function incrFollowingCount(userId) {
    const key = RedisKeys.userFollowingCount(userId);
    try {
        const next = await redisClient.incr(key);
        if (next === 1) {
            const dbCount = await _dbFollowingCount(userId);
            const correct = dbCount + 1;
            await redisClient.set(key, correct, 'EX', TTL);
            return correct;
        }
        await redisClient.expire(key, TTL);
        return next;
    } catch (err) {
        console.error(`[FollowCount] incrFollowingCount(${userId}):`, err.message);
    }
}

/**
 * Decrement following count.
 * Uses DECR-first so the operation is atomic. If DECR returns < 0 the key was
 * missing, so we re-seed from DB (which already reflects the deletion).
 */
export async function decrFollowingCount(userId) {
    const key = RedisKeys.userFollowingCount(userId);
    try {
        const next = await redisClient.decr(key);
        if (next < 0) {
            const dbCount = await _dbFollowingCount(userId);
            const correct = Math.max(0, dbCount);
            await redisClient.set(key, correct, 'EX', TTL);
            return correct;
        }
        await redisClient.expire(key, TTL);
        return next;
    } catch (err) {
        console.error(`[FollowCount] decrFollowingCount(${userId}):`, err.message);
    }
}
