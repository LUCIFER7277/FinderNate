/**
 * One-time (or periodic) warm-up script: seeds Redis with the current follower/following
 * state so that getFollowers, getFollowing, and onUserFollowed/onUserUnfollowed all have
 * accurate LIST and count data without hitting the DB on cold start.
 *
 * Run manually:  node src/scripts/seedFollowersToRedis.js
 * Or call seedFollowersToRedis() at server startup after connectDB().
 *
 * What it writes per user:
 *   fn:user:{userId}:followers       — Redis LIST of up to 15 newest follower IDs (TTL: 12 days)
 *   fn:user:{userId}:following       — Redis LIST of up to 15 newest following IDs (TTL: 12 days)
 *   fn:user:{userId}:followers:count — STRING count of total followers (TTL: 7 days)
 *   fn:user:{userId}:following:count — STRING count of total following (TTL: 7 days)
 *
 * Temp SETs (followers:temp, following:temp, follows:temp:active) are DELeted so they
 * start clean — any in-flight temp data that hasn't been flushed will be re-created by
 * the next follow/unfollow operations.
 */

import 'dotenv/config';
import connectDB from '../db/index.js';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Follower from '../models/follower.models.js';
import { User } from '../models/user.models.js';

const USER_BATCH_SIZE = 200;
const LIST_TTL = 12 * 24 * 60 * 60;   // 12 days
const COUNT_TTL = RedisTTL.FOLLOW_COUNT; // 7 days

export async function seedFollowersToRedis() {
    console.log('[SeedFollowers] Starting Redis warm-up from DB...');

    let processed = 0;
    let cursor = null;

    do {
        // Fetch users in batches using cursor-based pagination
        const query = User.find({}).select('_id').lean();
        if (cursor) query.where('_id').gt(cursor);
        const userBatch = await query.limit(USER_BATCH_SIZE);

        if (!userBatch.length) break;
        cursor = userBatch[userBatch.length - 1]._id;

        for (const { _id: userId } of userBatch) {
            const userIdStr = userId.toString();

            try {
                // ── Top-15 followers (newest first) ──────────────────────────
                const [top15Followers, top15Following, followersCount, followingCount] = await Promise.all([
                    Follower.find({ userId })
                        .sort({ createdAt: -1 })
                        .limit(15)
                        .select('followerId')
                        .lean(),
                    Follower.find({ followerId: userId })
                        .sort({ createdAt: -1 })
                        .limit(15)
                        .select('userId')
                        .lean(),
                    Follower.countDocuments({ userId }),
                    Follower.countDocuments({ followerId: userId }),
                ]);

                const followersListKey = RedisKeys.userFollowers(userIdStr);
                const followingListKey = RedisKeys.userFollowing(userIdStr);
                const followersTempKey = RedisKeys.followersTemp(userIdStr);
                const followingTempKey = RedisKeys.followingTemp(userIdStr);
                const followersCountKey = RedisKeys.userFollowersCount(userIdStr);
                const followingCountKey = RedisKeys.userFollowingCount(userIdStr);

                const pipeline = redisClient.pipeline();

                // Seed followers LIST (DEL first to avoid stale data)
                pipeline.del(followersListKey);
                if (top15Followers.length) {
                    // RPUSH in sorted order (newest→oldest from DB), so list index 0 = newest
                    pipeline.rpush(followersListKey, ...top15Followers.map(f => f.followerId.toString()));
                    pipeline.expire(followersListKey, LIST_TTL);
                }

                // Seed following LIST
                pipeline.del(followingListKey);
                if (top15Following.length) {
                    pipeline.rpush(followingListKey, ...top15Following.map(f => f.userId.toString()));
                    pipeline.expire(followingListKey, LIST_TTL);
                }

                // Seed count keys
                pipeline.set(followersCountKey, followersCount, 'EX', COUNT_TTL);
                pipeline.set(followingCountKey, followingCount, 'EX', COUNT_TTL);

                // Clear any stale temp SETs for this user
                pipeline.del(followersTempKey);
                pipeline.del(followingTempKey);

                await pipeline.exec();
                processed++;
            } catch (err) {
                console.error(`[SeedFollowers] Error seeding user ${userIdStr}:`, err.message);
            }
        }

        console.log(`[SeedFollowers] Users processed: ${processed}`);

        if (userBatch.length < USER_BATCH_SIZE) break;
    } while (true);

    // Clear the global temp:active tracking SET so the cron starts fresh
    try {
        await redisClient.del(RedisKeys.followTempActiveUsers());
    } catch (err) {
        console.error('[SeedFollowers] Could not clear temp:active set:', err.message);
    }

    console.log(`[SeedFollowers] Done — seeded ${processed} users`);
}

// Allow direct execution: node src/scripts/seedFollowersToRedis.js
if (process.argv[1].includes('seedFollowersToRedis')) {
    connectDB()
        .then(() => seedFollowersToRedis())
        .then(() => {
            redisClient.quit();
            process.exit(0);
        })
        .catch(err => {
            console.error('[SeedFollowers] Fatal:', err);
            process.exit(1);
        });
}
