/**
 * seedRedisEngagement.js
 *
 * One-time (idempotent) script to seed Redis engagement keys from the current DB state.
 * Safe to re-run — uses SET NX (not overwrite) for per-user like-status keys, and
 * SET NX for counts/likedBy so live Redis state is never clobbered.
 *
 * Keys written:
 *   fn:like:{userId}:{postId}          = '1'   (per-user like status)
 *   fn:post:{postId}:likes:count       = N      (total likes per post)
 *   fn:post:{postId}:likedby           = JSON   (array of liker userId strings, max 50)
 *   fn:post:{postId}:comments:count    = N      (non-deleted comments per post)
 *
 * Usage:
 *   node scripts/seedRedisEngagement.js
 *   node scripts/seedRedisEngagement.js --force   (overwrite existing keys)
 *   node scripts/seedRedisEngagement.js --dry-run (report counts only, no writes)
 */

import mongoose from 'mongoose';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ── Config ────────────────────────────────────────────────────────────────────
const BATCH_SIZE = 500;          // Like docs per batch
const MAX_LIKEDBY = 50;          // Max liker IDs stored per post
const ENGAGEMENT_TTL = 7 * 24 * 60 * 60;   // 7 days (matches RedisTTL.POST_ENGAGEMENT)
const LIKE_STATUS_TTL = 7 * 24 * 60 * 60;  // 7 days (matches RedisTTL.POST_LIKE_STATUS)

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Models (inline — avoids importing the full app) ───────────────────────────
const LikeSchema = new mongoose.Schema({
    userId:  { type: mongoose.Schema.Types.ObjectId, required: true },
    postId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    commentId: { type: mongoose.Schema.Types.ObjectId, default: null },
});
const Like = mongoose.model('Like', LikeSchema);

const CommentSchema = new mongoose.Schema({
    postId:    { type: mongoose.Schema.Types.ObjectId },
    isDeleted: { type: Boolean, default: false },
});
const Comment = mongoose.model('Comment', CommentSchema);

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = new Redis({
    host:     process.env.REDIS_HOST || 'localhost',
    port:     parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db:       parseInt(process.env.REDIS_DB) || 0,
    lazyConnect: false,
});

redis.on('error', (err) => console.error('[Redis]', err.message));

