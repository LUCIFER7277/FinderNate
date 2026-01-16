import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Comment from "../models/comment.models.js";
import Post from "../models/userPost.models.js";
import Like from "../models/like.models.js";
import { createCommentNotification } from "./notification.controllers.js";

// Create a new comment (or reply)
export const createComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId, content, parentCommentId, replyToUserId } = req.body;
    if (!postId || !content) throw new ApiError(400, "postId and content are required");

    // If replying to a comment, fetch parent info and set up thread structure
    let finalReplyToUserId = replyToUserId || null;
    let rootCommentId = null;

    if (parentCommentId) {
        const parentComment = await Comment.findById(parentCommentId).select("userId rootCommentId");
        if (!parentComment) {
            throw new ApiError(404, "Parent comment not found");
        }

        // Set replyToUserId if not provided
        if (!replyToUserId) {
            finalReplyToUserId = parentComment.userId;
        }

        // For thread tracking: if parent has a root, use that; otherwise parent IS the root
        rootCommentId = parentComment.rootCommentId || parentCommentId;
    }

    const comment = await Comment.create({
        postId,
        userId,
        content,
        parentCommentId: parentCommentId || null,
        rootCommentId,
        replyToUserId: finalReplyToUserId
    });

    // Send notification to post owner (if not commenting on own post)
    try {
        const post = await Post.findById(postId).select("userId");
        if (post && post.userId.toString() !== userId.toString()) {
            await createCommentNotification({
                recipientId: post.userId,
                sourceUserId: userId,
                postId,
                commentId: comment._id
            });
        }

        // If this is a reply to another comment, also notify the comment owner
        if (parentCommentId) {
            const parentComment = await Comment.findById(parentCommentId).select("userId");
            if (parentComment && parentComment.userId.toString() !== userId.toString()) {
                await createCommentNotification({
                    recipientId: parentComment.userId,
                    sourceUserId: userId,
                    postId,
                    commentId: comment._id,
                    isReply: true
                });
            }
        }
    } catch (error) {
        // Log error but don't fail the comment creation
        console.error("Error sending comment notification:", error);
    }

    // Populate user and replyToUser before returning
    const populatedComment = await Comment.findById(comment._id)
        .populate('userId', 'username fullName profileImageUrl bio location')
        .populate('replyToUserId', 'username fullName profileImageUrl')
        .lean();

    return res.status(201).json(new ApiResponse(201, populatedComment, "Comment created successfully"));
});

// Get all comments for a post
export const getCommentsByPost = asyncHandler(async (req, res) => {
    const { postId, page = 1, limit = 20 } = req.query;
    if (!postId) throw new ApiError(400, "postId is required");

    // ✅ FIXED: Handle both Mongoose document and plain object from cache
    const userId = req.user?._id ? req.user._id.toString() : null;
    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (pageNum - 1) * pageLimit;

    // ✅ OPTIMIZED: Only fetch top-level comments (parentCommentId: null)
    const [comments, total] = await Promise.all([
        Comment.find({ postId, parentCommentId: null, isDeleted: false })
            .populate('userId', 'username fullName profileImageUrl bio location')
            .populate('replyToUserId', 'username fullName profileImageUrl')
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(pageLimit)
            .lean(),
        Comment.countDocuments({ postId, parentCommentId: null, isDeleted: false })
    ]);

    // Populate likes from Like collection for each comment
    const commentIds = comments.map(c => c._id);
    const [likes, replyCounts] = await Promise.all([
        Like.find({ commentId: { $in: commentIds } })
            .populate('userId', 'username profileImageUrl fullName')
            .lean(),
        // ✅ Get TOTAL reply counts for each thread (handle both new and old data)
        Comment.aggregate([
            {
                $match: {
                    $or: [
                        { rootCommentId: { $in: commentIds } },  // New threading
                        {
                            parentCommentId: { $in: commentIds },
                            $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]  // Old data
                        }
                    ],
                    isDeleted: false
                }
            },
            {
                $group: {
                    // Group by rootCommentId if exists, otherwise by parentCommentId (for old data)
                    _id: { $ifNull: ['$rootCommentId', '$parentCommentId'] },
                    count: { $sum: 1 }
                }
            }
        ])
    ]);

    // Group likes by commentId
    const likesByComment = {};
    likes.forEach(like => {
        const commentId = like.commentId.toString();
        if (!likesByComment[commentId]) {
            likesByComment[commentId] = [];
        }
        likesByComment[commentId].push(like.userId);
    });

    // Group reply counts by commentId
    const replyCountMap = {};
    replyCounts.forEach(item => {
        replyCountMap[item._id.toString()] = item.count;
    });

    // Add likes and isLikedBy to each comment
    const enrichedComments = comments.map(comment => {
        const commentLikes = likesByComment[comment._id.toString()] || [];
        const isLikedBy = userId ? commentLikes.some(u => u._id.toString() === userId) : false;

        return {
            ...comment,
            likes: commentLikes,
            isLikedBy,
            likesCount: commentLikes.length,
            replyCount: replyCountMap[comment._id.toString()] || 0
        };
    });

    return res.status(200).json(
        new ApiResponse(200, {
            totalComments: total,
            page: pageNum,
            totalPages: Math.ceil(total / pageLimit),
            comments: enrichedComments
        }, "Comments fetched successfully")
    );
});

