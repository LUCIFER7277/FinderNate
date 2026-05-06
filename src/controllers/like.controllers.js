import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Like from "../models/like.models.js";
import Post from "../models/userPost.models.js";
import Comment from "../models/comment.models.js";
import { createLikeNotification, createUnlikeNotification } from "./notification.controllers.js";
import { redisClient, RedisKeys, RedisTTL } from "../config/redis.config.js";
import { onPostLiked, onPostUnliked } from "../utils/postEngagement.utils.js";

const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;

/**
 * Ensure fn:post:{postId}:likes:count exists in Redis.
 * If missing (new post or key expired), seeds it from DB and applies the delta.
 * Returns the up-to-date count.
 */
async function ensureLikesCount(postId, delta) {
    const countKey = RedisKeys.postLikesCount(postId.toString());
    let count = await redisClient.get(countKey);
    if (count === null) {
        // Key missing — seed from DB then apply delta
        const doc = await Post.findById(postId).select('engagement.likes').lean();
        const base = doc?.engagement?.likes ?? 0;
        count = Math.max(0, base + delta);
        await redisClient.set(countKey, count, 'EX', ENGAGEMENT_TTL);
    } else {
        count = parseInt(count, 10);
    }
    return count;
}

/**
 * Check whether a user has liked a specific post.
 * Redis-first (3-tier): '1'→liked, '0'→not liked, null→DB fallback.
 */
async function getLikeStatus(userId, postId) {
    try {
        const val = await redisClient.hget(
            RedisKeys.userLikedHash(userId.toString()),
            postId.toString()
        );
        if (val !== null) return val === '1';
        return !!(await Like.exists({ userId, postId }));
    } catch {
        return !!(await Like.exists({ userId, postId }));
    }
}

const User = Post.db.model('User');
const USER_FIELDS = 'username profileImageUrl fullName isVerified';

/**
 * Fetch the likedBy user list with pagination.
 *
 * Page 1: reads the likedBy Redis Hash (fn:post:{postId}:likedby).
 *   field = userId, value = JSON{_id, userId, username, fullName, profileImageUrl, likedAt}.
 *   Entries sorted newest-first (likedAt desc), up to `limit`.
 *   Falls back to DB on cache miss.
 * Page 2+: always reads from DB.
 *
 * Lag compensation:
 *   - includeUser:   viewer just liked; Lua already HSET them into the Hash.
 *     We unshift at position 0 to guarantee they appear first.
 *   - excludeUserId: viewer just unliked; Lua already HDELd them from the Hash.
 */
async function getLikedByList(postId, { includeUser = null, includeUserId = null, excludeUserId = null, page = 1, limit = 20 } = {}) {
    const postIdStr = postId.toString();
    const includeId = includeUser?._id?.toString() ?? (includeUserId ? includeUserId.toString() : null);

    // Page 1: read from the Redis Hash
    if (page === 1) {
        try {
            const hashData = await redisClient.hgetall(RedisKeys.postLikedBy(postIdStr));
            if (hashData !== null) {
                let users = Object.values(hashData)
                    .map(v => { try { return JSON.parse(v); } catch { return null; } })
                    .filter(Boolean);

                const excludeStr = excludeUserId?.toString();
                if (excludeStr) users = users.filter(u => (u._id || u.userId) !== excludeStr);
                if (includeId) users = users.filter(u => (u._id || u.userId) !== includeId);

                // Sort newest-first by likedAt
                users.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
                const hasMore = users.length > limit;
                let pageUsers = users.slice(0, limit);

                if (includeId) {
                    let me;
                    if (includeUser) {
                        me = {
                            _id: includeUser._id,
                            username: includeUser.username,
                            fullName: includeUser.fullName,
                            profileImageUrl: includeUser.profileImageUrl,
                            isVerified: includeUser.isVerified,
                        };
                    } else {
                        me = await User.findById(includeUserId, USER_FIELDS).lean();
                    }
                    if (me) pageUsers.unshift(me);
                }

                return { users: pageUsers, hasMore };
            }
        } catch (_) {
            // Fall through to DB on any Redis/parse error
        }
    }

    // DB path: cache miss or page > 1
    const skip = (page - 1) * limit;
    const likes = await Like.find({ postId })
        .select('userId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1)
        .lean();

    let userIds = likes.map(l => l.userId.toString());
    const hasMore = userIds.length > limit;
    if (hasMore) userIds = userIds.slice(0, limit);

    if (excludeUserId) userIds = userIds.filter(id => id !== excludeUserId.toString());
    if (page === 1 && includeId) userIds = userIds.filter(id => id !== includeId);

    const users = userIds.length
        ? await User.find({ _id: { $in: userIds } }, USER_FIELDS).lean()
        : [];

    if (page === 1 && includeId) {
        let me;
        if (includeUser) {
            me = {
                _id: includeUser._id,
                username: includeUser.username,
                fullName: includeUser.fullName,
                profileImageUrl: includeUser.profileImageUrl,
                isVerified: includeUser.isVerified,
            };
        } else {
            me = await User.findById(includeUserId, USER_FIELDS).lean();
        }
        if (me) users.unshift(me);
    }

    return { users, hasMore };
}

// Like a post — writes to Redis only; DB synced by nightly cron at 22:00
export const likePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    const alreadyLiked = await getLikeStatus(userId, postId);
    if (alreadyLiked) throw new ApiError(409, "You have already liked this post");

    const redisOk = await onPostLiked(userId, postId, {
        username: req.user.username,
        fullName: req.user.fullName,
        profileImageUrl: req.user.profileImageUrl,
    });

    // Fire-and-forget notification (does not block response)
    Post.findById(postId).select('userId').lean().then(post => {
        if (post && post.userId.toString() !== userId.toString()) {
            createLikeNotification({ recipientId: post.userId, sourceUserId: userId, postId }).catch(() => {});
        }
    }).catch(() => {});

    const [{ users: likedBy, hasMore }, likesCount] = await Promise.all([
        getLikedByList(postId, { includeUser: redisOk ? req.user : null }),
        ensureLikesCount(postId, +1),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        likedBy,
        hasMore,
        isLikedBy: true,
        likesCount,
    }, "Post liked successfully"));
});

