import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Business from "../models/business.models.js";
import Follower from "../models/follower.models.js";

const getTrendingBusinessOwners = asyncHandler(async (req, res) => {
    // Handle case where req.user is undefined (no authentication)
    const currentUserId = req.user ? req.user._id : null;
    const { page = 1, limit = 10 } = req.query;

    // Get blocked users from middleware
    const blockedUsers = req.blockedUsers || [];

    // Skip value for pagination
    const skip = (page - 1) * limit;

    try {
        // Get trending business owners (businesses with most followers) - excluding blocked users
        const trendingBusinesses = await Business.aggregate([
            {
                $match: {
                    // Show businesses that are not inactive (includes 'pending' and 'active')
                    subscriptionStatus: { $ne: 'inactive' },
                    // Exclude businesses owned by blocked users
                    userId: { $nin: blockedUsers }
                }
            },
            {
                $addFields: {
                    followerCount: { $size: "$followers" }
                }
            },
            {
                $sort: { followerCount: -1 }
            },
            {
                $skip: skip
            },
            {
                $limit: parseInt(limit)
            }
        ]);

        let businessFollowingSet = new Set();

        // Check if current user is following these businesses (only if user is authenticated)
        if (currentUserId) {
            const businessUserIds = trendingBusinesses.map(b => b.userId);
            const currentUserBusinessFollowings = await Follower.find({
                followerId: currentUserId,
                userId: { $in: businessUserIds }
            }).select('userId');

            businessFollowingSet = new Set(currentUserBusinessFollowings.map(f => f.userId.toString()));
        }

        // Return only business profiles
        const businessProfiles = trendingBusinesses.map(business => ({
            _id: business._id,
            userId: business.userId, // Owner's user ID for profile navigation
            businessName: business.businessName,
            category: business.category,
            description: business.description,
            logoUrl: business.logoUrl,
            followersCount: business.followers ? business.followers.length : 0,
            isFollowing: currentUserId ? businessFollowingSet.has(business.userId.toString()) : false
        }));

        // Get total count for pagination (excluding blocked users)
        const totalBusinesses = await Business.countDocuments({
            // Show businesses that are not inactive (includes 'pending' and 'active')
            subscriptionStatus: { $ne: 'inactive' },
            // Exclude businesses owned by blocked users
            userId: { $nin: blockedUsers }
        });

        return res.status(200).json(
            new ApiResponse(200, {
                businesses: businessProfiles,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalBusinesses / limit),
                    totalBusinesses,
                    hasNextPage: skip + parseInt(limit) < totalBusinesses,
                    hasPrevPage: page > 1
                }
            }, "Trending business profiles retrieved successfully")
        );

    } catch (error) {
        throw new ApiError(500, "Error fetching trending business profiles: " + error.message);
    }
});

export {
    getTrendingBusinessOwners
}; 