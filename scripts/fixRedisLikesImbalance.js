/**
 * External Redis like-imbalance fixer.
 *
 * Compares the current DB state (Like collection + Post.engagement.likes)
 * against Redis and corrects every mismatch — without touching business logic.
 *
 * Run:  node src/scripts/fixRedisLikesImbalance.js
 *
 * What it fixes:
 *   1. Missing  fn:like:{userId}:{postId}  keys  → seeds '1' from DB
 *   2. Stale    fn:like:{userId}:{postId}  keys  → overwrites with DB truth
 *   3. Missing  fn:post:{postId}:likes:count keys → seeds from DB count
 *   4. Wrong    fn:post:{postId}:likes:count      → corrects to DB count
 *
 * Safe to run while the server is live — read-then-set, no deletes.
 */

import 'dotenv/config';
import connectDB from '../src/db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../src/config/redis.config.js';
import Like from '../src/models/like.models.js';

const BATCH_SIZE = 500;
const LIKE_TTL   = RedisTTL.POST_LIKE_STATUS;   // 7 days
const COUNT_TTL  = RedisTTL.POST_ENGAGEMENT;     // 7 days

async function fixLikeStatusKeys() {
    console.log('\n[Fix] ── Scanning like-status keys ──');
    let fixed = 0;
    let skipped = 0;
    let cursor = null;

    do {
        const query = Like.find({}).select('userId postId').lean();
        if (cursor) query.where('_id').gt(cursor);
        const batch = await query.limit(BATCH_SIZE);
        if (!batch.length) break;

        cursor = batch[batch.length - 1]._id;

        // Fetch current Redis values for all pairs in this batch
        const keys    = batch.map(({ userId, postId }) =>
            RedisKeys.userLikedPost(userId.toString(), postId.toString())
        );
        const current = await redisClient.mget(...keys);

        const pipeline = redisClient.pipeline();
        let pipelineDirty = false;

        batch.forEach(({ userId, postId }, i) => {
            const redisVal = current[i];
            // DB says liked ('1'). Fix if Redis says otherwise or is missing.
            if (redisVal !== '1') {
                pipeline.set(
                    RedisKeys.userLikedPost(userId.toString(), postId.toString()),
                    '1',
                    'EX',
                    LIKE_TTL
                );
                fixed++;
                pipelineDirty = true;
            } else {
                skipped++;
            }
        });

        if (pipelineDirty) await pipeline.exec();

        console.log(`[Fix] Like-status — fixed: ${fixed}, already correct: ${skipped}`);
        if (batch.length < BATCH_SIZE) break;
    } while (true);

    console.log(`[Fix] Like-status done — total fixed: ${fixed}, skipped: ${skipped}`);
}

async function fixLikeCountKeys() {
    console.log('\n[Fix] ── Scanning like-count keys ──');

    // Ground truth: aggregate count per postId from DB
    const dbCounts = await Like.aggregate([
        { $group: { _id: '$postId', count: { $sum: 1 } } }
    ]);

    if (!dbCounts.length) {
        console.log('[Fix] No likes in DB — nothing to fix for counts');
        return;
    }

    // Fetch current Redis values in one MGET
    const keys       = dbCounts.map(({ _id }) => RedisKeys.postLikesCount(_id.toString()));
    const redisVals  = await redisClient.mget(...keys);

    const pipeline = redisClient.pipeline();
    let fixed   = 0;
    let correct = 0;

    dbCounts.forEach(({ _id: postId, count }, i) => {
        const redisCount = redisVals[i] !== null ? parseInt(redisVals[i], 10) : null;

        if (redisCount !== count) {
            pipeline.set(RedisKeys.postLikesCount(postId.toString()), count, 'EX', COUNT_TTL);
            if (redisCount !== null) {
                console.log(`[Fix] Count mismatch post ${postId}: Redis=${redisCount}, DB=${count} → fixed`);
            }
            fixed++;
        } else {
            correct++;
        }
    });

    if (fixed > 0) await pipeline.exec();

    console.log(`[Fix] Like-count done — fixed: ${fixed}, already correct: ${correct}`);
}

async function run() {
    console.log('[Fix] Connecting to DB...');
    await connectDB();

    console.log('[Fix] Starting Redis like imbalance fix...');
    const start = Date.now();

    await fixLikeStatusKeys();
    await fixLikeCountKeys();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Fix] All done in ${elapsed}s`);

    await redisClient.quit();
    process.exit(0);
}

run().catch(err => {
    console.error('[Fix] Fatal error:', err);
    process.exit(1);
});