// Unlike a post — writes to Redis only; DB synced by nightly cron at 22:00
export const unlikePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    const isLiked = await getLikeStatus(userId, postId);
    if (!isLiked) throw new ApiError(404, "You have not liked this post");

    const redisOk = await onPostUnliked(userId, postId);

    // Fire-and-forget notification
    Post.findById(postId).select('userId').lean().then(post => {
        if (post && post.userId.toString() !== userId.toString()) {
            createUnlikeNotification({ recipientId: post.userId, sourceUserId: userId, postId }).catch(() => {});
        }
    }).catch(() => {});

    const [{ users: likedBy, hasMore }, likesCount] = await Promise.all([
        getLikedByList(postId, { excludeUserId: redisOk ? userId : null }),
        ensureLikesCount(postId, -1),
    ]);

    return res.status(200).json(new ApiResponse(200, {
        likedBy,
        hasMore,
        isLikedBy: false,
        likesCount,
    }, "Post unliked successfully"));
});

/**
 * GET /post/liked-by?postId=&page=&limit=
 *
 * Paginated list of users who liked a post, fetched from DB.
 * The current user is excluded from the result set so the client can prepend
 * them at position 0 when isLikedByCurrentUser is true — avoids duplication
 * if their like has already been synced to DB.
 *
 * Auth: optional — unauthenticated callers receive the full list.
 */
export const getLikedByUsers = asyncHandler(async (req, res) => {
    const { postId, page = '1', limit = '20' } = req.query;
    if (!postId) throw new ApiError(400, "postId is required");

    const currentUserId = req.user?._id?.toString();
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    // Exclude current user — client prepends them when isLikedByCurrentUser is true
    const query = currentUserId
        ? { postId, userId: { $ne: currentUserId } }
        : { postId };

    const likes = await Like.find(query)
        .select('userId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit + 1)
        .lean();

    const hasMore = likes.length > parsedLimit;
    const userIds = likes.slice(0, parsedLimit).map(l => l.userId);

    const fetched = userIds.length
        ? await User.find({ _id: { $in: userIds } }, USER_FIELDS).lean()
        : [];

    // Preserve DB sort order (User.find does not guarantee it)
    const profileMap = new Map(fetched.map(u => [u._id.toString(), u]));
    const users = userIds.map(id => profileMap.get(id.toString())).filter(Boolean);

    return res.status(200).json(new ApiResponse(200, { users, hasMore, page: parsedPage }, "Liked by users fetched successfully"));
});

// Like a comment
export const likeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    try {
        await Like.create({ userId, commentId });
        // Notify comment owner (if not self)
        const comment = await Comment.findById(commentId).select("userId postId");
        if (comment && comment.userId.toString() !== userId.toString()) {
            await createLikeNotification({ recipientId: comment.userId, sourceUserId: userId, commentId, postId: comment.postId });
        }
        // Return updated likedBy and isLikedBy
        const likes = await Like.find({ commentId }).lean();
        const userIds = likes.map(like => like.userId.toString());
        let users = [];
        if (userIds.length > 0) {
            users = await Post.db.model('User').find(
                { _id: { $in: userIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
        }
        const isLikedBy = userIds.includes(userId.toString());
        return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy }, "Comment liked successfully"));
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "You have already liked this comment");
        }
        throw err;
    }
});

// Unlike a comment
export const unlikeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    const like = await Like.findOneAndDelete({ userId, commentId });
    if (like) {
        // Notify comment owner (if not self)
        const comment = await Comment.findById(commentId).select("userId postId");
        if (comment && comment.userId.toString() !== userId.toString()) {
            await createUnlikeNotification({ recipientId: comment.userId, sourceUserId: userId, commentId, postId: comment.postId });
        }
        // Return updated likedBy and isLikedBy
        const likes = await Like.find({ commentId }).lean();
        const userIds = likes.map(like => like.userId.toString());
        let users = [];
        if (userIds.length > 0) {
            users = await Post.db.model('User').find(
                { _id: { $in: userIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
        }
        const isLikedBy = userIds.includes(userId.toString());
        return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy }, "Comment unliked successfully"));
    } else {
        throw new ApiError(404, "Like not found for this comment");
    }
}); 