import cron from 'node-cron';
import mongoose from 'mongoose';
import { redisClient, RedisKeys } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';

export function startFollowSyncJob() {
    // Every 4 hours at :30 — flush followers:temp/following:temp SETs to DB,
    // then rebuild Redis follower/following LISTs from the updated DB state.
    cron.schedule('30 */4 * * *', async () => {
        console.log('[FollowSync] Starting temp flush + Redis list refresh...');
        try {
            await flushFollowTempToDB();       // 1. write temp SETs to DB
            await refreshFollowListsFromDB();  // 2. rebuild Redis LRANGEs from updated DB
        } catch (err) {
            console.error('[FollowSync] Flush+refresh failed:', err);
        }
    });
}

/**
 * Every 2 hours: flush followers:temp and following:temp SETs to the Follower collection.
 *
 * followers:temp for B contains A's IDs → Follower { userId: B, followerId: A }
 * following:temp for A contains B's IDs → Follower { userId: B, followerId: A }
 *
 * After flushing each temp SET it is deleted. temp:active is left intact for refreshFollowListsFromDB.
 */
async function flushFollowTempToDB() {
    const tempActiveKey = RedisKeys.followTempActiveUsers();

    let activeUserIds;
    try {
        activeUserIds = await redisClient.smembers(tempActiveKey);
    } catch (err) {
        console.error('[FollowSync][flushTemp] Could not read temp:active set:', err.message);
        return;
    }

    if (!activeUserIds.length) {
        console.log('[FollowSync][flushTemp] Nothing to flush');
        return;
    }

    let followerOpsTotal = 0;

    for (const userId of activeUserIds) {
        // ── Flush followers:temp for this userId ─────────────────────────────
        // B's followers:temp has A's IDs → Follower { userId: B, followerId: A }
        try {
            const followersTempKey = RedisKeys.followersTemp(userId);
            const followerIds = await redisClient.smembers(followersTempKey);

            if (followerIds.length) {
                const ops = followerIds.map(followerId => ({
                    updateOne: {
                        filter: {
                            userId: new mongoose.Types.ObjectId(userId),
                            followerId: new mongoose.Types.ObjectId(followerId),
                        },
                        update: {
                            $setOnInsert: {
                                userId: new mongoose.Types.ObjectId(userId),
                                followerId: new mongoose.Types.ObjectId(followerId),
                            },
                        },
                        upsert: true,
                    },
                }));
                await Follower.bulkWrite(ops, { ordered: false });
                followerOpsTotal += ops.length;
            }

            await redisClient.del(followersTempKey);
        } catch (err) {
            console.error(`[FollowSync][flushTemp] followers:temp error for user ${userId}:`, err.message);
        }

        // ── Flush following:temp for this userId ─────────────────────────────
        // A's following:temp has B's IDs → Follower { userId: B, followerId: A }
        try {
            const followingTempKey = RedisKeys.followingTemp(userId);
            const followingIds = await redisClient.smembers(followingTempKey);

            if (followingIds.length) {
                const ops = followingIds.map(targetUserId => ({
                    updateOne: {
                        filter: {
                            userId: new mongoose.Types.ObjectId(targetUserId),
                            followerId: new mongoose.Types.ObjectId(userId),
                        },
                        update: {
                            $setOnInsert: {
                                userId: new mongoose.Types.ObjectId(targetUserId),
                                followerId: new mongoose.Types.ObjectId(userId),
                            },
                        },
                        upsert: true,
                    },
                }));
                await Follower.bulkWrite(ops, { ordered: false });
                followerOpsTotal += ops.length;
            }

            await redisClient.del(followingTempKey);
        } catch (err) {
            console.error(`[FollowSync][flushTemp] following:temp error for user ${userId}:`, err.message);
        }
    }
    // to know which users' LRANGEs need rebuilding from DB after this flush.

    console.log(`[FollowSync][flushTemp] Done — ${followerOpsTotal} Follower upserts across ${activeUserIds.length} users`);
}

/**
 * Every 10 hours: re-seed the follower/following Redis LISTs from DB for all users
 * that have had temp activity, then clear their temp SETs and the active tracking SET.
 *
 * Uses DEL + RPUSH (not LPUSH) so the list order matches the DB sort order (newest → oldest).
 */
async function refreshFollowListsFromDB() {
    const LIST_TTL = 12 * 24 * 60 * 60; // 12 days — mirrors followEngagement.utils.js
    const tempActiveKey = RedisKeys.followTempActiveUsers();

    let activeUserIds;
    try {
        activeUserIds = await redisClient.smembers(tempActiveKey);
    } catch (err) {
        console.error('[FollowSync][refresh] Could not read temp:active set:', err.message);
        return;
    }

    if (!activeUserIds.length) {
        console.log('[FollowSync][refresh] Nothing to refresh');
        return;
    }

    for (const userId of activeUserIds) {
        // ── Refresh followers LIST ────────────────────────────────────────────
        try {
            const top15Followers = await Follower.find({ userId })
                .sort({ createdAt: -1 })
                .limit(15)
                .select('followerId')
                .lean();

            const followersListKey = RedisKeys.userFollowers(userId);
            const followersTempKey = RedisKeys.followersTemp(userId);

            const pipeline = redisClient.pipeline();
            pipeline.del(followersListKey);
            if (top15Followers.length) {
                // RPUSH in DB order (already sorted newest→oldest), so list[0] = newest
                pipeline.rpush(followersListKey, ...top15Followers.map(f => f.followerId.toString()));
                pipeline.expire(followersListKey, LIST_TTL);
            }
            pipeline.del(followersTempKey);
            await pipeline.exec();
        } catch (err) {
            console.error(`[FollowSync][refresh] followers refresh error for user ${userId}:`, err.message);
        }

        // ── Refresh following LIST ────────────────────────────────────────────
        try {
            const top15Following = await Follower.find({ followerId: userId })
                .sort({ createdAt: -1 })
                .limit(15)
                .select('userId')
                .lean();

            const followingListKey = RedisKeys.userFollowing(userId);
            const followingTempKey = RedisKeys.followingTemp(userId);

            const pipeline = redisClient.pipeline();
            pipeline.del(followingListKey);
            if (top15Following.length) {
                pipeline.rpush(followingListKey, ...top15Following.map(f => f.userId.toString()));
                pipeline.expire(followingListKey, LIST_TTL);
            }
            pipeline.del(followingTempKey);
            await pipeline.exec();
        } catch (err) {
            console.error(`[FollowSync][refresh] following refresh error for user ${userId}:`, err.message);
        }
    }

    // Clear the active-users tracking SET
    try {
        await redisClient.del(tempActiveKey);
    } catch (err) {
        console.error('[FollowSync][refresh] Could not delete temp:active set:', err.message);
    }

    console.log(`[FollowSync][refresh] Done — refreshed lists for ${activeUserIds.length} users`);
}
