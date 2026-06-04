/**
 * Sync script: seeds Redis with the full liked-list and like-status from DB.
 *
 * Run:  node scripts/seedLikesToRedis.js
 *
 * What it writes:
 *   fn:user:{userId}:liked          Set    members = postIds the user has liked
 *   fn:post:{postId}:likedby        Hash   field=userId  value=JSON profile
 *   fn:post:{postId}:likes:count    String value=N
 */

import 'dotenv/config';
import connectDB from '../src/db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../src/config/redis.config.js';
import Like from '../src/models/like.models.js';
import {User} from '../src/models/user.models.js';

const BATCH_SIZE = 1000;
const MAX_LIKEDBY = 50;
const LIKE_TTL = RedisTTL.POST_LIKE_STATUS;
const ENG_TTL = RedisTTL.POST_ENGAGEMENT;

export async function seedLikesToRedis() {
    console.log('[SeedLikes] Starting DB → Redis sync...');

    // ── Step 1: per-user liked Hash ──────────────────────────────────────────
    // fn:user:{userId}:liked  →  { [postId]: '1' }
    // Process in cursor-batches to avoid loading everything into memory.

    let cursor = null;
    let userKeyCount = 0;

    console.log('[SeedLikes] Step 1/3 — writing per-user liked Sets...');
    do {
        const query = Like.find({ postId: { $ne: null } }).select('userId postId').lean();
        if (cursor) query.where('_id').gt(cursor);
        const batch = await query.limit(BATCH_SIZE);
        if (!batch.length) break;
        cursor = batch[batch.length - 1]._id;

        // Group postIds by userId
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
    console.log(`[SeedLikes] Step 1 done — ${userKeyCount} user Sets written`);

    // ── Step 2: per-post like count ──────────────────────────────────────────
    console.log('[SeedLikes] Step 2/3 — writing per-post like counts...');
    const counts = await Like.aggregate([
        { $match: { postId: { $ne: null } } },
        { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    if (counts.length) {
        const pipeline = redisClient.pipeline();
        for (const { _id: postId, count } of counts) {
            pipeline.set(RedisKeys.postLikesCount(postId.toString()), count, 'EX', ENG_TTL);
        }
        await pipeline.exec();
    }
    console.log(`[SeedLikes] Step 2 done — ${counts.length} count keys written`);

    // ── Step 3: per-post likedBy Hash ────────────────────────────────────────
    // fn:post:{postId}:likedby  →  { [userId]: JSON{_id,userId,username,fullName,profileImageUrl,likedAt} }
    // Sorted newest-first, capped at MAX_LIKEDBY per post.
    console.log('[SeedLikes] Step 3/3 — writing per-post likedBy Hashes...');

    // Process in post-id batches derived from the count aggregation above.
    const postIds = counts.map(c => c._id);
    const POST_CHUNK = 200; // posts per chunk
    let likedByKeyCount = 0;

    for (let i = 0; i < postIds.length; i += POST_CHUNK) {
        const chunk = postIds.slice(i, i + POST_CHUNK);

        // Fetch likes for this chunk of posts, newest-first, capped at MAX_LIKEDBY each.
        // Use an aggregation that limits per postId.
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
                $project: {
                    likers: { $slice: ['$likers', MAX_LIKEDBY] },
                },
            },
        ]);

        // Collect all unique userIds needed for profile lookup
        const allUserIds = [...new Set(
            dbLikes.flatMap(g => g.likers.map(l => l.userId.toString()))
        )];

        const profiles = allUserIds.length
            ? await User.find(
                { _id: { $in: allUserIds } },
                'username fullName profileImageUrl'
            ).lean()
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
    console.log(`[SeedLikes] Step 3 done — ${likedByKeyCount} likedBy Hashes written`);

    console.log('[SeedLikes] Sync complete.');
}

if (process.argv[1].includes('seedLikesToRedis')) {
    connectDB()
        .then(() => seedLikesToRedis())
        .then(() => { redisClient.quit(); process.exit(0); })
        .catch(err => { console.error('[SeedLikes] Fatal:', err); process.exit(1); });
}
