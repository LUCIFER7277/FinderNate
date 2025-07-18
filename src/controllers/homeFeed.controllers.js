import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import Story from '../models/story.models.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';

export const getHomeFeed = async (req, res) => {
    try {
        const userId = req.user._id;
        const userLocation = req.user.location && req.user.location.coordinates && Array.isArray(req.user.location.coordinates)
            ? req.user.location
            : null;

        const FEED_LIMIT = 100;
        const NEARBY_DISTANCE_KM = 20;
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // ✅ 1. Get following and followers
        const user = await User.findById(userId).select('following followers');
        const following = user?.following || [];
        const followers = user?.followers || [];

        const feedUserIds = [...new Set([
            ...following.map(id => id.toString()),
            ...followers.map(id => id.toString())
        ])];

        // ✅ 2. Base post filter
        const allowedTypes = ['normal', 'service', 'product', 'business'];
        const baseQuery = { contentType: { $in: allowedTypes } };

        // ✅ 3a. Posts from followed/follower users
        const followedPosts = await Post.find({
            ...baseQuery,
            userId: { $in: feedUserIds }
        })
            .sort({ createdAt: -1 })
            .limit(FEED_LIMIT)
            .populate('userId', 'username profileImageUrl');

        // ✅ 3b. Trending posts
        const trendingPosts = await Post.find({
            ...baseQuery,
            createdAt: { $gte: yesterday }
        })
            .sort({
                'engagement.likes': -1,
                'engagement.comments': -1,
                'engagement.shares': -1,
                'engagement.views': -1,
                createdAt: -1
            })
            .limit(FEED_LIMIT)
            .populate('userId', 'username profileImageUrl');

        // ✅ 3c. Nearby posts
        let nearbyPosts = [];
        if (userLocation && userLocation.coordinates) {
            nearbyPosts = await Post.find({
                ...baseQuery,
                $or: [
                    { 'customization.normal.location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: userLocation.coordinates }, $maxDistance: NEARBY_DISTANCE_KM * 1000 } } },
                    { 'customization.service.location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: userLocation.coordinates }, $maxDistance: NEARBY_DISTANCE_KM * 1000 } } },
                    { 'customization.product.location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: userLocation.coordinates }, $maxDistance: NEARBY_DISTANCE_KM * 1000 } } },
                    { 'customization.business.location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: userLocation.coordinates }, $maxDistance: NEARBY_DISTANCE_KM * 1000 } } }
                ]
            })
                .limit(FEED_LIMIT)
                .populate('userId', 'username profileImageUrl');
        }

        // ✅ 3d. Non-followed users' posts
        const nonFollowedPosts = await Post.find({
            ...baseQuery,
            userId: { $nin: [...feedUserIds, userId] }
        })
            .sort({ createdAt: -1 })
            .limit(FEED_LIMIT)
            .populate('userId', 'username profileImageUrl');

        // ✅ 4. Define content-type weight
        const getContentTypeWeight = (type) => {
            switch (type) {
                case 'product': return 0.5;
                case 'service': return 0.4;
                case 'business': return 0.3;
                case 'normal': return 0.1;
                default: return 0;
            }
        };

        // ✅ 5. Score & tag posts
        const scoredPosts = [
            ...followedPosts.map(p => ({ ...p.toObject(), _score: 4 + getContentTypeWeight(p.contentType) })),
            ...nearbyPosts.map(p => ({ ...p.toObject(), _score: 3 + getContentTypeWeight(p.contentType) })),
            ...trendingPosts.map(p => ({ ...p.toObject(), _score: 2 + getContentTypeWeight(p.contentType) })),
            ...nonFollowedPosts.map(p => ({ ...p.toObject(), _score: 1 + getContentTypeWeight(p.contentType) })),
        ];

        // ✅ 6. Deduplicate and sort
        const seen = new Set();
        const rankedFeed = scoredPosts
            .filter(post => {
                const id = post._id.toString();
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            })
            .sort((a, b) => {
                if (b._score !== a._score) return b._score - a._score;
                return new Date(b.createdAt) - new Date(a.createdAt);
            });

        // --- Pagination logic ---
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const skip = (page - 1) * limit;
        const paginatedFeed = rankedFeed.slice(skip, skip + limit);

        // ✅ 7. Get stories from self + following (not followers)
        const storyUserIds = [userId, ...following];
        const stories = await Story.find({
            userId: { $in: storyUserIds },
            isArchived: false,
            expiresAt: { $gt: now }
        })
            .sort({ createdAt: -1 })
            .populate('userId', 'username profileImageUrl');

        // ✅ 8. Return both
        return res.status(200).json(
            new ApiResponse(200, {
                stories,
                feed: paginatedFeed,
                pagination: {
                    page,
                    limit,
                    total: rankedFeed.length,
                    totalPages: Math.ceil(rankedFeed.length / limit)
                }
            }, "Home feed and stories generated successfully")
        );

    } catch (error) {
        console.error(error);
        throw new ApiError(500, 'Failed to generate home feed');
    }
};
