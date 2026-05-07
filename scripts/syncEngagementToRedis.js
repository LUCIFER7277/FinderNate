/**
 * Full engagement sync: writes like counts, comment counts, per-user liked Sets,
 * and per-post likedBy Hashes from DB → Redis.
 *
 * Run manually:  node scripts/syncEngagementToRedis.js
 *
 * What it writes:
 *   fn:post:{postId}:likes:count    String  N               (TTL: POST_ENGAGEMENT)
 *   fn:post:{postId}:comments:count String  N               (TTL: POST_ENGAGEMENT)
 *   fn:user:{userId}:liked          Set     members=postIds (TTL: POST_LIKE_STATUS)
 *   fn:post:{postId}:likedby        Hash    field=userId value=JSON profile (TTL: POST_ENGAGEMENT)
 */

import 'dotenv/config';
import connectDB from '../src/db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../src/config/redis.config.js';
import Like from '../src/models/like.models.js';
import Comment from '../src/models/comment.models.js';
import { User } from '../src/models/user.models.js';

const ENG_TTL  = RedisTTL.POST_ENGAGEMENT;
const LIKE_TTL = RedisTTL.POST_LIKE_STATUS;
const BATCH_SIZE   = 1000;
const MAX_LIKEDBY  = 50;
const POST_CHUNK   = 200;

export async function syncEngagementToRedis() {
    console.log('[SyncEngagement] Starting DB → Redis sync...');

    // ── 1. Like counts ───────────────────────────────────────────────────────
    console.log('[SyncEngagement] Step 1/4 — writing per-post like counts...');
    const likeCounts = await Like.aggregate([
        { $match: { postId: { $ne: null } } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    {
        const pipeline = redisClient.pipeline();
        for (const { _id: postId, count } of likeCounts) {
            if (!postId) continue;
            pipeline.set(RedisKeys.postLikesCount(postId.toString()), count, 'EX', ENG_TTL);
        }
        await pipeline.exec();
    }
    console.log(`[SyncEngagement] Step 1 done — ${likeCounts.length} like-count keys`);

    // ── 2. Comment counts (top-level only) ───────────────────────────────────
    console.log('[SyncEngagement] Step 2/4 — writing per-post comment counts...');
    const commentCounts = await Comment.aggregate([
        { $match: { parentCommentId: null } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    {
        const pipeline = redisClient.pipeline();
        for (const { _id: postId, count } of commentCounts) {
            if (!postId) continue;
            pipeline.set(RedisKeys.postCommentsCount(postId.toString()), count, 'EX', ENG_TTL);
        }
        await pipeline.exec();
    }
    console.log(`[SyncEngagement] Step 2 done — ${commentCounts.length} comment-count keys`);

    // ── 3. Per-user liked Sets ────────────────────────────────────────────────
    // fn:user:{userId}:liked  →  Set{ postId, ... }
    console.log('[SyncEngagement] Step 3/4 — writing per-user liked Sets...');
    let cursor = null;
    let userKeyCount = 0;

    do {
        const query = Like.find({ postId: { $ne: null } }).select('userId postId').lean();
        if (cursor) query.where('_id').gt(cursor);
        const batch = await query.limit(BATCH_SIZE);
        if (!batch.length) break;
        cursor = batch[batch.length - 1]._id;

        const byUser = new Map();
        for (const { userId, postId } of batch) {
            if (!userId || !postId) continue;
            const uid = userId.toString();
            if (!byUser.has(uid)) byUser.set(uid, []);
            byUser.get(uid).push(postId.toString());
        }

        const pipeline = redisClient.pipeline();
        for (const [uid, postIds] of byUser) {
            const setKey = RedisKeys.userLikedSet(uid);
            pipeline.sadd(setKey, ...postIds);
            pipeline.expire(setKey, LIKE_TTL);
            userKeyCount++;
        }
        await pipeline.exec();
        if (batch.length < BATCH_SIZE) break;
    } while (true);

    console.log(`[SyncEngagement] Step 3 done — ${userKeyCount} user liked Sets`);

    // ── 4. Per-post likedBy Hashes ────────────────────────────────────────────
    // fn:post:{postId}:likedby  →  { [userId]: JSON{profile + likedAt} }
    // Capped at MAX_LIKEDBY newest likers per post.
    console.log('[SyncEngagement] Step 4/4 — writing per-post likedBy Hashes...');
    const postIds = likeCounts.map(c => c._id).filter(Boolean);
    let likedByKeyCount = 0;

    for (let i = 0; i < postIds.length; i += POST_CHUNK) {
        const chunk = postIds.slice(i, i + POST_CHUNK);

        const dbLikes = await Like.aggregate([
            { $match: { postId: { $in: chunk } } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: '$postId',
                    likers: { $push: { userId: '$userId', createdAt: '$createdAt' } },
                },
            },
            {
                $project: { likers: { $slice: ['$likers', MAX_LIKEDBY] } },
            },
        ]);

        const allUserIds = [...new Set(
            dbLikes.flatMap(g => g.likers.map(l => l.userId.toString()))
        )];

        const profiles = allUserIds.length
            ? await User.find({ _id: { $in: allUserIds } }, 'username fullName profileImageUrl').lean()
            : [];
        const profileMap = new Map(profiles.map(u => [u._id.toString(), u]));

        const pipeline = redisClient.pipeline();
        for (const { _id: postId, likers } of dbLikes) {
            const likedByKey = RedisKeys.postLikedBy(postId.toString());
            const args = [likedByKey];
            for (const { userId, createdAt } of likers) {
                const uid = userId.toString();
                const profile = profileMap.get(uid);
                if (!profile) continue;
                args.push(uid, JSON.stringify({
                    _id: uid,
                    userId: uid,
                    username: profile.username,
                    fullName: profile.fullName,
                    profileImageUrl: profile.profileImageUrl,
                    likedAt: createdAt ? new Date(createdAt).getTime() : Date.now(),
                }));
            }
            if (args.length > 1) {
                pipeline.hset(...args);
                pipeline.expire(likedByKey, ENG_TTL);
                likedByKeyCount++;
            }
        }
        await pipeline.exec();
    }

    console.log(`[SyncEngagement] Step 4 done — ${likedByKeyCount} likedBy Hashes`);
    console.log('[SyncEngagement] Sync complete.');
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
