import mongoose from 'mongoose';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';
import Comment from '../models/comment.models.js';
import { getLikedByPreview } from './likedByPreview.utils.js';

const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;
const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
// Max liker userIds stored in the likedBy cache per post
const MAX_LIKEDBY = 50;
=======
// Max liker entries stored in the likedBy Hash per post when seeding from DB
const MAX_LIKEDBY = 50;
// How many likers to return from Hash for page-1 preview
const PREVIEW_LIMIT = 20;

// ---------------------------------------------------------------------------
// Lua scripts for atomic like / unlike
// ---------------------------------------------------------------------------

// KEYS: [countKey, userLikedKey, likedByKey, dirtyKey]
// ARGV: [postId, userId, userDataJSON, engTTL, likeTTL, dirtyEntry]
const LIKE_LUA = `
local countKey   = KEYS[1]
local userHash   = KEYS[2]
local likedByKey = KEYS[3]
local dirtyKey   = KEYS[4]
local postId     = ARGV[1]
local userId     = ARGV[2]
local userData   = ARGV[3]
local engTTL     = tonumber(ARGV[4])
local likeTTL    = tonumber(ARGV[5])
local dirty      = ARGV[6]
redis.call('hset', userHash, postId, '1')
redis.call('expire', userHash, likeTTL)
redis.call('sadd', dirtyKey, dirty)
redis.call('expire', dirtyKey, 90000)
if redis.call('exists', countKey) == 1 then
  redis.call('incr', countKey)
  redis.call('expire', countKey, engTTL)
end
redis.call('hset', likedByKey, userId, userData)
redis.call('expire', likedByKey, engTTL)
return 1
`;

// KEYS: [countKey, userLikedKey, likedByKey, dirtyKey]
// ARGV: [postId, userId, engTTL, likeTTL, dirtyEntry]
const UNLIKE_LUA = `
local countKey   = KEYS[1]
local userHash   = KEYS[2]
local likedByKey = KEYS[3]
local dirtyKey   = KEYS[4]
local postId     = ARGV[1]
local userId     = ARGV[2]
local engTTL     = tonumber(ARGV[3])
local likeTTL    = tonumber(ARGV[4])
local dirty      = ARGV[5]
redis.call('hset', userHash, postId, '0')
redis.call('expire', userHash, likeTTL)
redis.call('sadd', dirtyKey, dirty)
redis.call('expire', dirtyKey, 90000)
if redis.call('exists', countKey) == 1 then
  local c = redis.call('decr', countKey)
  if c < 0 then redis.call('set', countKey, '0') end
  redis.call('expire', countKey, engTTL)
end
redis.call('hdel', likedByKey, userId)
return 1
`;

// ---------------------------------------------------------------------------
// batchIsLikedByUser — Hash-based (fn:user:{userId}:liked)
// ---------------------------------------------------------------------------
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js

/**
 * Batch-check whether the current user has liked each post.
 *
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
 * Strategy (3-tier):
 *   '1'  in Redis  → liked
 *   '0'  in Redis  → not liked (cached negative)
 *   null in Redis  → unknown → single batch DB query, then cache results
=======
 * Uses per-user Hash `fn:user:{userId}:liked` (field=postId, value='1'/'0').
 * On cache miss falls back to DB and seeds the Hash.
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
 *
 * Returns a Set of postId strings the user has liked.
 */
export async function batchIsLikedByUser(userId, postIds) {
    if (!userId || !postIds.length) return new Set();

    const userIdStr = userId.toString();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];
