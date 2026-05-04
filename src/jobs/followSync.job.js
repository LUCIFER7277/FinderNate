import cron from 'node-cron';
import mongoose from 'mongoose';
import { redisClient, RedisKeys } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';
import { User } from '../models/user.models.js';

const DIRTY_KEY = RedisKeys.followsDirty();
const SYNCING_KEY = 'fn:follows:syncing';
const BATCH_SIZE = 100;

export function startFollowSyncJob() {
    // Every 4 hours: flush dirty follow/unfollow ops to DB
    // cron.schedule('0 */4 * * *', async () => {
    //     console.log('[FollowSync] Starting follow sync...');
    //     try {
    //         await syncFollowsToDB();
    //     } catch (err) {
    //         console.error('[FollowSync] Job failed:', err);
    //     }
    // });

    // Every 4 hours at :30 — runs after syncFollowsToDB finishes writing to DB,
    // then immediately rebuilds Redis lists so they reflect the latest DB state.
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

async function syncFollowsToDB() {
    // Atomically hand off the dirty set so new follow/unfollow ops land in a fresh key
    try {
        await redisClient.rename(DIRTY_KEY, SYNCING_KEY);
    } catch (err) {
        if (err.message.includes('no such key') || err.message.includes('ERR no such key')) {
            console.log('[FollowSync] Nothing to sync');
            return;
        }
        throw err;
    }

    const toFollow = [];   // { followerId, targetUserId }
    const toUnfollow = []; // { followerId, targetUserId }
    // Deduplicate across SSCAN cursor positions
    const seen = new Set();
    let cursor = '0';

    do {
        const [nextCursor, members] = await redisClient.sscan(SYNCING_KEY, cursor, 'COUNT', BATCH_SIZE);
        cursor = nextCursor;
        if (!members.length) continue;

        const unique = members.filter(pair => !seen.has(pair));
        unique.forEach(pair => seen.add(pair));
        if (!unique.length) continue;

        const keys = unique.map(pair => {
            const [fid, tid] = pair.split(':');
            return RedisKeys.userFollowStatus(fid, tid);
        });
        const statuses = await redisClient.mget(...keys);

        unique.forEach((pair, i) => {
            const [followerId, targetUserId] = pair.split(':');
            const status = statuses[i];
            if (status === null) return; // TTL expired before sync — DB is already authoritative, skip
            if (status === '1') toFollow.push({ followerId, targetUserId });
            else toUnfollow.push({ followerId, targetUserId });
        });
    } while (cursor !== '0');

    // Upsert Follower documents for new follows
    if (toFollow.length) {
        const followerOps = toFollow.map(({ followerId, targetUserId }) => ({
            updateOne: {
                filter: {
                    userId: new mongoose.Types.ObjectId(targetUserId),
                    followerId: new mongoose.Types.ObjectId(followerId),
                },
                update: {
                    $setOnInsert: {
                        userId: new mongoose.Types.ObjectId(targetUserId),
                        followerId: new mongoose.Types.ObjectId(followerId),
                    },
                },
                upsert: true,
            },
        }));
        await Follower.bulkWrite(followerOps, { ordered: false });

        // Update User.followers[] and User.following[] arrays for follows
        const userOps = [];
        for (const { followerId, targetUserId } of toFollow) {
            userOps.push({
                updateOne: {
                    filter: { _id: new mongoose.Types.ObjectId(targetUserId) },
                    update: { $addToSet: { followers: new mongoose.Types.ObjectId(followerId) } },
                },
            });
            userOps.push({
                updateOne: {
                    filter: { _id: new mongoose.Types.ObjectId(followerId) },
                    update: { $addToSet: { following: new mongoose.Types.ObjectId(targetUserId) } },
                },
            });
        }
        if (userOps.length) await User.bulkWrite(userOps, { ordered: false });
    }

    // Follower documents are deleted synchronously on unfollow (in onUserUnfollowed).
    // Only User.followers[]/following[] arrays need to be cleaned up here.
    if (toUnfollow.length) {
        const userOps = [];
        for (const { followerId, targetUserId } of toUnfollow) {
            userOps.push({
                updateOne: {
                    filter: { _id: new mongoose.Types.ObjectId(targetUserId) },
                    update: { $pull: { followers: new mongoose.Types.ObjectId(followerId) } },
                },
            });
            userOps.push({
                updateOne: {
                    filter: { _id: new mongoose.Types.ObjectId(followerId) },
                    update: { $pull: { following: new mongoose.Types.ObjectId(targetUserId) } },
                },
            });
        }
        if (userOps.length) await User.bulkWrite(userOps, { ordered: false });
    }

    await redisClient.del(SYNCING_KEY);

    console.log(
        `[FollowSync] Done — followed ${toFollow.length}, unfollowed ${toUnfollow.length}`
    );
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
