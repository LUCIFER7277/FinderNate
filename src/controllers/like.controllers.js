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
        const val = await redisClient.get(RedisKeys.userLikedPost(userId.toString(), postId.toString()));
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
 * Page 1: tries the Redis likedBy cache (fn:post:{postId}:likedby) first — same cache
 * that onPostLiked/onPostUnliked maintain — then falls back to DB on cache miss.
 * Page 2+: always reads from DB (cache is capped at MAX_LIKEDBY=50 entries).
 *
 * Lag compensation keeps the UI in sync with the user's own action:
 *   - includeUser:   current user just liked, Redis is up → use req.user directly, no DB fetch.
 *   - includeUserId: current user just liked, Redis is down → fetch profile from DB.
 *   - excludeUserId: current user just unliked → always remove them, regardless of Redis state.
 *
 * For like: the current user is stripped from userIds first (prevents duplication
 * if DB already has their record from a previous sync), then re-inserted at position 0.
 */
async function getLikedByList(postId, { includeUser = null, includeUserId = null, excludeUserId = null, page = 1, limit = 20 } = {}) {
    const postIdStr = postId.toString();
    const includeId = includeUser?._id?.toString() ?? (includeUserId ? includeUserId.toString() : null);

    // Page 1: try Redis cache first (cache is oldest-first, so reverse for newest-first display)
    if (page === 1) {
        try {
            const cached = await redisClient.get(RedisKeys.postLikedBy(postIdStr));
            if (cached !== null) {
                let userIds = JSON.parse(cached);

                if (excludeUserId) userIds = userIds.filter(id => id !== excludeUserId.toString());
                if (includeId) userIds = userIds.filter(id => id !== includeId);

                // Cache is oldest-first; reverse for newest-first, then page
                const reversed = userIds.slice().reverse();
                const hasMore = reversed.length > limit;
                const pageIds = reversed.slice(0, limit);

                const fetched = pageIds.length
                    ? await User.find({ _id: { $in: pageIds } }, USER_FIELDS).lean()
                    : [];

                // Preserve newest-first order (User.find doesn't guarantee it)
                const profileMap = new Map(fetched.map(u => [u._id.toString(), u]));
                const users = pageIds.map(id => profileMap.get(id)).filter(Boolean);

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
                    if (me) users.unshift(me);
                }

                return { users, hasMore };
            }
        } catch (_) {
            // Fall through to DB on any Redis/parse error
        }
    }

    // DB path: cache miss, page > 1, or Redis error
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

    const redisOk = await onPostLiked(userId, postId);

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