// ── Key helpers ───────────────────────────────────────────────────────────────
const Keys = {
    userLikedPost:    (uid, pid) => `fn:like:${uid}:${pid}`,
    postLikesCount:   (pid)      => `fn:post:${pid}:likes:count`,
    postLikedBy:      (pid)      => `fn:post:${pid}:likedby`,
    postCommentsCount:(pid)      => `fn:post:${pid}:comments:count`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => n.toLocaleString();

async function setIfAbsent(key, value, ttl, pipeline) {
    if (FORCE) {
        pipeline.set(key, value, 'EX', ttl);
    } else {
        // NX = only write if key does not already exist
        pipeline.set(key, value, 'EX', ttl, 'NX');
    }
}

// ── Phase 1: Seed per-user like-status keys + build per-post maps ─────────────
async function seedLikes() {
    console.log('\n── Phase 1: Like-status keys + like-count + likedBy ──');

    // Per-post accumulators (built in memory before writing)
    const likeCountMap = new Map();   // postIdStr → count
    const likedByMap   = new Map();   // postIdStr → userId[] (last MAX_LIKEDBY only)

    let totalLikes = 0;
    let statusKeysWritten = 0;
    let cursor = null;
    let batchNum = 0;

    // Cursor-based iteration over all post-likes (skip comment-likes)
    const query = Like.find({ postId: { $exists: true, $ne: null } })
                      .select('userId postId')
                      .lean()
                      .cursor();

    const pipelineBatch = [];

    for await (const doc of query) {
        const uid = doc.userId.toString();
        const pid = doc.postId.toString();

        // Per-post accumulators
        likeCountMap.set(pid, (likeCountMap.get(pid) || 0) + 1);
        if (!likedByMap.has(pid)) likedByMap.set(pid, []);
        likedByMap.get(pid).push(uid);

        // Queue per-user status key
        pipelineBatch.push([uid, pid]);
        totalLikes++;

        // Flush per-user keys in BATCH_SIZE chunks
        if (pipelineBatch.length >= BATCH_SIZE) {
            if (!DRY_RUN) {
                const pl = redis.pipeline();
                for (const [u, p] of pipelineBatch) {
                    await setIfAbsent(Keys.userLikedPost(u, p), '1', LIKE_STATUS_TTL, pl);
                }
                await pl.exec();
            }
            statusKeysWritten += pipelineBatch.length;
            pipelineBatch.length = 0;
            process.stdout.write(`\r  Processed ${fmt(totalLikes)} likes...`);
        }
    }

    // Flush remainder
    if (pipelineBatch.length > 0) {
        if (!DRY_RUN) {
            const pl = redis.pipeline();
            for (const [u, p] of pipelineBatch) {
                await setIfAbsent(Keys.userLikedPost(u, p), '1', LIKE_STATUS_TTL, pl);
            }
            await pl.exec();
        }
        statusKeysWritten += pipelineBatch.length;
    }

    process.stdout.write(`\r  Processed ${fmt(totalLikes)} likes total.        \n`);
    console.log(`  Like-status keys: ${fmt(statusKeysWritten)} (${DRY_RUN ? 'dry-run, not written' : FORCE ? 'force-overwritten' : 'written NX'})`);

    // Write per-post like counts and likedBy arrays
    console.log(`  Distinct posts: ${fmt(likeCountMap.size)}`);

    if (!DRY_RUN) {
        let i = 0;
        const postIds = [...likeCountMap.keys()];
        while (i < postIds.length) {
            const chunk = postIds.slice(i, i + BATCH_SIZE);
            const pl = redis.pipeline();
            for (const pid of chunk) {
                await setIfAbsent(Keys.postLikesCount(pid), likeCountMap.get(pid), ENGAGEMENT_TTL, pl);
                const likers = (likedByMap.get(pid) || []).slice(-MAX_LIKEDBY);
                await setIfAbsent(Keys.postLikedBy(pid), JSON.stringify(likers), ENGAGEMENT_TTL, pl);
            }
            await pl.exec();
            i += chunk.length;
        }
    }

    console.log(`  Post like-count keys: ${fmt(likeCountMap.size)}`);
    console.log(`  Post likedBy keys:    ${fmt(likeCountMap.size)}`);

    return likeCountMap.size;
}

// ── Phase 2: Seed comment-count keys ─────────────────────────────────────────
async function seedCommentCounts() {
    console.log('\n── Phase 2: Comment-count keys ──');

    const dbCounts = await Comment.aggregate([
        { $match: { isDeleted: false, postId: { $exists: true, $ne: null } } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    console.log(`  Posts with comments: ${fmt(dbCounts.length)}`);

    if (!DRY_RUN) {
        let i = 0;
        while (i < dbCounts.length) {
            const chunk = dbCounts.slice(i, i + BATCH_SIZE);
            const pl = redis.pipeline();
            for (const row of chunk) {
                await setIfAbsent(Keys.postCommentsCount(row._id.toString()), row.count, ENGAGEMENT_TTL, pl);
            }
            await pl.exec();
            i += chunk.length;
        }
    }

    console.log(`  Comment-count keys: ${fmt(dbCounts.length)}`);
    return dbCounts.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== seedRedisEngagement ===');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : FORCE ? 'FORCE (overwrite existing)' : 'NORMAL (NX — skip existing)'}`);

    console.log('\nConnecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    await redis.ping(); // Throws if Redis is unreachable
    console.log('Connected to Redis');

    const t0 = Date.now();

    const postsWithLikes    = await seedLikes();
    const postsWithComments = await seedCommentCounts();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Done in ${elapsed}s`);
    console.log(`   Posts seeded (likes):    ${fmt(postsWithLikes)}`);
    console.log(`   Posts seeded (comments): ${fmt(postsWithComments)}`);
    if (DRY_RUN) console.log('   (dry-run — nothing was written to Redis)');
}

main()
    .catch((err) => { console.error('\n❌ Error:', err); process.exit(1); })
    .finally(async () => {
        await mongoose.disconnect();
        redis.disconnect();
    });
