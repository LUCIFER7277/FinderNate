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

// IDs pending a Redis cache refresh at the next cron tick.
// Only used for Redis resync — DB writes happen per-job in the processor.
// Losing this set on restart is acceptable: caches re-seed lazily on next access.
const dirtyPosts = new Set();
const dirtyUsers = new Set();

// ── Worker (consumer side) ─────────────────────────────────────────────────
// DB write happens here, before the job is marked complete by BullMQ,
// so a process restart can never lose a like/unlike from the database.

async function processor(job) {
    const { userId, postId, action } = job.data;

    if (action === 'like') {
        await Like.updateOne(
            {
                userId: new mongoose.Types.ObjectId(userId),
                postId: new mongoose.Types.ObjectId(postId),
            },
            {
                $setOnInsert: {
                    userId: new mongoose.Types.ObjectId(userId),
                    postId: new mongoose.Types.ObjectId(postId),
                },
            },
            { upsert: true }
        );
    }
    // 'unlike': Like.deleteOne is called immediately in onPostUnliked — no DB write needed here

    // Sync Post.engagement.likes from the live Redis counter.
    // If the key has expired, fall back to an exact DB count and re-seed the key.
    const countRaw = await redisClient.get(RedisKeys.postLikesCount(postId));
    let likesCount;
    if (countRaw !== null) {
        likesCount = parseInt(countRaw, 10);
    } else {
        likesCount = await Like.countDocuments({ postId: new mongoose.Types.ObjectId(postId) });
        await redisClient.set(
            RedisKeys.postLikesCount(postId),
            likesCount,
            'EX',
            RedisTTL.POST_ENGAGEMENT
        );
    }
    await Post.updateOne(
        { _id: new mongoose.Types.ObjectId(postId) },
        { $set: { 'engagement.likes': likesCount } }
    );

    dirtyPosts.add(postId);
    dirtyUsers.add(userId);
}

async function _refreshUserLikedSets(userIds) {
    for (const userId of userIds) {
        try {
            const dbLikes = await Like.find({ userId: new mongoose.Types.ObjectId(userId) })
                .select('postId')
                .lean();
            if (!dbLikes.length) continue;
            const setKey = RedisKeys.userLikedSet(userId);
            const pipeline = redisClient.pipeline();
            pipeline.sadd(setKey, ...dbLikes.map(l => l.postId.toString()));
            pipeline.expire(setKey, LIKE_STATUS_TTL);
            await pipeline.exec();
        } catch (err) {
            console.error(`[LikeQueue] Refresh set error for user ${userId}:`, err.message);
        }
    }
}

// ── Cron: periodic Redis resync from authoritative DB state ───────────────
// Refreshes likedBy Hashes and user liked Sets for posts/users that had
// activity since the last tick. DB writes are already done in the processor.

function scheduleResync() {
    const resync = async (label) => {
        const postIds = [...dirtyPosts];
        const userIds = [...dirtyUsers];
        dirtyPosts.clear();
        dirtyUsers.clear();

        if (!postIds.length && !userIds.length) {
            console.log(`[LikeQueue] ${label} resync — nothing to refresh`);
            return;
        }

        console.log(`[LikeQueue] ${label} resync triggered — ${postIds.length} posts, ${userIds.length} users`);
        try {
            await Promise.all([
                refreshLikedByHashes(postIds),
                _refreshUserLikedSets(userIds),
            ]);
            console.log(`[LikeQueue] ${label} resync done`);
        } catch (err) {
            console.error(`[LikeQueue] ${label} resync failed:`, err.message);
        }
    };

    cron.schedule('0 13 * * *', () => resync('1 PM'), { timezone: 'Asia/Kolkata' });
    cron.schedule('0 22 * * *', () => resync('10 PM'), { timezone: 'Asia/Kolkata' });
    // cron.schedule('*/5 * * * *', () => resync('5m'), { timezone: 'Asia/Kolkata' });

}

export function startLikeWorker() {
    const worker = new Worker('like-sync', processor, {
        connection,
        concurrency: BATCH_SIZE,
    });

    scheduleResync();

    worker.on('failed', (job, err) => {
        console.error(`[LikeQueue] Job ${job?.id} failed after retries:`, err.message);
    });

    worker.on('error', err => {
        console.error('[LikeQueue] Worker error:', err.message);
    });

    console.log('✅ LikeQueue worker started — DB writes per job, Redis resync at 1 PM & 10 PM');
    return worker;
}
