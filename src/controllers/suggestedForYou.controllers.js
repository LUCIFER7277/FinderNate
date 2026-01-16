import { asyncHandler } from "../utlis/asyncHandler.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Like from "../models/like.models.js";
import Comment from "../models/comment.models.js";
import Follower from "../models/follower.models.js";
import mongoose from "mongoose";

// Constants for scoring
const LIKE_SCORE = 3;
const COMMENT_SCORE = 2;
const MUTUAL_SCORE = 1;

// Helper: Shuffle array
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

const getSuggestedForYou = asyncHandler(async (req, res) => {
    const { _id: currentUserId } = req.user;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    // Get blocked users from middleware
    const blockedUsers = req.blockedUsers || [];

    try {
        // 1. Users whose posts the current user liked
        const likedUsers = await Like.aggregate([
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(currentUserId),
                    postId: { $exists: true }
                }
            },
            {
                $lookup: {
                    from: "posts",
                    localField: "postId",
                    foreignField: "_id",
                    pipeline: [{ $project: { userId: 1 } }],
                    as: "post"
                }
            },
            { $unwind: "$post" },
            {
                $group: {
                    _id: "$post.userId",
                    likeCount: { $sum: 1 }
                }
            },
            { $sort: { likeCount: -1 } },
            { $limit: 30 }
        ]);

        // 2. Users whose posts the current user commented on
        const commentedUsers = await Comment.aggregate([
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(currentUserId)
                }
            },
            {
                $lookup: {
                    from: "posts",
                    localField: "postId",
                    foreignField: "_id",
                    pipeline: [{ $project: { userId: 1 } }],
                    as: "post"
                }
            },
            { $unwind: "$post" },
            {
                $group: {
                    _id: "$post.userId",
                    commentCount: { $sum: 1 }
                }
            },
            { $sort: { commentCount: -1 } },
            { $limit: 30 }
        ]);

        // 3. Get users that current user is already following (to exclude them)
        const currentUserFollowing = await Follower.find({ followerId: currentUserId }).select('userId');
        const followingIds = currentUserFollowing.map(f => f.userId);
        const followingIdsSet = new Set(followingIds.map(id => id.toString()));

        // 4. Mutual friends

        const mutualFriends = await Follower.aggregate([
            {
                $match: {
                    followerId: { $in: followingIds }
                }
            },
            {
                $group: {
                    _id: "$userId",
                    mutualCount: { $sum: 1 }
                }
            },
            { $sort: { mutualCount: -1 } },
            { $limit: 30 }
        ]);

        // Combine suggestions into map
        const suggestionMap = new Map();

        for (const user of likedUsers) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                suggestionMap.set(user._id.toString(), {
                    userId: user._id,
                    score: user.likeCount * LIKE_SCORE,
                    reason: "You liked their posts"
                });
            }
        }

        for (const user of commentedUsers) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                const existing = suggestionMap.get(user._id.toString());
                if (existing) {
                    existing.score += user.commentCount * COMMENT_SCORE;
                    existing.reason = "You liked and commented on their posts";
                } else {
                    suggestionMap.set(user._id.toString(), {
                        userId: user._id,
                        score: user.commentCount * COMMENT_SCORE,
                        reason: "You commented on their posts"
                    });
                }
            }
        }

        for (const user of mutualFriends) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                const existing = suggestionMap.get(user._id.toString());
                if (existing) {
                    existing.score += user.mutualCount * MUTUAL_SCORE;
                    existing.reason += " and you have mutual friends";
                } else {
                    suggestionMap.set(user._id.toString(), {
                        userId: user._id,
                        score: user.mutualCount * MUTUAL_SCORE,
                        reason: "You have mutual friends"
                    });
                }
            }
        }

        // Sort by score, then paginate, then shuffle the page batch
        let suggestions = Array.from(suggestionMap.values()).sort((a, b) => b.score - a.score);
        const paginated = suggestions.slice(skip, skip + limit);
        shuffleArray(paginated);

        const userIds = paginated.map(s => s.userId);

        // Fetch users with selected fields (excluding blocked users)
        const users = await User.find({
            _id: {
                $in: userIds,
                $ne: currentUserId,
                $nin: blockedUsers
            },
            accountStatus: 'active',
            isBusinessProfile: { $ne: true }
        }).select('username fullName profileImageUrl bio');

        // Get follower/following counts
        const [followersCounts, followingCounts] = await Promise.all([
            Follower.aggregate([
                { $match: { userId: { $in: userIds } } },
                { $group: { _id: "$userId", count: { $sum: 1 } } }
            ]),
            Follower.aggregate([
                { $match: { followerId: { $in: userIds } } },
                { $group: { _id: "$followerId", count: { $sum: 1 } } }
            ])
        ]);

        const followersMap = new Map(followersCounts.map(f => [f._id.toString(), f.count]));
        const followingMap = new Map(followingCounts.map(f => [f._id.toString(), f.count]));

        // Final mapping
        const suggestionsWithDetails = paginated.map(suggestion => {
            const user = users.find(u => u._id.toString() === suggestion.userId.toString());
            if (!user) return null;

            return {
                _id: user._id,
                username: user.username,
                fullName: user.fullName,
                profileImageUrl: user.profileImageUrl,
                bio: user.bio,
                followersCount: followersMap.get(user._id.toString()) || 0,
                followingCount: followingMap.get(user._id.toString()) || 0,
                isFollowing: false // All suggested users are not followed by design
            };
        }).filter(Boolean);

        // Final response
        return res.status(200).json(
            new ApiResponse(200, {
                suggestions: suggestionsWithDetails,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(suggestionMap.size / limit),
                    totalSuggestions: suggestionMap.size,
                    hasNextPage: skip + limit < suggestionMap.size,
                    hasPrevPage: page > 1
                }
            }, "Suggested for you users retrieved successfully")
        );

    } catch (error) {
        console.error("Suggested Users Error:", error);
        throw new ApiError(500, "Error fetching suggested for you users");
    }
});

export {
    getSuggestedForYou
};
