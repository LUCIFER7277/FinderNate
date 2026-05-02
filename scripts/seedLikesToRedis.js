/**
 * One-time (or periodic) warm-up script: seeds Redis with the current state of
 * the Like collection so that batchIsLikedByUser, batchGetLikesCount, and
 * onPostLiked/onPostUnliked all have accurate data without hitting the DB.
 *
 * Run manually:  node src/scripts/seedLikesToRedis.js
 * Or call seedLikesToRedis() at server startup after connectDB().
 *
 * What it writes:
 *   fn:like:{userId}:{postId}   = '1'  (TTL: POST_LIKE_STATUS)
 *   fn:post:{postId}:likes:count = N   (TTL: POST_ENGAGEMENT)
 */

import 'dotenv/config';
import connectDB from '../src/db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../src/config/redis.config.js';
import Like from '../src/models/like.models.js';
import Post from '../src/models/userPost.models.js';

const BATCH_SIZE = 500;
const LIKE_TTL = RedisTTL.POST_LIKE_STATUS;
const COUNT_TTL = RedisTTL.POST_ENGAGEMENT;

export async function seedLikesToRedis() {
    console.log('[SeedLikes] Starting Redis warm-up from DB...');

    // ── Step 1: seed per-user like-status keys ────────────────────────────────
    let processed = 0;
    let cursor = null;

    do {
        const query = Like.find({}).select('userId postId').lean();
        if (cursor) query.where('_id').gt(cursor);
        const batch = await query.limit(BATCH_SIZE);

        if (!batch.length) break;
        cursor = batch[batch.length - 1]._id;

        const pipeline = redisClient.pipeline();
        let batchCount = 0;
        for (const { userId, postId } of batch) {
            if (!userId || !postId) continue; // skip corrupted documents
            pipeline.set(
                RedisKeys.userLikedPost(userId.toString(), postId.toString()),
                '1',
                'EX',
                LIKE_TTL
            );
            batchCount++;
        }
        await pipeline.exec();
        processed += batchCount;
        console.log(`[SeedLikes] Like-status keys written: ${processed}`);

        if (batch.length < BATCH_SIZE) break;
    } while (true);

    // ── Step 2: seed per-post like count keys ────────────────────────────────
    // Aggregate like counts grouped by postId directly from the DB
    const counts = await Like.aggregate([
        { $match: { userId: { $ne: null }, postId: { $ne: null } } },
        { $group: { _id: '$postId', count: { $sum: 1 } } }
    ]);

    if (counts.length) {
        const pipeline = redisClient.pipeline();
        for (const { _id: postId, count } of counts) {
            if (!postId) continue;
            pipeline.set(RedisKeys.postLikesCount(postId.toString()), count, 'EX', COUNT_TTL);
        }
        await pipeline.exec();
        console.log(`[SeedLikes] Like-count keys written: ${counts.length} posts`);
    }

    console.log(`[SeedLikes] Done — ${processed} like-status keys, ${counts.length} count keys`);
}

// Allow direct execution: node src/scripts/seedLikesToRedis.js
if (process.argv[1].includes('seedLikesToRedis')) {
    connectDB()
        .then(() => seedLikesToRedis())
        .then(() => {
            redisClient.quit();
            process.exit(0);
        })
        .catch(err => {
            console.error('[SeedLikes] Fatal:', err);
            process.exit(1);
        });
}
