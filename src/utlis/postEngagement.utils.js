import mongoose from 'mongoose';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';
import Comment from '../models/comment.models.js';
import { getLikedByPreview } from './likedByPreview.utils.js';

const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;
const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;
// Max liker userIds stored in the likedBy cache per post
const MAX_LIKEDBY = 50;

/**
 * Batch-check whether the current user has liked each post.
 *
 * Strategy (3-tier):
 *   '1'  in Redis  → liked
 *   '0'  in Redis  → not liked (cached negative)
 *   null in Redis  → unknown → single batch DB query, then cache results
 *
 * Returns a Set of postId strings the user has liked.
 */
export async function batchIsLikedByUser(userId, postIds) {
    if (!userId || !postIds.length) return new Set();

    const userIdStr = userId.toString();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];

    try {
        const keys = idStrs.map(id => RedisKeys.userLikedPost(userIdStr, id));
        const values = await redisClient.mget(...keys);

        const liked = new Set();
        const unknownIds = [];

        values.forEach((val, i) => {
            if (val === '1') liked.add(idStrs[i]);
            else if (val === null) unknownIds.push(idStrs[i]);
            // val === '0' → confirmed not liked, skip
        });

        if (unknownIds.length > 0) {
            // DB is the fallback source of truth for like status.
            // Unlikes are written to DB immediately (not deferred), so DB is always accurate for unlikes.
            // Likes are deferred (4h cron), so a recently-liked post may briefly show as not-liked
            // if the status key is evicted — acceptable trade-off vs. a false "liked" on unlike.
            const dbLikes = await Like.find({ userId, postId: { $in: unknownIds } }).select('postId').lean();
            const dbLikedSet = new Set(dbLikes.map(l => l.postId.toString()));

            const pipeline = redisClient.pipeline();
            for (const id of unknownIds) {
                const isLiked = dbLikedSet.has(id);
                pipeline.set(RedisKeys.userLikedPost(userIdStr, id), isLiked ? '1' : '0', 'EX', LIKE_STATUS_TTL);
                if (isLiked) liked.add(id);
            }
            await pipeline.exec();
        }

        return liked;
    } catch (err) {
        console.error('[PostEngagement] batchIsLikedByUser error:', err.message);
        try {
            const dbLikes = await Like.find({ userId, postId: { $in: postIds } }).select('postId').lean();
            return new Set(dbLikes.map(l => l.postId.toString()));
        } catch {
            return new Set();
        }
    }
}

/**
 * Batch-get like counts for a list of items (posts or reels).
 * Redis MGET first; falls back to the embedded engagement.likes value already on the document.
 *
 * Returns a Map<postIdStr, count>.
 */
export async function batchGetLikesCount(items) {
    if (!items.length) return new Map();
    const seen = new Set();
    const unique = items.filter(i => {
        const id = i._id.toString();
        return seen.has(id) ? false : seen.add(id);
    });
    const idStrs = unique.map(i => i._id.toString());

    try {
        const keys = idStrs.map(id => RedisKeys.postLikesCount(id));
        const values = await redisClient.mget(...keys);

        const counts = new Map();
        const missedIds = [];
        const missedItems = [];

        values.forEach((val, i) => {
            if (val !== null) {
                counts.set(idStrs[i], parseInt(val, 10));
            } else {
                missedIds.push(idStrs[i]);
                missedItems.push(unique[i]);
            }
        });

        // Seed missing keys from the DB-embedded count (updated by 4-hourly cron).
        // Caching on miss ensures the next call (within TTL) is a Redis hit.
        if (missedIds.length) {
            const pipeline = redisClient.pipeline();
            missedIds.forEach((id, i) => {
                const dbCount = missedItems[i].engagement?.likes ?? 0;
                counts.set(id, dbCount);
                pipeline.set(RedisKeys.postLikesCount(id), dbCount, 'EX', ENGAGEMENT_TTL);
            });
            await pipeline.exec();
        }

        return counts;
    } catch (err) {
        console.error('[PostEngagement] batchGetLikesCount error:', err.message);
        const counts = new Map();
        items.forEach(item => counts.set(item._id.toString(), item.engagement?.likes ?? 0));
        return counts;
    }
}

/**
 * Batch-get comment counts for a list of items.
 * Redis MGET first; seeds from DB on cache miss; falls back to engagement.comments.
 *
 * Returns a Map<postIdStr, count>.
 */
