/**
 * Sync script: writes per-post like counts and comment counts from DB → Redis.
 *
 * Run manually:  node src/scripts/syncEngagementToRedis.js
 * Or import and call syncEngagementToRedis() programmatically.
 *
 * What it writes:
 *   fn:post:{postId}:likes:count    = N  (TTL: POST_ENGAGEMENT)
 *   fn:post:{postId}:comments:count = N  (TTL: POST_ENGAGEMENT)
 *
 * Like counts come from the Like collection (aggregate).
 * Comment counts come from the Comment collection (aggregate, top-level only).
 */

import 'dotenv/config';
import connectDB from '../src/db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../src/config/redis.config.js';
import Like from '../src/models/like.models.js';
import Comment from '../src/models/comment.models.js';

const TTL = RedisTTL.POST_ENGAGEMENT;

export async function syncEngagementToRedis() {
    console.log('[SyncEngagement] Starting DB → Redis sync...');

    // ── Like counts ──────────────────────────────────────────────────────────
    const likeCounts = await Like.aggregate([
        { $match: { postId: { $ne: null } } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    // ── Comment counts (top-level only) ─────────────────────────────────────
    const commentCounts = await Comment.aggregate([
        { $match: { parentCommentId: null } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    // Merge into a single pipeline write
    const pipeline = redisClient.pipeline();

    for (const { _id: postId, count } of likeCounts) {
        if (!postId) continue;
        pipeline.set(RedisKeys.postLikesCount(postId.toString()), count, 'EX', TTL);
    }

    for (const { _id: postId, count } of commentCounts) {
        if (!postId) continue;
        pipeline.set(RedisKeys.postCommentsCount(postId.toString()), count, 'EX', TTL);
    }

    await pipeline.exec();

    console.log(`[SyncEngagement] Done — ${likeCounts.length} like-count keys, ${commentCounts.length} comment-count keys written`);
}

if (process.argv[1].includes('syncEngagementToRedis')) {
    connectDB()
        .then(() => syncEngagementToRedis())
        .then(() => {
            redisClient.quit();
            process.exit(0);
        })
        .catch(err => {
            console.error('[SyncEngagement] Fatal:', err);
            process.exit(1);
        });
}
