import cron from 'node-cron';
import mongoose from 'mongoose';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';
import { refreshLikedByHashes } from '../utils/postEngagement.utils.js';

const DIRTY_KEY = RedisKeys.likesDirty();
const SYNCING_KEY = 'fn:likes:syncing';
const BATCH_SIZE = 100;
const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;

export function startLikeSyncJob() {
    cron.schedule('* */5 * * *', async () => {
        console.log('[LikeSync] Starting like sync...');
        try {
            await syncLikesToDB();
        } catch (err) {
            console.error('[LikeSync] Job failed:', err);
        }
    });
}

async function syncLikesToDB() {
    // Atomically hand off the dirty set so new likes land in a fresh key
    try {
        await redisClient.rename(DIRTY_KEY, SYNCING_KEY);
    } catch (err) {
        if (err.message.includes('no such key') || err.message.includes('ERR no such key')) {
            console.log('[LikeSync] Nothing to sync');
            return;
        }
        throw err;
    }

    const toUpsert = [];  // { userId, postId }
    const toDelete = [];  // { userId, postId }
    const affectedPostIds = new Set();
    const seen = new Set();
    let cursor = '0';

    // SSCAN through syncing set in batches
    do {
        const [nextCursor, members] = await redisClient.sscan(SYNCING_KEY, cursor, 'COUNT', BATCH_SIZE);
        cursor = nextCursor;
        if (!members.length) continue;

        const unique = members.filter(pair => !seen.has(pair));
        unique.forEach(pair => seen.add(pair));
        if (!unique.length) continue;

        // Group by userId for batch HMGET on fn:user:{uid}:liked Hash
        // (Lua scripts write to the Hash, not to individual fn:like:{uid}:{pid} keys)
        const byUser = new Map();
        unique.forEach(pair => {
            const [uid, pid] = pair.split(':');
            if (!byUser.has(uid)) byUser.set(uid, []);
            byUser.get(uid).push(pid);
        });

        const pipeline = redisClient.pipeline();
        const userEntries = [...byUser.entries()];
        for (const [uid, postIds] of userEntries) {
            pipeline.hmget(RedisKeys.userLikedHash(uid), ...postIds);
        }
        const results = await pipeline.exec();

        userEntries.forEach(([uid, postIds], i) => {
            const [, values] = results[i];
            postIds.forEach((pid, j) => {
                const status = values[j];
                if (status === null) return; // Hash expired before sync — DB already authoritative
                affectedPostIds.add(pid);
                if (status === '1') toUpsert.push({ userId: uid, postId: pid });
                else toDelete.push({ userId: uid, postId: pid });
            });
        });
    } while (cursor !== '0');

    // ── DB writes ─────────────────────────────────────────────────────────────

    // Upsert new likes
    if (toUpsert.length) {
        const ops = toUpsert.map(({ userId, postId }) => ({
            updateOne: {
                filter: {
                    userId: new mongoose.Types.ObjectId(userId),
                    postId: new mongoose.Types.ObjectId(postId),
                },
                update: {
                    $setOnInsert: {
                        userId: new mongoose.Types.ObjectId(userId),
                        postId: new mongoose.Types.ObjectId(postId),
                    },
                },
                upsert: true,
            },
        }));
        await Like.bulkWrite(ops, { ordered: false });
    }

    // Delete unliked records
    if (toDelete.length) {
        const conditions = toDelete.map(({ userId, postId }) => ({
            userId: new mongoose.Types.ObjectId(userId),
            postId: new mongoose.Types.ObjectId(postId),
        }));
        await Like.deleteMany({ $or: conditions });
    }

    // Sync engagement.likes counts from Redis → Post documents
    const postIdArr = [...affectedPostIds];
    if (postIdArr.length) {
        const countKeys = postIdArr.map(id => RedisKeys.postLikesCount(id));
        const counts = await redisClient.mget(...countKeys);
        const ops = [];
        postIdArr.forEach((postId, i) => {
            if (counts[i] !== null) {
                ops.push({
                    updateOne: {
                        filter: { _id: new mongoose.Types.ObjectId(postId) },
                        update: { $set: { 'engagement.likes': parseInt(counts[i], 10) } },
                    },
                });
            }
        });
        if (ops.length) await Post.bulkWrite(ops, { ordered: false });
    }

    // ── Redis refresh from DB ──────────────────────────────────────────────────
    // After writing to DB, re-seed both Redis caches from the authoritative DB
    // state so any Hash that was evicted between like-time and sync-time is
    // rebuilt correctly.

    await Promise.all([
        _refreshUserLikedHashes(toUpsert, toDelete),
        refreshLikedByHashes(postIdArr),
    ]);

    await redisClient.del(SYNCING_KEY);

    console.log(
        `[LikeSync] Done — upserted ${toUpsert.length}, deleted ${toDelete.length}, ` +
        `refreshed Redis for ${affectedPostIds.size} posts`
    );
}

/**
 * Re-seed fn:user:{uid}:liked Hash for every processed (userId, postId) pair.
 * Sets '1' for likes, '0' for unlikes — ensures the Hash reflects the DB state
 * even if it was re-seeded from DB during the window between like-time and sync.
 */
async function _refreshUserLikedHashes(toUpsert, toDelete) {
    if (!toUpsert.length && !toDelete.length) return;

    // Merge per-user: {uid → Map<pid, '1'|'0'>}
    const perUser = new Map();
    const collect = (pairs, val) => {
        for (const { userId, postId } of pairs) {
            if (!perUser.has(userId)) perUser.set(userId, new Map());
            perUser.get(userId).set(postId, val);
        }
    };
    collect(toUpsert, '1');
    collect(toDelete, '0');

    const pipeline = redisClient.pipeline();
    for (const [uid, postMap] of perUser) {
        const hashKey = RedisKeys.userLikedHash(uid);
        const args = [hashKey];
        for (const [pid, val] of postMap) args.push(pid, val);
        pipeline.hset(...args);
        pipeline.expire(hashKey, LIKE_STATUS_TTL);
    }
    await pipeline.exec();
}

