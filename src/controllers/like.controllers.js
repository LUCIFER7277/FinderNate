import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Like from "../models/like.models.js";
import Post from "../models/userPost.models.js";
import Comment from "../models/comment.models.js";
import { createLikeNotification } from "./notification.controllers.js";
import { createUnlikeNotification } from "./notification.controllers.js";

// Like a post
export const likePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    try {
        await Like.create({ userId, postId });
        await Post.findByIdAndUpdate(postId, { $inc: { "engagement.likes": 1 } });

        // Notify post owner (if not self) - with error handling
        try {
            const post = await Post.findById(postId).select("userId");
            if (post && post.userId.toString() !== userId.toString()) {
                await createLikeNotification({ recipientId: post.userId, sourceUserId: userId, postId });
            }
        } catch (notificationError) {
            console.error('Error sending like notification:', notificationError);
            // Don't fail the like operation if notification fails
        }

        // Return updated likedBy and isLikedBy
        const likes = await Like.find({ postId }).lean();
        const userIds = likes.map(like => like.userId.toString());
        let users = [];
        if (userIds.length > 0) {
            users = await Post.db.model('User').find(
                { _id: { $in: userIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
        }
        const isLikedBy = userIds.includes(userId.toString());
        return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy }, "Post liked successfully"));
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "You have already liked this post");
        }
        throw err;
    }
});

// Unlike a post
export const unlikePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    // Check if like exists and delete it
    const deletedLike = await Like.findOneAndDelete({ userId, postId });
    if (!deletedLike) {
        throw new ApiError(404, "You have not liked this post");
    }

    // Get post first to validate it exists and get userId for notification
    const post = await Post.findById(postId).select("userId");
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    // Decrement engagement count (MongoDB will handle defaults from schema)
    await Post.findByIdAndUpdate(postId, { $inc: { "engagement.likes": -1 } });

    // Notify post owner (if not self) - with error handling
    try {
        if (post.userId && post.userId.toString() !== userId.toString()) {
            await createUnlikeNotification({ recipientId: post.userId, sourceUserId: userId, postId });
        }
    } catch (notificationError) {
        console.error('Error sending unlike notification:', notificationError);
        // Don't fail the unlike operation if notification fails
    }

    // Return updated likedBy and isLikedBy (user has unliked, so isLikedBy should be false)
    const likes = await Like.find({ postId }).lean();
    const userIds = likes.map(likeDoc => likeDoc.userId.toString());
    let users = [];
    if (userIds.length > 0) {
        users = await Post.db.model('User').find(
            { _id: { $in: userIds } },
            'username profileImageUrl fullName isVerified'
        ).lean();
    }
    // After unliking, isLikedBy should always be false
    return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy: false }, "Post unliked successfully"));
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