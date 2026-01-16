import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import TaggedUser from "../models/taggedUser.models.js";
import Like from "../models/like.models.js";
import { asyncHandler } from "../utlis/asyncHandler.js";

const allowedTabs = ["photos", "reels", "videos", "tagged", "stories"];
const postProjection = {
    _id: 1,
    userId: 1,
    media: 1,
    caption: 1,
    createdAt: 1,
    postType: 1,
    contentType: 1,
    status: 1
};
const storyProjection = {
    _id: 1,
    userId: 1,
    media: 1,
    createdAt: 1,
    expiresAt: 1,
    isArchived: 1
};

export const getProfileTabContent = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    let { tab = "photos", page = 1, limit = 12 } = req.query;
    page = parseInt(page);
    limit = parseInt(limit);
    const skip = (page - 1) * limit;
    const currentUserId = req.user?._id?.toString();

    // Validation
    if (!userId) throw new ApiError(400, "User ID is required");
    if (!allowedTabs.includes(tab)) throw new ApiError(400, "Invalid tab type");
    if (!Number.isInteger(page) || page < 1) throw new ApiError(400, "Page must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1) throw new ApiError(400, "Limit must be a positive integer");

    let data = [], total = 0;

    switch (tab) {
        case "photos": {
            const filter = {
                userId,
                postType: { $in: ["photo", "video"] },
                contentType: "normal",
                status: { $in: ["published", "scheduled"] }
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "reels": {
            const filter = {
                userId,
                postType: "reel",
                status: { $in: ["published", "scheduled"] }
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "videos": {
            const filter = {
                userId,
                postType: "video",
                contentType: { $ne: "normal" },
                status: { $in: ["published", "scheduled"] }
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "tagged": {
            // Get all tagged post/reel IDs for this user
            const tagged = await TaggedUser.find({ userId, targetType: { $in: ["Post", "Reel"] } })
                .sort({ taggedAt: -1 })
                .lean();
            const postIds = tagged.map(t => t.targetId);
            // Paginate posts directly
            total = await Post.countDocuments({ _id: { $in: postIds } });
            data = await Post.find({ _id: { $in: postIds } }, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            break;
        }
        case "stories": {
            const now = new Date();
            const filter = {
                userId,
                isArchived: false,
                expiresAt: { $gt: now }
            };
            data = await Story.find(filter, storyProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Story.countDocuments(filter);
            break;
        }
    }

    // Add isLikedBy for posts (not stories)
    if (["photos", "reels", "videos", "tagged"].includes(tab) && data.length > 0 && currentUserId) {
        const postIds = data.map(post => post._id);
        const likes = await Like.find({ postId: { $in: postIds }, userId: currentUserId }).lean();
        const likedPostIds = new Set(likes.map(like => like.postId.toString()));
        data = data.map(post => ({
            ...post,
            isLikedBy: likedPostIds.has(post._id.toString())
        }));
    }

    return res.status(200).json(
        new ApiResponse(200, {
            tab,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            data
        }, `Fetched ${tab} for user profile`)
    );
});
