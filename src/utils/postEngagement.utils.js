import mongoose from 'mongoose';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import Like from '../models/like.models.js';
import Post from '../models/userPost.models.js';
import Comment from '../models/comment.models.js';
import { getLikedByPreview } from './likedByPreview.utils.js';

const LIKE_STATUS_TTL = RedisTTL.POST_LIKE_STATUS;
const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;
// Max liker entries stored in the likedBy Hash per post when seeding from DB
const MAX_LIKEDBY = 50;
// How many likers to return from Hash for page-1 preview
const PREVIEW_LIMIT = 20;

// ---------------------------------------------------------------------------
// Lua scripts for atomic like / unlike
// ---------------------------------------------------------------------------

// KEYS: [countKey, userLikedSetKey, likedByKey]
// ARGV: [postId, userId, userDataJSON, engTTL, likeTTL]
const LIKE_LUA = `
local countKey   = KEYS[1]
local userSetKey = KEYS[2]
local likedByKey = KEYS[3]
local postId     = ARGV[1]
local userId     = ARGV[2]
local userData   = ARGV[3]
local engTTL     = tonumber(ARGV[4])
local likeTTL    = tonumber(ARGV[5])
redis.call('sadd', userSetKey, postId)
redis.call('expire', userSetKey, likeTTL)
if redis.call('exists', countKey) == 1 then
  redis.call('incr', countKey)
  redis.call('expire', countKey, engTTL)
end
redis.call('hset', likedByKey, userId, userData)
redis.call('expire', likedByKey, engTTL)
return 1
`;

// KEYS: [countKey, userLikedSetKey, likedByKey]
// ARGV: [postId, userId, engTTL, likeTTL]
const UNLIKE_LUA = `
local countKey   = KEYS[1]
local userSetKey = KEYS[2]
local likedByKey = KEYS[3]
local postId     = ARGV[1]
local userId     = ARGV[2]
local engTTL     = tonumber(ARGV[3])
local likeTTL    = tonumber(ARGV[4])
redis.call('srem', userSetKey, postId)
redis.call('expire', userSetKey, likeTTL)
if redis.call('exists', countKey) == 1 then
  local c = redis.call('decr', countKey)
  if c < 0 then redis.call('set', countKey, '0') end
  redis.call('expire', countKey, engTTL)
end
redis.call('hdel', likedByKey, userId)
return 1
`;

// ---------------------------------------------------------------------------
// batchIsLikedByUser — Set-based (fn:user:{userId}:liked)
// ---------------------------------------------------------------------------

/**
 * Batch-check whether the current user has liked each post.
 *
 * Uses per-user Set `fn:user:{userId}:liked` (members = liked postIds).
 * Key exists → pipeline SISMEMBER (authoritative, no DB needed).
 * Key missing → full DB seed then check.
 *
 * Returns a Set of postId strings the user has liked.
 */