export async function batchGetCommentsCount(items) {
    if (!items.length) return new Map();
    const seen = new Set();
    const unique = items.filter(i => {
        const id = i._id.toString();
        return seen.has(id) ? false : seen.add(id);
    });
    const idStrs = unique.map(i => i._id.toString());

    try {
        const keys = idStrs.map(id => RedisKeys.postCommentsCount(id));
        const values = await redisClient.mget(...keys);

        const counts = new Map();
        const missedIds = [];
        const missedItems = [];

        values.forEach((val, i) => {
            if (val !== null) {
                counts.set(idStrs[i], parseInt(val, 10));
            } else {
                missedIds.push(idStrs[i]);
                missedItems.push(unique[i]);
            }
        });

        if (missedIds.length) {
            // Seed from DB — count non-deleted comments per post
            const missedOids = missedIds.map(id => new mongoose.Types.ObjectId(id));
            const dbCounts = await Comment.aggregate([
                { $match: { postId: { $in: missedOids }, isDeleted: false } },
                { $group: { _id: '$postId', count: { $sum: 1 } } }
            ]);

            const dbMap = new Map(dbCounts.map(r => [r._id.toString(), r.count]));
            const pipeline = redisClient.pipeline();

            missedIds.forEach((id, i) => {
                const count = dbMap.get(id) ?? (missedItems[i].engagement?.comments ?? 0);
                counts.set(id, count);
                pipeline.set(RedisKeys.postCommentsCount(id), count, 'EX', ENGAGEMENT_TTL);
            });
            await pipeline.exec();
        }

        return counts;
    } catch (err) {
        console.error('[PostEngagement] batchGetCommentsCount error:', err.message);
        const counts = new Map();
        items.forEach(item => counts.set(item._id.toString(), item.engagement?.comments ?? 0));
        return counts;
    }
}

/**
 * Batch-get likedBy userIds for multiple posts.
 * Redis-first: parses JSON array from fn:post:{postId}:likedby.
 * On cache miss, seeds from DB (Like collection) and caches (capped at MAX_LIKEDBY).
 *
 * Returns a Map<postIdStr, string[]> of userId strings.
 */
export async function batchGetLikedByUserIds(postIds) {
    if (!postIds.length) return new Map();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];

    try {
        const keys = idStrs.map(id => RedisKeys.postLikedBy(id));
        const values = await redisClient.mget(...keys);

        const map = new Map();
        const missedIds = [];

        values.forEach((val, i) => {
            if (val !== null) {
                try {
                    map.set(idStrs[i], JSON.parse(val));
                } catch {
                    missedIds.push(idStrs[i]);
                }
            } else {
                missedIds.push(idStrs[i]);
            }
        });

        if (missedIds.length) {
            const dbLikes = await Like.find({ postId: { $in: missedIds } })
                .select('postId userId').lean();

            const byPost = new Map(missedIds.map(id => [id, []]));
            dbLikes.forEach(l => {
                const pid = l.postId.toString();
                byPost.get(pid)?.push(l.userId.toString());
            });

            const pipeline = redisClient.pipeline();
            missedIds.forEach(id => {
                const userIds = (byPost.get(id) || []).slice(-MAX_LIKEDBY);
                map.set(id, userIds);
                pipeline.set(RedisKeys.postLikedBy(id), JSON.stringify(userIds), 'EX', ENGAGEMENT_TTL);
            });
            await pipeline.exec();
        }

        return map;
    } catch (err) {
        console.error('[PostEngagement] batchGetLikedByUserIds error:', err.message);
        const map = new Map();
        try {
            const dbLikes = await Like.find({ postId: { $in: postIds } }).select('postId userId').lean();
            idStrs.forEach(id => map.set(id, []));
            dbLikes.forEach(l => map.get(l.postId.toString())?.push(l.userId.toString()));
        } catch {}
        return map;
    }
}

/**
 * Stitch live engagement into an array of content items (posts or reels).
 * Used by search and any route that needs a unified engagement stitch.
 * Stitches: isLikedByCurrentUser, likes count, comments count, likedBy list, likedByPreview.
 * Falls back to DB at every layer if Redis is unavailable.
 */
