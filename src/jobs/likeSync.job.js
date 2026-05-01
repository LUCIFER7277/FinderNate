import cron from 'node-cron';
import mongoose from 'mongoose';
import { redisClient, RedisKeys } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';

const DIRTY_KEY = RedisKeys.likesDirty();
const SYNCING_KEY = 'fn:likes:syncing';
const BATCH_SIZE = 100;

// export function startLikeSyncJob() {
//     // Run every 4 hours
//     cron.schedule('0 */4 * * *', async () => {
//         console.log('[LikeSync] Starting daily like sync...');
//         try {
//             await syncLikesToDB();
//         } catch (err) {
//             console.error('[LikeSync] Job failed:', err);
//         }
//     });
// }

export function startLikeSyncJob() {
    // Run every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
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
    // SSCAN may return the same member across multiple cursor positions during rehashing;
    // deduplicate here so we don't upsert/delete the same pair twice.
    const seen = new Set();
    let cursor = '0';

    // SSCAN through the syncing set in fixed-size batches
    do {
        const [nextCursor, members] = await redisClient.sscan(SYNCING_KEY, cursor, 'COUNT', BATCH_SIZE);
        cursor = nextCursor;
        if (!members.length) continue;

        // Filter out duplicates before hitting Redis with MGET
        const unique = members.filter(pair => !seen.has(pair));
        unique.forEach(pair => seen.add(pair));
        if (!unique.length) continue;

        const keys = unique.map(pair => {
            const [uid, pid] = pair.split(':');
            return RedisKeys.userLikedPost(uid, pid);
        });
        const statuses = await redisClient.mget(...keys);

        unique.forEach((pair, i) => {
            const [userId, postId] = pair.split(':');
            const status = statuses[i];
            if (status === null) return; // TTL expired before sync — skip (DB already authoritative)
            affectedPostIds.add(postId);
            if (status === '1') toUpsert.push({ userId, postId });
            else toDelete.push({ userId, postId });
        });
    } while (cursor !== '0');

    // Upsert likes (insert if not exists, no-op if duplicate)
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

    // Sync engagement.likes counts from Redis back to Post documents
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

    await redisClient.del(SYNCING_KEY);

    console.log(
        `[LikeSync] Done — upserted ${toUpsert.length}, deleted ${toDelete.length}, ` +
        `updated counts for ${affectedPostIds.size} posts`
    );
}