<<<<<<< HEAD:src/utlis/postEngagement.utils.js

    try {
        const keys = idStrs.map(id => RedisKeys.userLikedPost(userIdStr, id));
        const values = await redisClient.mget(...keys);
=======
    const userHashKey = RedisKeys.userLikedHash(userIdStr);

    try {
        const values = await redisClient.hmget(userHashKey, ...idStrs);
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js

        const liked = new Set();
        const unknownIds = [];

        values.forEach((val, i) => {
            if (val === '1') liked.add(idStrs[i]);
            else if (val === null) unknownIds.push(idStrs[i]);
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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
=======
            // val === '0' → confirmed not liked
        });

        if (unknownIds.length > 0) {
            const dbLikes = await Like.find({ userId, postId: { $in: unknownIds } }).select('postId').lean();
            const dbLikedSet = new Set(dbLikes.map(l => l.postId.toString()));

            // Seed Hash with confirmed statuses
            const pipeline = redisClient.pipeline();
            const hsetArgs = [userHashKey];
            for (const id of unknownIds) {
                const isLiked = dbLikedSet.has(id);
                hsetArgs.push(id, isLiked ? '1' : '0');
                if (isLiked) liked.add(id);
            }
            pipeline.hset(...hsetArgs);
            pipeline.expire(userHashKey, LIKE_STATUS_TTL);
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
/**
 * Batch-get like counts for a list of items (posts or reels).
 * Redis MGET first; falls back to the embedded engagement.likes value already on the document.
=======
// ---------------------------------------------------------------------------
// batchGetLikesCount
// ---------------------------------------------------------------------------

/**
 * Batch-get like counts for a list of items (posts or reels).
 * Redis MGET first; seeds from DB-embedded count on cache miss.
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
        // Seed missing keys from the DB-embedded count (updated by 4-hourly cron).
        // Caching on miss ensures the next call (within TTL) is a Redis hit.
=======
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
/**
 * Batch-get comment counts for a list of items.
 * Redis MGET first; seeds from DB on cache miss; falls back to engagement.comments.
=======
// ---------------------------------------------------------------------------
// batchGetCommentsCount
// ---------------------------------------------------------------------------

/**
 * Batch-get comment counts for a list of items.
 * Redis MGET first; seeds from DB on cache miss.
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
            // Seed from DB — count non-deleted comments per post
=======
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
/**
 * Batch-get likedBy userIds for multiple posts.
 * Redis-first: parses JSON array from fn:post:{postId}:likedby.
 * On cache miss, seeds from DB (Like collection) and caches (capped at MAX_LIKEDBY).
 *
 * Returns a Map<postIdStr, string[]> of userId strings.
 */
export async function batchGetLikedByUserIds(postIds) {
=======
// ---------------------------------------------------------------------------
// likedBy Hash helpers
// ---------------------------------------------------------------------------

/**
 * Re-seed fn:post:{postId}:likedby Hash for every affected post.
 * DEL + re-populate to remove stale likers (e.g. users who unliked).
 * Used by the like-sync job after committing DB writes.
 */
export async function refreshLikedByHashes(postIds) {
    if (!postIds.length) return;

    const dbLikes = await Like.find({ postId: { $in: postIds } })
        .select('postId userId createdAt')
        .sort({ createdAt: -1 })
        .lean();

    const allUserIds = [...new Set(dbLikes.map(l => l.userId.toString()))];
    const UserModel = Post.db.model('User');
    const profiles = allUserIds.length
        ? await UserModel.find({ _id: { $in: allUserIds } }, 'username fullName profileImageUrl').lean()
        : [];
    const profileMap = new Map(profiles.map(u => [u._id.toString(), u]));

    const byPost = new Map(postIds.map(id => [id, []]));
    dbLikes.forEach(l => {
        const pid = l.postId.toString();
        const uid = l.userId.toString();
        const profile = profileMap.get(uid);
        if (profile && byPost.has(pid)) {
            byPost.get(pid).push({
                _id: uid,
                userId: uid,
                username: profile.username,
                fullName: profile.fullName,
                profileImageUrl: profile.profileImageUrl,
                likedAt: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
            });
        }
    });

    const pipeline = redisClient.pipeline();
    for (const [postId, users] of byPost) {
        const likedByKey = RedisKeys.postLikedBy(postId);
        const capped = users.slice(0, MAX_LIKEDBY);
        pipeline.del(likedByKey);
        if (capped.length > 0) {
            const args = [likedByKey];
            capped.forEach(u => args.push(u.userId, JSON.stringify(u)));
            pipeline.hset(...args);
            pipeline.expire(likedByKey, ENGAGEMENT_TTL);
        }
    }
    await pipeline.exec();
}

/**
 * Seed the likedBy Hash for the given postIds from DB.
 * Writes into `map` in place.
 * @internal
 */
async function _seedLikedByHashFromDB(postIds, map) {
    const dbLikes = await Like.find({ postId: { $in: postIds } })
        .select('postId userId createdAt')
        .sort({ createdAt: -1 })
        .lean();

    const allUserIds = [...new Set(dbLikes.map(l => l.userId.toString()))];
    const UserModel = Post.db.model('User');
    const profiles = allUserIds.length
        ? await UserModel.find({ _id: { $in: allUserIds } }, 'username fullName profileImageUrl').lean()
        : [];
    const profileMap = new Map(profiles.map(u => [u._id.toString(), u]));

    const byPost = new Map(postIds.map(id => [id, []]));
    dbLikes.forEach(l => {
        const pid = l.postId.toString();
        const uid = l.userId.toString();
        const profile = profileMap.get(uid);
        if (profile && byPost.has(pid)) {
            byPost.get(pid).push({
                _id: uid,
                userId: uid,
                username: profile.username,
                fullName: profile.fullName,
                profileImageUrl: profile.profileImageUrl,
                likedAt: l.createdAt ? new Date(l.createdAt).getTime() : Date.now(),
            });
        }
    });

    const pipeline = redisClient.pipeline();
    postIds.forEach(id => {
        const users = (byPost.get(id) || []).slice(0, MAX_LIKEDBY);
        map.set(id, users);
        if (users.length > 0) {
            const hsetArgs = [RedisKeys.postLikedBy(id)];
            users.forEach(u => hsetArgs.push(u.userId, JSON.stringify(u)));
            pipeline.hset(...hsetArgs);
            pipeline.expire(RedisKeys.postLikedBy(id), ENGAGEMENT_TTL);
        }
    });
    await pipeline.exec();
}

/**
 * Batch-get likedBy user objects for multiple posts.
 * Reads from the Redis Hash `fn:post:{postId}:likedby`
 * (field=userId, value=JSON{_id,userId,username,fullName,profileImageUrl,likedAt}).
 * Seeds from DB on cache miss, capped at MAX_LIKEDBY.
 *
 * Returns a Map<postIdStr, UserObject[]> sorted newest-first, up to PREVIEW_LIMIT.
 */
export async function batchGetLikedByUsers(postIds) {
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
    if (!postIds.length) return new Map();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];

    try {
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
        const keys = idStrs.map(id => RedisKeys.postLikedBy(id));
        const values = await redisClient.mget(...keys);
=======
        const pipeline = redisClient.pipeline();
        for (const id of idStrs) pipeline.hgetall(RedisKeys.postLikedBy(id));
        const results = await pipeline.exec();
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js

        const map = new Map();
        const missedIds = [];

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
        values.forEach((val, i) => {
            if (val !== null) {
                try {
                    map.set(idStrs[i], JSON.parse(val));
                } catch {
                    missedIds.push(idStrs[i]);
                }
            } else {
                missedIds.push(idStrs[i]);
=======
        results.forEach(([err, hashData], i) => {
            if (err || hashData === null) {
                missedIds.push(idStrs[i]);
            } else {
                const users = Object.values(hashData)
                    .map(v => { try { return JSON.parse(v); } catch { return null; } })
                    .filter(Boolean);
                users.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
                map.set(idStrs[i], users.slice(0, PREVIEW_LIMIT));
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
            }
        });

        if (missedIds.length) {
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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
=======
            await _seedLikedByHashFromDB(missedIds, map);
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
        }

        return map;
    } catch (err) {
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
        console.error('[PostEngagement] batchGetLikedByUserIds error:', err.message);
        const map = new Map();
        try {
            const dbLikes = await Like.find({ postId: { $in: postIds } }).select('postId userId').lean();
            idStrs.forEach(id => map.set(id, []));
            dbLikes.forEach(l => map.get(l.postId.toString())?.push(l.userId.toString()));
=======
        console.error('[PostEngagement] batchGetLikedByUsers error:', err.message);
        const map = new Map();
        try {
            await _seedLikedByHashFromDB(idStrs, map);
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
        } catch {}
        return map;
    }
}

/**
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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
=======
 * Backward-compatible wrapper: returns Map<postIdStr, userId string[]>.
 * Callers that only need user IDs (not full profiles) can use this.
 */
export async function batchGetLikedByUserIds(postIds) {
    const usersMap = await batchGetLikedByUsers(postIds);
    const idsMap = new Map();
    for (const [postId, users] of usersMap) {
        idsMap.set(postId, users.map(u => u.userId || u._id?.toString()));
    }
    return idsMap;
}

// ---------------------------------------------------------------------------
// stitchEngagement
// ---------------------------------------------------------------------------

/**
 * Stitch live engagement into an array of content items (posts or reels).
 * Stitches: isLikedByCurrentUser, likes count, comments count, likedBy list, likedByPreview.
 * Falls back to DB at every layer if Redis is unavailable.
 *
 * @param {*} userId  - viewer's userId (or null for unauthenticated)
 * @param {Array} items
 * @param {Object} [currentUserProfile] - optional {_id, username, fullName, profileImageUrl, isVerified}
 *   If provided and the viewer's like is still deferred (not yet in the likedBy cache),
 *   their profile is injected so the UI stays consistent immediately after liking.
 */
export async function stitchEngagement(userId, items, currentUserProfile = null) {
    if (!items || !items.length) return items;

    const [likedSet, likeCountMap, commentCountMap, likedByUsersMap] = await Promise.all([
        batchIsLikedByUser(userId, items.map(i => i._id)),
        batchGetLikesCount(items),
        batchGetCommentsCount(items),
        batchGetLikedByUsers(items.map(i => i._id)),
    ]);

    // Inject current user if their like is in the status cache but not yet in the likedBy Hash
    // (happens when the likedBy Hash was seeded from DB before this like was committed to DB)
    if (userId) {
        const userIdStr = userId.toString();
        for (const [idStr, users] of likedByUsersMap) {
            if (likedSet.has(idStr) && !users.find(u => (u.userId || u._id?.toString()) === userIdStr)) {
                if (currentUserProfile) {
                    users.unshift({
                        _id: userIdStr,
                        userId: userIdStr,
                        username: currentUserProfile.username,
                        fullName: currentUserProfile.fullName,
                        profileImageUrl: currentUserProfile.profileImageUrl,
                        isVerified: currentUserProfile.isVerified,
                        likedAt: Date.now(),
                    });
                }
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
            }
        }
    }

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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
=======
    // User profiles are already embedded in the Hash values — no separate lookup needed.
    // Only fetch the viewer's social graph for the preview text.
    const UserModel = Post.db.model('User');
    const me = userId
        ? await UserModel.findById(userId, 'following followers').lean()
        : null;

>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
    const userFollowing = me?.following || [];
    const userFollowers = me?.followers || [];

    return items.map(item => {
        const idStr = item._id.toString();
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
        const likedByUsers = (likedByIdsMap.get(idStr) || []).map(uid => profileMap.get(uid)).filter(Boolean);
=======
        const likedByUsers = likedByUsersMap.get(idStr) || [];
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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

=======
// ---------------------------------------------------------------------------
// onPostLiked / onPostUnliked — Lua-script atomic updates
// ---------------------------------------------------------------------------

/**
 * Call this when a user likes a post.
 * Atomically via Lua: sets like status in user's Hash, marks dirty, increments
 * like count (if key exists), and HSET user profile into the likedBy Hash.
 *
 * @param {*} userId
 * @param {*} postId
 * @param {{ username: string, fullName: string, profileImageUrl: string }} userProfile
 */
export async function onPostLiked(userId, postId, userProfile = {}) {
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();

    const userData = JSON.stringify({
        _id: userIdStr,
        userId: userIdStr,
        username: userProfile.username || '',
        fullName: userProfile.fullName || '',
        profileImageUrl: userProfile.profileImageUrl || '',
        likedAt: Date.now(),
    });

    try {
        await redisClient.eval(
            LIKE_LUA,
            4,
            RedisKeys.postLikesCount(postIdStr),
            RedisKeys.userLikedHash(userIdStr),
            RedisKeys.postLikedBy(postIdStr),
            RedisKeys.likesDirty(),
            postIdStr,
            userIdStr,
            userData,
            String(ENGAGEMENT_TTL),
            String(LIKE_STATUS_TTL),
            `${userIdStr}:${postIdStr}`,
        );
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
        return true;
    } catch (err) {
        console.error('[PostEngagement] onPostLiked error:', err.message);
        return false;
    }
}

/**
 * Call this when a user unlikes a post.
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
 * Writes '0' to the like-status key, marks dirty for 4-hourly sync,
 * decrements the like count if the count key exists, and removes userId from
 * the likedBy cache if that key exists.
=======
 * Atomically via Lua: sets like status to '0', marks dirty, decrements like count
 * (floor 0), and HDEL the user from the likedBy Hash.
 * Also deletes the Like document from DB immediately (so the DB fallback in
 * batchIsLikedByUser is always accurate for unlikes).
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
 */
export async function onPostUnliked(userId, postId) {
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();
<<<<<<< HEAD:src/utlis/postEngagement.utils.js
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

=======

    try {
        await redisClient.eval(
            UNLIKE_LUA,
            4,
            RedisKeys.postLikesCount(postIdStr),
            RedisKeys.userLikedHash(userIdStr),
            RedisKeys.postLikedBy(postIdStr),
            RedisKeys.likesDirty(),
            postIdStr,
            userIdStr,
            String(ENGAGEMENT_TTL),
            String(LIKE_STATUS_TTL),
            `${userIdStr}:${postIdStr}`,
        );

        // Unlikes are always written to DB immediately so the DB fallback is accurate.
        await Like.deleteOne({ userId, postId }).catch(() => {});

>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
        return true;
    } catch (err) {
        console.error('[PostEngagement] onPostUnliked error:', err.message);
        return false;
    }
}

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
/**
 * Call when a comment is created on a post.
 * Increments the Redis comment-count key if it exists; seeds from DB first if not.
 * Also increments Post.engagement.comments in DB.
 */
=======
// ---------------------------------------------------------------------------
// updateUserInLikedByHashes — called on profile update
// ---------------------------------------------------------------------------

/**
 * When a user updates their profile (username / profileImageUrl / fullName),
 * propagate the change to every likedBy Hash they appear in.
 *
 * Strategy:
 *   1. HGETALL fn:user:{userId}:liked → find postIds where value='1'
 *   2. For each postId, HGET the user's current entry in fn:post:{postId}:likedby
 *   3. If the entry exists, HSET it with updated profile data (preserving likedAt)
 *
 * Only updates entries that are already in Redis — stale hashes that have expired
 * will be re-seeded from DB (with fresh profile data) on next access.
 */
export async function updateUserInLikedByHashes(userId, { username, fullName, profileImageUrl }) {
    const userIdStr = userId.toString();
    const userHashKey = RedisKeys.userLikedHash(userIdStr);

    try {
        const likedHash = await redisClient.hgetall(userHashKey);
        if (!likedHash) return;

        const likedPostIds = Object.entries(likedHash)
            .filter(([, val]) => val === '1')
            .map(([postId]) => postId);

        if (!likedPostIds.length) return;

        // Fetch current likedAt values to preserve them
        const getPipeline = redisClient.pipeline();
        for (const postId of likedPostIds) {
            getPipeline.hget(RedisKeys.postLikedBy(postId), userIdStr);
        }
        const getResults = await getPipeline.exec();

        const updatePipeline = redisClient.pipeline();
        for (let i = 0; i < likedPostIds.length; i++) {
            const [, currentRaw] = getResults[i];
            if (currentRaw !== null) {
                let likedAt = Date.now();
                try { likedAt = JSON.parse(currentRaw).likedAt || likedAt; } catch {}
                updatePipeline.hset(
                    RedisKeys.postLikedBy(likedPostIds[i]),
                    userIdStr,
                    JSON.stringify({ _id: userIdStr, userId: userIdStr, username, fullName, profileImageUrl, likedAt })
                );
            }
        }
        await updatePipeline.exec();
    } catch (err) {
        console.error('[PostEngagement] updateUserInLikedByHashes error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// onCommentCreated / onCommentDeleted — unchanged
// ---------------------------------------------------------------------------

>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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

<<<<<<< HEAD:src/utlis/postEngagement.utils.js
/**
 * Call when a comment is deleted (soft or hard) on a post.
 * Decrements the Redis comment-count key (floor 0); seeds from DB first if not present.
 * Also decrements Post.engagement.comments in DB.
 */
=======
>>>>>>> 66b8148 (update utlis to utils and postEngament.js):src/utils/postEngagement.utils.js
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