export async function batchIsLikedByUser(userId, postIds) {
    if (!userId || !postIds.length) return new Set();

    const userIdStr = userId.toString();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];
    const userSetKey = RedisKeys.userLikedSet(userIdStr);

    try {
        // Guard against stale wrong-type keys (Hash from old code, now expects Set)
        const keyType = await redisClient.type(userSetKey);
        if (keyType !== 'none' && keyType !== 'set') {
            await redisClient.del(userSetKey);
        }

        const exists = keyType === 'set';

        if (!exists) {
            // Seed full liked Set from DB so subsequent checks are authoritative
            const dbLikes = await Like.find({ userId }).select('postId').lean();
            const likedIds = dbLikes.map(l => l.postId.toString());
            if (likedIds.length) {
                await redisClient.pipeline()
                    .sadd(userSetKey, ...likedIds)
                    .expire(userSetKey, LIKE_STATUS_TTL)
                    .exec();
            }
            const likedAll = new Set(likedIds);
            return new Set(idStrs.filter(id => likedAll.has(id)));
        }

        // Set exists — pipeline SISMEMBER for each postId
        const pipeline = redisClient.pipeline();
        for (const id of idStrs) pipeline.sismember(userSetKey, id);
        const results = await pipeline.exec();

        const liked = new Set();
        results.forEach(([err, isMember], i) => {
            if (!err && isMember === 1) liked.add(idStrs[i]);
        });
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

// ---------------------------------------------------------------------------
// batchGetLikesCount
// ---------------------------------------------------------------------------

/**
 * Batch-get like counts for a list of items (posts or reels).
 * Redis MGET first; seeds from DB-embedded count on cache miss.
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

// ---------------------------------------------------------------------------
// batchGetCommentsCount
// ---------------------------------------------------------------------------

/**
 * Batch-get comment counts for a list of items.
 * Redis MGET first; seeds from DB on cache miss.
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
    if (!postIds.length) return new Map();
    const idStrs = [...new Set(postIds.map(id => id.toString()))];

    try {
        const pipeline = redisClient.pipeline();
        for (const id of idStrs) pipeline.hgetall(RedisKeys.postLikedBy(id));
        const results = await pipeline.exec();

        const map = new Map();
        const missedIds = [];

        results.forEach(([err, hashData], i) => {
            if (err || hashData === null) {
                missedIds.push(idStrs[i]);
            } else {
                const users = Object.values(hashData)
                    .map(v => { try { return JSON.parse(v); } catch { return null; } })
                    .filter(u => u && typeof u === 'object' && (u._id || u.userId))
                    .map(u => ({ ...u, _id: u._id ?? u.userId }));
                users.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
                map.set(idStrs[i], users.slice(0, PREVIEW_LIMIT));
            }
        });

        if (missedIds.length) {
            await _seedLikedByHashFromDB(missedIds, map);
        }

        return map;
    } catch (err) {
        console.error('[PostEngagement] batchGetLikedByUsers error:', err.message);
        const map = new Map();
        try {
            await _seedLikedByHashFromDB(idStrs, map);
        } catch {}
        return map;
    }
}

/**
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
            }
        }
    }

    const UserModel = Post.db.model('User');
    const me = userId
        ? await UserModel.findById(userId, 'following followers').lean()
        : null;

    const userFollowing = me?.following || [];
    const userFollowers = me?.followers || [];

    return items.map(item => {
        const idStr = item._id.toString();
        const likedByUsers = likedByUsersMap.get(idStr) || [];
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

    const runLiked = () => redisClient.eval(
        LIKE_LUA,
        3,
        RedisKeys.postLikesCount(postIdStr),
        RedisKeys.userLikedSet(userIdStr),
        RedisKeys.postLikedBy(postIdStr),
        postIdStr,
        userIdStr,
        userData,
        String(ENGAGEMENT_TTL),
        String(LIKE_STATUS_TTL),
    );

    try {
        await runLiked();
        return true;
    } catch (err) {
        if (err.message.includes('WRONGTYPE')) {
            // Stale Hash key from old code — delete it and retry once
            await redisClient.del(RedisKeys.userLikedSet(userIdStr)).catch(() => {});
            try { await runLiked(); return true; } catch {}
        }
        console.error('[PostEngagement] onPostLiked error:', err.message);
        return false;
    }
}

/**
 * Call this when a user unlikes a post.
 * Atomically via Lua: sets like status to '0', marks dirty, decrements like count
 * (floor 0), and HDEL the user from the likedBy Hash.
 * Also deletes the Like document from DB immediately (so the DB fallback in
 * batchIsLikedByUser is always accurate for unlikes).
 */
export async function onPostUnliked(userId, postId) {
    const userIdStr = userId.toString();
    const postIdStr = postId.toString();

    const runUnliked = () => redisClient.eval(
        UNLIKE_LUA,
        3,
        RedisKeys.postLikesCount(postIdStr),
        RedisKeys.userLikedSet(userIdStr),
        RedisKeys.postLikedBy(postIdStr),
        postIdStr,
        userIdStr,
        String(ENGAGEMENT_TTL),
        String(LIKE_STATUS_TTL),
    );

    try {
        await runUnliked();
        await Like.deleteOne({ userId, postId }).catch(() => {});
        return true;
    } catch (err) {
        if (err.message.includes('WRONGTYPE')) {
            // Stale Hash key from old code — delete it and retry once
            await redisClient.del(RedisKeys.userLikedSet(userIdStr)).catch(() => {});
            try {
                await runUnliked();
                await Like.deleteOne({ userId, postId }).catch(() => {});
                return true;
            } catch {}
        }
        console.error('[PostEngagement] onPostUnliked error:', err.message);
        return false;
    }
}

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
    const userSetKey = RedisKeys.userLikedSet(userIdStr);

    try {
        const likedPostIds = await redisClient.smembers(userSetKey);
        if (!likedPostIds.length) return;

        if (!likedPostIds.length) return;

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
// onCommentCreated / onCommentDeleted
// ---------------------------------------------------------------------------

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