export async function stitchEngagement(userId, items) {
    if (!items || !items.length) return items;

    const [likedSet, likeCountMap, commentCountMap, likedByIdsMap] = await Promise.all([
        batchIsLikedByUser(userId, items.map(i => i._id)),
        batchGetLikesCount(items),
        batchGetCommentsCount(items),
        batchGetLikedByUserIds(items.map(i => i._id)),
    ]);

    // Inject current user into likedByIdsMap for posts they liked whose like is still
    // deferred in Redis (not yet synced to DB, so the cache seed may have missed them)
    if (userId) {
        const userIdStr = userId.toString();
        for (const [idStr, userIds] of likedByIdsMap) {
            if (likedSet.has(idStr) && !userIds.includes(userIdStr)) {
                userIds.push(userIdStr);
            }
        }
    }

    // Fetch liker profiles + current user's social graph in parallel
    const allLikerIds = [...new Set([...likedByIdsMap.values()].flat())];
    const UserModel = Post.db.model('User');
    const [likerProfiles, me] = await Promise.all([
        allLikerIds.length
            ? UserModel.find({ _id: { $in: allLikerIds } }, 'username fullName profileImageUrl').lean()
            : Promise.resolve([]),
        userId
            ? UserModel.findById(userId, 'following followers').lean()
            : Promise.resolve(null),
    ]);

    const profileMap = new Map(likerProfiles.map(u => [u._id.toString(), u]));
    const userFollowing = me?.following || [];
    const userFollowers = me?.followers || [];

    return items.map(item => {
        const idStr = item._id.toString();
        const likedByUsers = (likedByIdsMap.get(idStr) || []).map(uid => profileMap.get(uid)).filter(Boolean);
        const preview = getLikedByPreview(likedByUsers, userId ? userId.toString() : null, userFollowing, userFollowers);
        return {
            ...item,
            engagement: {
                ...(item.engagement || {}),
                likes: likeCountMap.get(idStr) ?? item.engagement?.likes ?? 0,
                comments: commentCountMap.get(idStr) ?? item.engagement?.comments ?? 0,
            },
            isLikedBy: userId ? likedSet.has(idStr) : false,
            likedBy: likedByUsers,
            likedByPreview: preview.likedByText ? {
                text: preview.likedByText,
                previewUser: preview.previewUser,
                othersCount: preview.othersCount,
            } : null,
        };
    });
}

/**
 * Call this when a user likes a post.
 * Writes '1' to the like-status key, marks dirty for 4-hourly DB sync,
 * increments the like count if the count key exists, and adds userId to the
 * likedBy cache if that key exists.
 */
