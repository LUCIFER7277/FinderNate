import { asyncHandler } from "../utlis/asyncHandler.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";
import Follower from "../models/follower.models.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { getViewableUserIds } from "../middlewares/privacy.middleware.js";
import { enrichWithRatings } from "../utlis/reviewUtils.js";
import { addBadgesToNestedUsers } from "../utlis/userBadge.utils.js";
import { getLikedByPreview } from "../utlis/likedByPreview.utils.js";
import Like from "../models/like.models.js";
import mongoose from "mongoose";


// Simple in-memory cache
const cache = {
    reels: {
        data: null,
        timestamp: null,
        cacheKey: null,
        expiry: 5 * 60 * 1000 // 5 minutes
    }
};

// Unified function to get reels with comprehensive data and filtering
export const getSuggestedReels = asyncHandler(async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            userId,
            contentType,
            postType,
            sortBy = 'latest',
            location,
            tag,
            suggested = false
        } = req.query;

        // ✅ FIXED: Handle both Mongoose document and plain object from cache
        const currentUserIdRaw = req.user?._id || userId;
        const currentUserId = currentUserIdRaw ? (typeof currentUserIdRaw === 'string' ? currentUserIdRaw : currentUserIdRaw.toString()) : null;

        // ✅ FIXED: Convert blocked user IDs to ObjectIds for MongoDB aggregation
        const blockedUsersRaw = req.blockedUsers || [];
        const blockedUsers = blockedUsersRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );

        const pageNum = Number(page);
        const limitNum = Number(limit);
        const skip = (pageNum - 1) * limitNum;

        console.log('🎬 Reels Debug - currentUserId:', currentUserId);
        console.log('🎬 Reels Debug - blockedUsers count:', blockedUsers.length);

        // ✅ REELS DISCOVERY FEED LOGIC
        // For reels (discovery feed like Instagram/TikTok), we want to show reels from ALL users
        // Not just from people you follow - this is different from the home feed

        // Get ALL public users (users with privacy: 'public' or null/undefined)
        const publicUsers = await User.find({
            $or: [
                { privacy: 'public' },
                { privacy: { $exists: false } },
                { privacy: null }
            ]
        }).select('_id').lean();
        const publicUserIds = publicUsers.map(u =>
            typeof u._id === 'string' ? new mongoose.Types.ObjectId(u._id) : u._id
        );

        console.log('🎬 Reels Debug - publicUserIds count:', publicUserIds.length);

        // Get private users that the viewer follows (to include their private reels)
        let allowedUserIds = [...publicUserIds];

        if (currentUserId) {
            const following = await Follower.find({ followerId: currentUserId }).select('userId').lean();
            const followingIds = following.map(f => f.userId);

            // Get which of the followed users have private accounts
            const privateFollowedUsers = await User.find({
                _id: { $in: followingIds },
                privacy: 'private'
            }).select('_id').lean();

            const privateFollowedUserIds = privateFollowedUsers.map(u =>
                typeof u._id === 'string' ? new mongoose.Types.ObjectId(u._id) : u._id
            );

            console.log('🎬 Reels Debug - privateFollowedUserIds count:', privateFollowedUserIds.length);

            // Add private followed users to the allowed list
            allowedUserIds = [...allowedUserIds, ...privateFollowedUserIds];
        }

        console.log('🎬 Reels Debug - Total allowedUserIds count:', allowedUserIds.length);

        // Build match criteria for reels discovery feed
        // Show reels from: ALL public users + private users that viewer follows
        // Exclude blocked users
        const matchCriteria = {
            status: { $in: ["published", "scheduled"] },
            userId: { $in: allowedUserIds, $nin: blockedUsers }
        };

        // Filter by postType if specified (reel, photo, video, story)
        if (postType) {
            matchCriteria.postType = postType;
        } else {
            // Default to reels and videos for better reel experience
            matchCriteria.postType = { $in: ["reel", "video"] };
        }

        // Filter by contentType if specified (normal, product, business)
        if (contentType) {
            matchCriteria.contentType = contentType;
        }

        // Filter by location if specified
        if (location) {
            matchCriteria.$or = [
                { "location": { $regex: location, $options: "i" } },
                { "customization.normal.location.name": { $regex: location, $options: "i" } },
                { "customization.product.location.name": { $regex: location, $options: "i" } },
                { "customization.business.location.city": { $regex: location, $options: "i" } }
            ];
        }

        // Filter by tag if specified
        if (tag) {
            matchCriteria.$or = [
                ...(matchCriteria.$or || []),
                { "hashtags": { $in: [tag] } },
                { "customization.normal.tags": { $in: [tag] } },
                { "customization.product.tags": { $in: [tag] } },
                { "customization.business.tags": { $in: [tag] } }
            ];
        }

        // Build sort criteria
        let sortCriteria = {};
        switch (sortBy) {
            case 'popular':
                sortCriteria = { "engagement.likes": -1, "engagement.views": -1, createdAt: -1 };
                break;
            case 'trending':
                sortCriteria = { "engagement.shares": -1, "engagement.comments": -1, createdAt: -1 };
                break;
            case 'oldest':
                sortCriteria = { createdAt: 1 };
                break;
            case 'latest':
            default:
                sortCriteria = { createdAt: -1, _id: -1 };
                break;
        }

        // Check cache first
        const cacheKey = `${pageNum}_${limitNum}_${currentUserId || 'anonymous'}_${postType || 'all'}_${contentType || 'all'}_${sortBy}_${location || ''}_${tag || ''}_${suggested}`;
        if (cache.reels.data &&
            cache.reels.timestamp &&
            cache.reels.cacheKey === cacheKey &&
            (Date.now() - cache.reels.timestamp < cache.reels.expiry)) {

            return res.status(200).json(
                new ApiResponse(200, cache.reels.data, "Reels fetched from cache")
            );
        }

        // Build aggregation pipeline for comprehensive data
        const pipeline = [
            // Match criteria
            { $match: matchCriteria },

            // Sort by specified criteria
            { $sort: sortCriteria },

            // Add pagination
            { $skip: skip },
            { $limit: limitNum },



            // Add computed fields and enhance with Bunny.net details
            {
                $addFields: {
                    isLikedBy: false, // Will be updated based on user context
                    isFollowed: false, // Will be updated based on user context

                    // Enhanced media with Bunny.net details
                    media: {
                        $map: {
                            input: "$media",
                            as: "mediaItem",
                            in: {
                                $mergeObjects: [
                                    "$$mediaItem",
                                    {
                                        // Add Bunny.net metadata
                                        bunnyId: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $let: {
                                                        vars: {
                                                            filename: { $arrayElemAt: ["$$urlParts", -1] }
                                                        },
                                                        in: { $arrayElemAt: [{ $split: ["$$filename", "."] }, 0] }
                                                    }
                                                }
                                            }
                                        },
                                        bunnyFolder: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $arrayElemAt: ["$$urlParts", -2]
                                                }
                                            }
                                        },
                                        isBunnyHosted: {
                                            $regexMatch: {
                                                input: { $ifNull: ["$$mediaItem.url", ""] },
                                                regex: "b-cdn.net"
                                            }
                                        },
                                        quality: { $ifNull: ["$$mediaItem.quality", "auto"] },
                                        publicId: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $let: {
                                                        vars: {
                                                            filename: { $arrayElemAt: ["$$urlParts", -1] },
                                                            folder: { $arrayElemAt: ["$$urlParts", -2] }
                                                        },
                                                        in: {
                                                            $concat: [
                                                                "$$folder",
                                                                "/",
                                                                { $arrayElemAt: [{ $split: ["$$filename", "."] }, 0] }
                                                            ]
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        ];

        // Add user-specific fields if currentUserId is available
        if (currentUserId) {
            // ✅ FIXED: Convert currentUserId to ObjectId for aggregation lookups
            const currentUserObjectId = new mongoose.Types.ObjectId(currentUserId);

            pipeline.push({
                $lookup: {
                    from: "likes",
                    let: { postId: "$_id", userId: currentUserObjectId },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$postId", "$$postId"] },
                                        { $eq: ["$userId", "$$userId"] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: "userLike"
                }
            });

            // Add lookup for following relationship
            pipeline.push({
                $lookup: {
                    from: "followings",
                    let: { postUserId: "$userId", currentUserId: currentUserObjectId },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$userId", "$$currentUserId"] },
                                        { $eq: ["$followingId", "$$postUserId"] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: "userFollow"
                }
            });

            pipeline.push({
                $addFields: {
                    isLikedBy: { $gt: [{ $size: "$userLike" }, 0] },
                    isFollowed: { $gt: [{ $size: "$userFollow" }, 0] }
                }
            });

            // Clean up temporary lookup fields
            pipeline.push({
                $project: {
                    userLike: 0,
                    userFollow: 0
                }
            });
        }

        // Remove analytics field from all responses
        pipeline.push({
            $project: {
                analytics: 0,
                customization: 0
            }
        });

        console.log('🎬 Reels Debug - Match criteria:', JSON.stringify(matchCriteria, null, 2));

        // Execute aggregation
        let reels = await Post.aggregate(pipeline);

        console.log('🎬 Reels Debug - Reels found:', reels.length);

        // ✅ NOTE: Business payment plan filtering does NOT apply to reels
        // Business accounts can post reels freely without needing a paid plan
        // The payment plan filter ONLY applies to posts and ads

        if (reels.length === 0) {
            // Debug: Check if there are ANY reels in the database
            const totalReelsInDB = await Post.countDocuments({ postType: { $in: ["reel", "video"] } });
            const publishedReels = await Post.countDocuments({ postType: { $in: ["reel", "video"] }, status: "published" });
            console.log('⚠️ No reels found. Debug info:');
            console.log('   - Total reels in DB:', totalReelsInDB);
            console.log('   - Published reels in DB:', publishedReels);
            console.log('   - Allowed users count:', allowedUserIds.length);
            console.log('   - Blocked users count:', blockedUsers.length);
        }

        // Fetch user details using User model
        if (reels.length > 0) {
            // Get unique user IDs from reels
            const userIds = [...new Set(reels.map(reel => reel.userId))];

            // Fetch user details for all unique user IDs
            const users = await User.find(
                { _id: { $in: userIds } },
                { _id: 1, username: 1, fullName: 1, profileImageUrl: 1 }
            );

            // Create a map for quick user lookup
            const userMap = {};
            users.forEach(user => {
                userMap[user._id.toString()] = user;
            });

            // Add user details to each reel
            reels.forEach(reel => {
                const user = userMap[reel.userId?.toString()];
                if (user) {
                    reel.userId = {
                        _id: user._id,
                        username: user.username,
                        fullName: user.fullName
                    };
                    reel.profileImageUrl = user.profileImageUrl;
                } else {
                    // If user not found, set default structure
                    reel.userId = {
                        _id: reel.userId,
                        username: null,
                        fullName: null
                    };
                    reel.profileImageUrl = null;
                }
            });

            // Enrich reels with review/rating data
            reels = await enrichWithRatings(reels, 'userId');

            // Add subscription badges to reel authors
            reels = await addBadgesToNestedUsers(reels);

            // ✅ Get all likes for reels with user details for "Liked by" preview
            const reelIds = reels.map(reel => reel._id);
            const allLikes = await Like.find({
                postId: { $in: reelIds }
            })
            .populate('userId', 'username fullName profileImageUrl')
            .select('postId userId')
            .lean();

            // Group likes by reelId
            const likesByReel = new Map();
            allLikes.forEach(like => {
                if (like.userId) { // Filter out likes from deleted users
                    const reelId = like.postId.toString();
                    if (!likesByReel.has(reelId)) {
                        likesByReel.set(reelId, []);
                    }
                    likesByReel.get(reelId).push({
                        _id: like.userId._id,
                        username: like.userId.username,
                        fullName: like.userId.fullName,
                        profileImageUrl: like.userId.profileImageUrl
                    });
                }
            });

            // Get user's followers and following for "Liked by" preview
            let userFollowing = [];
            let userFollowers = [];
            if (currentUserId) {
                const user = await User.findById(currentUserId)
                    .select('following followers')
                    .lean();
                userFollowing = user?.following || [];
                userFollowers = user?.followers || [];
            }

            // Add "Liked by" preview to each reel
            reels = reels.map(reel => {
                const reelIdStr = reel._id.toString();
                const likedByUsers = likesByReel.get(reelIdStr) || [];

                // Generate "Liked by" preview
                const likedByPreview = getLikedByPreview(
                    likedByUsers,
                    currentUserId,
                    userFollowing,
                    userFollowers
                );

                return {
                    ...reel,
                    likedBy: likedByUsers, // Include likedBy array for frontend fallback
                    likedByPreview: likedByPreview.likedByText ? {
                        text: likedByPreview.likedByText,
                        previewUser: likedByPreview.previewUser,
                        othersCount: likedByPreview.othersCount
                    } : null
                };
            });
        }

        // Get total count for pagination
        const totalReels = await Post.countDocuments(matchCriteria);

        const responseData = {
            reels,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: totalReels,
                totalPages: Math.ceil(totalReels / limitNum),
                hasNext: pageNum < Math.ceil(totalReels / limitNum),
                hasPrev: pageNum > 1
            },
            filters: {
                postType: postType || 'all',
                contentType: contentType || 'all',
                sortBy: sortBy,
                location: location || null,
                tag: tag || null,
                suggested: suggested
            },
            metadata: {
                totalResults: totalReels,
                currentQuery: req.query,
                timestamp: new Date().toISOString()
            }
        };

        // Save to cache
        cache.reels.data = responseData;
        cache.reels.timestamp = Date.now();
        cache.reels.cacheKey = cacheKey;

        return res.status(200).json(
            new ApiResponse(200, responseData, "Reels fetched successfully")
        );
    } catch (error) {
        console.error("Error fetching reels:", error);
        return res.status(500).json(
            new ApiResponse(500, {}, "Error fetching reels from database")
        );
    }
});