// Helper function to recursively fetch all descendant comment IDs
async function getAllDescendantIds(commentIds) {
    if (!commentIds || commentIds.length === 0) return [];

    const directChildren = await Comment.find({
        parentCommentId: { $in: commentIds },
        isDeleted: false
    }).select('_id').lean();

    if (directChildren.length === 0) return [];

    const childIds = directChildren.map(c => c._id);
    const grandChildIds = await getAllDescendantIds(childIds);

    return [...childIds, ...grandChildIds];
}

// Get a single comment by ID
export const getCommentById = asyncHandler(async (req, res) => {
    const { commentId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    // ✅ FIXED: Handle both Mongoose document and plain object from cache
    const userId = req.user?._id ? req.user._id.toString() : null;
    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 10;
    const skip = (pageNum - 1) * pageLimit;

    const comment = await Comment.findById(commentId)
        .populate('userId', 'username fullName profileImageUrl bio location')
        .populate('replyToUserId', 'username fullName profileImageUrl')
        .lean();
    if (!comment || comment.isDeleted) throw new ApiError(404, "Comment not found");

    // ✅ FACEBOOK-STYLE THREADING: Fetch all descendants (recursively)
    let replies, totalReplies;

    // If this is a TOP-LEVEL comment, use optimized rootCommentId query
    if (!comment.parentCommentId) {
        // Fetch all replies using rootCommentId (more efficient for top-level)
        [replies, totalReplies] = await Promise.all([
            Comment.find({
                $or: [
                    { rootCommentId: commentId },
                    {
                        parentCommentId: commentId,
                        $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]
                    }
                ],
                isDeleted: false
            })
                .populate('userId', 'username fullName profileImageUrl bio location')
                .populate('replyToUserId', 'username fullName profileImageUrl')
                .sort({ createdAt: 1 })
                .skip(skip)
                .limit(pageLimit)
                .lean(),
            Comment.countDocuments({
                $or: [
                    { rootCommentId: commentId },
                    {
                        parentCommentId: commentId,
                        $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]
                    }
                ],
                isDeleted: false
            })
        ]);
    } else {
        // For nested comments, recursively fetch all descendants
        const allDescendantIds = await getAllDescendantIds([commentId]);
        totalReplies = allDescendantIds.length;

        // Fetch and sort all descendants, then paginate
        replies = await Comment.find({ _id: { $in: allDescendantIds } })
            .populate('userId', 'username fullName profileImageUrl bio location')
            .populate('replyToUserId', 'username fullName profileImageUrl')
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(pageLimit)
            .lean();
    }

    // Get likes for the main comment and all replies
    const allCommentIds = [commentId, ...replies.map(r => r._id)];
    const replyIds = replies.map(r => r._id);

    const [likes, replyCountsForReplies] = await Promise.all([
        Like.find({ commentId: { $in: allCommentIds } })
            .populate('userId', 'username profileImageUrl fullName')
            .lean(),
        // Get reply counts for each comment in the thread (how many direct replies each has)
        allCommentIds.length > 0
            ? Comment.aggregate([
                { $match: { parentCommentId: { $in: allCommentIds }, isDeleted: false } },
                { $group: { _id: '$parentCommentId', count: { $sum: 1 } } }
            ])
            : Promise.resolve([])
    ]);

    // Group likes by commentId
    const likesByComment = {};
    likes.forEach(like => {
        const cId = like.commentId.toString();
        if (!likesByComment[cId]) {
            likesByComment[cId] = [];
        }
        likesByComment[cId].push(like.userId);
    });

    // Group reply counts by commentId
    const replyCountMap = {};
    replyCountsForReplies.forEach(item => {
        replyCountMap[item._id.toString()] = item.count;
    });

    // ✅ Calculate depth for each reply (for nested display on frontend)
    const depthMap = { [commentId.toString()]: 0 }; // Root comment has depth 0
    const commentMap = {};

    // Build a map of comments by ID
    replies.forEach(reply => {
        commentMap[reply._id.toString()] = reply;
    });

    // Calculate depth by following parent chain
    const calculateDepth = (replyId) => {
        if (depthMap[replyId] !== undefined) return depthMap[replyId];

        const reply = commentMap[replyId];
        if (!reply || !reply.parentCommentId) {
            depthMap[replyId] = 1; // Direct reply to root
            return 1;
        }

        const parentId = reply.parentCommentId.toString();
        const parentDepth = parentId === commentId.toString()
            ? 0
            : calculateDepth(parentId);

        depthMap[replyId] = parentDepth + 1;
        return depthMap[replyId];
    };

    // Calculate depth for all replies
    replies.forEach(reply => {
        calculateDepth(reply._id.toString());
    });

    // Enrich main comment with likes and total reply count
    const commentLikes = likesByComment[commentId.toString()] || [];
    const isLikedBy = userId ? commentLikes.some(u => u._id.toString() === userId) : false;
    const enrichedComment = {
        ...comment,
        likes: commentLikes,
        isLikedBy,
        likesCount: commentLikes.length,
        replyCount: totalReplies
    };

    // Enrich replies with likes, reply counts, and depth for nested display
    const enrichedReplies = replies.map(reply => {
        const replyLikes = likesByComment[reply._id.toString()] || [];
        const isReplyLikedBy = userId ? replyLikes.some(u => u._id.toString() === userId) : false;

        return {
            ...reply,
            likes: replyLikes,
            isLikedBy: isReplyLikedBy,
            likesCount: replyLikes.length,
            replyCount: replyCountMap[reply._id.toString()] || 0,
            depth: depthMap[reply._id.toString()] || 1 // Add depth for nested UI rendering
        };
    });

    return res.status(200).json(
        new ApiResponse(200, {
            comment: enrichedComment,
            replies: {
                totalReplies,
                page: pageNum,
                totalPages: Math.ceil(totalReplies / pageLimit),
                comments: enrichedReplies
            }
        }, "Comment fetched successfully")
    );
});

// Update a comment
export const updateComment = asyncHandler(async (req, res) => {
    const { commentId } = req.params;
    const { content } = req.body;
    if (!content) throw new ApiError(400, "content is required");
    const comment = await Comment.findByIdAndUpdate(
        commentId,
        { content, isEdited: true },
        { new: true }
    );
    if (!comment || comment.isDeleted) throw new ApiError(404, "Comment not found");
    return res.status(200).json(new ApiResponse(200, comment, "Comment updated successfully"));
});

// Delete a comment (soft delete)
export const deleteComment = asyncHandler(async (req, res) => {
    const { commentId } = req.params;
    const comment = await Comment.findByIdAndUpdate(
        commentId,
        { isDeleted: true },
        { new: true }
    );
    if (!comment) throw new ApiError(404, "Comment not found");
    return res.status(200).json(new ApiResponse(200, null, "Comment deleted successfully"));
}); 