export async function onPostLiked(userId, postId) {
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();
    const dirtyKey = RedisKeys.likesDirty();
    try {
        const pipeline = redisClient.pipeline();
        pipeline.set(RedisKeys.userLikedPost(userIdStr, postIdStr), '1', 'EX', LIKE_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${userIdStr}:${postIdStr}`);
        // 25h safety TTL — cron runs every 4h, prevents key living forever if cron skips
        pipeline.expire(dirtyKey, 25 * 60 * 60);
        await pipeline.exec();

        const countKey = RedisKeys.postLikesCount(postIdStr);
        if (await redisClient.exists(countKey)) {
            const p2 = redisClient.pipeline();
            p2.incr(countKey);
            p2.expire(countKey, ENGAGEMENT_TTL);
            await p2.exec();
        }

        // Update likedBy cache — seed from DB if key missing, then add userId
        try {
            const likedByKey = RedisKeys.postLikedBy(postIdStr);
            const current = await redisClient.get(likedByKey);
            if (current !== null) {
                const arr = JSON.parse(current);
                if (!arr.includes(userIdStr)) {
                    arr.push(userIdStr);
                    await redisClient.set(likedByKey, JSON.stringify(arr.slice(-MAX_LIKEDBY)), 'EX', ENGAGEMENT_TTL);
                }
            } else {
                // Key not seeded yet — fetch from DB, add current user (who is not in DB yet)
                const dbLikes = await Like.find({ postId: postIdStr }).select('userId').lean();
                const existing = dbLikes.map(l => l.userId.toString()).filter(id => id !== userIdStr);
                const arr = [...existing, userIdStr].slice(-MAX_LIKEDBY);
                await redisClient.set(likedByKey, JSON.stringify(arr), 'EX', ENGAGEMENT_TTL);
            }
        } catch (_) {}

        return true;
    } catch (err) {
        console.error('[PostEngagement] onPostLiked error:', err.message);
        return false;
    }
}

/**
 * Call this when a user unlikes a post.
 * Writes '0' to the like-status key, marks dirty for 4-hourly sync,
 * decrements the like count if the count key exists, and removes userId from
 * the likedBy cache if that key exists.
 */
export async function onPostUnliked(userId, postId) {
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();
    const dirtyKey = RedisKeys.likesDirty();
    try {
        const pipeline = redisClient.pipeline();
        pipeline.set(RedisKeys.userLikedPost(userIdStr, postIdStr), '0', 'EX', LIKE_STATUS_TTL);
        pipeline.sadd(dirtyKey, `${userIdStr}:${postIdStr}`);
        pipeline.expire(dirtyKey, 25 * 60 * 60);
        await pipeline.exec();

        const countKey = RedisKeys.postLikesCount(postIdStr);
        if (await redisClient.exists(countKey)) {
            const next = await redisClient.decr(countKey);
            if (next < 0) await redisClient.set(countKey, 0, 'EX', ENGAGEMENT_TTL);
            else await redisClient.expire(countKey, ENGAGEMENT_TTL);
        }

        // Immediately delete from DB so the DB fallback in batchIsLikedByUser is always accurate.
        // (Likes are deferred to the 4h cron; unlikes must be synchronous to prevent stale "liked" state.)
        await Like.deleteOne({ userId, postId }).catch(() => {});

        // Update likedBy cache — seed from DB if key missing, then remove userId
        try {
            const likedByKey = RedisKeys.postLikedBy(postIdStr);
            const current = await redisClient.get(likedByKey);
            if (current !== null) {
                const arr = JSON.parse(current).filter(id => id !== userIdStr);
                await redisClient.set(likedByKey, JSON.stringify(arr), 'EX', ENGAGEMENT_TTL);
            } else {
                // Seed from DB (Like was just deleted above, so current user is no longer in DB)
                const dbLikes = await Like.find({ postId: postIdStr }).select('userId').lean();
                const arr = dbLikes.map(l => l.userId.toString()).filter(id => id !== userIdStr).slice(-MAX_LIKEDBY);
                await redisClient.set(likedByKey, JSON.stringify(arr), 'EX', ENGAGEMENT_TTL);
            }
        } catch (_) {}

        return true;
    } catch (err) {
        console.error('[PostEngagement] onPostUnliked error:', err.message);
        return false;
    }
}

/**
 * Call when a comment is created on a post.
 * Increments the Redis comment-count key if it exists; seeds from DB first if not.
 * Also increments Post.engagement.comments in DB.
 */
export async function onCommentCreated(postId) {
    const postIdStr = postId.toString();
    const countKey = RedisKeys.postCommentsCount(postIdStr);
    try {
        const exists = await redisClient.exists(countKey);
        if (!exists) {
            const count = await Comment.countDocuments({ postId, isDeleted: false });
            await redisClient.set(countKey, count, 'EX', ENGAGEMENT_TTL);
        } else {
            await redisClient.incr(countKey);
            await redisClient.expire(countKey, ENGAGEMENT_TTL);
        }
        await Post.updateOne({ _id: postId }, { $inc: { 'engagement.comments': 1 } });
    } catch (err) {
        console.error('[PostEngagement] onCommentCreated error:', err.message);
    }
}

/**
 * Call when a comment is deleted (soft or hard) on a post.
 * Decrements the Redis comment-count key (floor 0); seeds from DB first if not present.
 * Also decrements Post.engagement.comments in DB.
 */
export async function onCommentDeleted(postId) {
    const postIdStr = postId.toString();
    const countKey = RedisKeys.postCommentsCount(postIdStr);
    try {
        const exists = await redisClient.exists(countKey);
        if (!exists) {
            const count = await Comment.countDocuments({ postId, isDeleted: false });
            await redisClient.set(countKey, count, 'EX', ENGAGEMENT_TTL);
        } else {
            const next = await redisClient.decr(countKey);
            if (next < 0) await redisClient.set(countKey, 0, 'EX', ENGAGEMENT_TTL);
            else await redisClient.expire(countKey, ENGAGEMENT_TTL);
        }
        await Post.updateOne(
            { _id: postId, 'engagement.comments': { $gt: 0 } },
            { $inc: { 'engagement.comments': -1 } }
        );
    } catch (err) {
        console.error('[PostEngagement] onCommentDeleted error:', err.message);
    }
}
