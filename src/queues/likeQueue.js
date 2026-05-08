import { Queue, Worker } from 'bullmq';
import mongoose from 'mongoose';
import cron from 'node-cron';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import { refreshLikedByHashes } from '../utils/postEngagement.utils.js';

const connection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
};

const BATCH_SIZE = 50;
const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;

// ── Queue (producer side) ──────────────────────────────────────────────────

export const likeQueue = new Queue('like-sync', {
    connection,
    defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
});


let buffer = [];

export async function flushBuffer() {
    if (!buffer.length) return;

    const batch = buffer.splice(0);
    const toUpsert = [];
    const toDelete = [];
    const affectedPostIds = new Set();
    const affectedUserIds = new Set();

    for (const { data } of batch) {
        affectedPostIds.add(data.postId);
        affectedUserIds.add(data.userId);
        if (data.action === 'like') toUpsert.push(data);
        else                        toDelete.push(data);
    }

    try {
        // ── DB writes ──────────────────────────────────────────────────────
        if (toUpsert.length) {
            await Like.bulkWrite(
                toUpsert.map(({ userId, postId }) => ({
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
                })),
                { ordered: false }
            );
        }

        if (toDelete.length) {
            await Like.deleteMany({
                $or: toDelete.map(({ userId, postId }) => ({
                    userId: new mongoose.Types.ObjectId(userId),
                    postId: new mongoose.Types.ObjectId(postId),
                })),
            });
        }

        // ── Sync engagement.likes counts → Post documents ──────────────────
        const postIdArr = [...affectedPostIds];
        if (postIdArr.length) {
            const counts = await redisClient.mget(
                ...postIdArr.map(id => RedisKeys.postLikesCount(id))
            );
            const ops = postIdArr
                .map((postId, i) => counts[i] !== null ? {
                    updateOne: {
                        filter: { _id: new mongoose.Types.ObjectId(postId) },
                        update: { $set: { 'engagement.likes': parseInt(counts[i], 10) } },
                    },
                } : null)
                .filter(Boolean);
            if (ops.length) await Post.bulkWrite(ops, { ordered: false });
        }

        // ── Refresh Redis caches from authoritative DB state ───────────────
        await Promise.all([
            _refreshUserLikedSets([...affectedUserIds]),
            refreshLikedByHashes(postIdArr),
        ]);

        console.log(
            `[LikeQueue] Scheduled flush done — upserted ${toUpsert.length}, ` +
            `deleted ${toDelete.length}, posts ${affectedPostIds.size}, ` +
            `users ${affectedUserIds.size}`
        );
    } catch (err) {
        console.error('[LikeQueue] Scheduled flush failed:', err.message);
    }
}

// ── Rebuild fn:user:{userId}:liked Set from DB after sync ─────────────────

async function _refreshUserLikedSets(userIds) {
    for (const userId of userIds) {
        try {
            const dbLikes = await Like.find({ userId: new mongoose.Types.ObjectId(userId) })
                .select('postId')
                .lean();
            const setKey = RedisKeys.userLikedSet(userId);
            const pipeline = redisClient.pipeline();
            pipeline.del(setKey);
            if (dbLikes.length) {
                pipeline.sadd(setKey, ...dbLikes.map(l => l.postId.toString()));
                pipeline.expire(setKey, LIKE_STATUS_TTL);
            }
            await pipeline.exec();
        } catch (err) {
            console.error(`[LikeQueue] Refresh set error for user ${userId}:`, err.message);
        }
    }
}

// ── Worker (consumer side) ─────────────────────────────────────────────────

async function processor(job) {
    buffer.push({ data: job.data });
}

export function startLikeWorker() {
    const worker = new Worker('like-sync', processor, {
        connection,
        concurrency: BATCH_SIZE,
    });

    // Flush at 1 PM and 10 PM daily (IST)
    cron.schedule('0 13 * * *', () => {
        console.log('[LikeQueue] 1 PM scheduled flush triggered');
        flushBuffer();
    }, { timezone: 'Asia/Kolkata' });

    cron.schedule('0 22 * * *', () => {
        console.log('[LikeQueue] 10 PM scheduled flush triggered');
        flushBuffer();
    }, { timezone: 'Asia/Kolkata' });

    worker.on('failed', (job, err) => {
        console.error(`[LikeQueue] Job ${job?.id} failed after retries:`, err.message);
    });

    worker.on('error', err => {
        console.error('[LikeQueue] Worker error:', err.message);
    });

    console.log('✅ LikeQueue worker started — flushes scheduled at 1 PM and 10 PM');
    return worker;
}
