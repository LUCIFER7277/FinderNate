import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import Comment from '../models/comment.models.js';
import { asyncHandler } from '../utlis/asyncHandler.js';
import Like from '../models/like.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { setCache } from '../middlewares/cache.middleware.js';
import { redisClient } from '../config/redis.config.js';
import { getViewableUserIds } from '../middlewares/privacy.middleware.js';
import { bulkCheckActivePaymentPlans } from '../utlis/businessPlan.utils.js';
import mongoose from 'mongoose';

export const getHomeFeed = asyncHandler(async (req, res) => {
    try {
        // ✅ FIXED: Handle both Mongoose document and plain object from cache
        const userId = req.user?._id ? (typeof req.user._id === 'string' ? req.user._id : req.user._id.toString()) : null;
        // ✅ FIXED: Convert blocked user IDs to ObjectIds for MongoDB aggregation
        const blockedUsersRaw = req.blockedUsers || [];
        const blockedUsers = blockedUsersRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );
        const page = parseInt(req.query.page, 10) || 1;
        const MAX_LIMIT = 100; // Prevent excessive data requests
        const requestedLimit = parseInt(req.query.limit, 10) || 20;
        const limit = Math.min(requestedLimit, MAX_LIMIT);
        const skip = (page - 1) * limit;

        console.log('🔍 Feed Debug - userId:', userId);
        console.log('🔍 Feed Debug - blockedUsers count:', blockedUsers.length);

        // Check cache first
        if (res.locals.cacheKey) {
            const cachedData = await redisClient.get(res.locals.cacheKey);
            if (cachedData) {
                console.log('📦 Returning cached feed');
                return res.status(200).json(JSON.parse(cachedData));
            }
        }

        const FEED_LIMIT = 50; // Reduced from 100
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // ✅ 1. Get viewable user IDs based on privacy settings and following relationships
        // For logged-out users (userId is null), this returns only users with public privacy
        // For logged-in users, this returns their following + their own posts + public users
        const viewableUserIdsRaw = await getViewableUserIds(userId);
        // ✅ FIXED: Convert string IDs back to ObjectIds for MongoDB aggregation
        const viewableUserIds = viewableUserIdsRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );
        console.log('🔍 Feed Debug - viewableUserIds count:', viewableUserIds.length);

        // ✅ 2. Get following and followers for prioritization (only if user is authenticated)
        let feedUserIds = [];
        if (userId) {
            const user = await User.findById(userId)
                .select('following followers')
                .lean(); // Use lean() for better performance
            const following = user?.following || [];
            const followers = user?.followers || [];

            // ✅ FIXED: Convert to ObjectIds for aggregation
            feedUserIds = [...new Set([
                ...following.map(id => typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id),
                ...followers.map(id => typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id)
            ])];
            console.log('🔍 Feed Debug - feedUserIds count:', feedUserIds.length);
        }

        // ✅ Get business users with active payment plans for filtering and prioritization
        const activePaymentPlanUserIds = await Business.find({
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId').lean();
        const activePlanUserIds = activePaymentPlanUserIds.map(b => b.userId);
        const activePlanUserIdsSet = new Set(activePlanUserIds.map(id => id.toString()));
        
        // Get all business user IDs
        const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
        const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

        // ✅ 3. OPTIMIZED: Single aggregation query with privacy filtering
        const matchQuery = {
            contentType: { $in: ['normal', 'service', 'product', 'business'] },
            userId: { $in: viewableUserIds, $nin: blockedUsers },
            // For logged-out users, only show posts with public visibility
            ...(userId ? {} : {
                $or: [
                    { 'settings.visibility': 'public' },
                    { 'settings.visibility': { $exists: false } }, // Default to public if no setting
                    { 'settings.visibility': null } // Null means public
                ]
            })
        };

        console.log('🔍 Feed Debug - Match query:', JSON.stringify(matchQuery, null, 2));

        const aggregationPipeline = [
            {
                $match: matchQuery
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userInfo',
                    pipeline: [
                        { $project: { isBusinessProfile: 1 } }
                    ]
                }
            },
            {
                $addFields: {
                    isBusinessAccount: {
                        $cond: [
                            { $gt: [{ $size: '$userInfo' }, 0] },
                            { $arrayElemAt: ['$userInfo.isBusinessProfile', 0] },
                            false
                        ]
                    },
                    userIdForCheck: '$userId'
                }
            },
            {
                $match: {
                    $expr: {
                        $or: [
                            // Keep non-business posts
                            { $eq: ['$isBusinessAccount', false] },
                            // Keep business posts only if user has active payment plan
                            {
                                $and: [
                                    { $eq: ['$isBusinessAccount', true] },
                                    { $in: ['$userIdForCheck', activePlanUserIds] }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $addFields: {
                    // Score posts by priority
                    feedScore: {
                        $add: [
                            // Paid business posts get HIGHEST priority (even higher than followed users)
                            {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$isBusinessAccount', true] },
                                            { $in: ['$userIdForCheck', activePlanUserIds] }
                                        ]
                                    },
                                    200, // Highest priority for paid business posts
                                    0
                                ]
                            },
                            // Followed users get high priority (but lower than paid business)
                            { $cond: [{ $in: ['$userId', feedUserIds] }, 100, 0] },
                            // Recent posts get boost
                            { $cond: [{ $gte: ['$createdAt', yesterday] }, 20, 0] },
                            // Engagement boost (capped at 30)
                            { $min: [
                                { $add: [
                                    { $multiply: [{ $ifNull: ['$engagement.likes', 0] }, 1] },
                                    { $multiply: [{ $ifNull: ['$engagement.comments', 0] }, 2] },
                                    { $multiply: [{ $ifNull: ['$engagement.shares', 0] }, 3] }
                                ]},
                                30
                            ]},
                            // Content type boost
                            { $switch: {
                                branches: [
                                    { case: { $eq: ['$contentType', 'product'] }, then: 15 },
                                    { case: { $eq: ['$contentType', 'service'] }, then: 12 },
                                    { case: { $eq: ['$contentType', 'business'] }, then: 10 }
                                ],
                                default: 8
                            }}
                        ]
                    }
                }
            },
            {
                $sort: { feedScore: -1, createdAt: -1 }
            },
            {
                $skip: skip
            },
            {
                $limit: limit
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userId',
                    pipeline: [
                        { $project: { username: 1, profileImageUrl: 1, fullName: 1, isVerified: 1 } }
                    ]
                }
            },
            {
                $unwind: '$userId'
            },
            {
                $project: {
                    isBusinessAccount: 0,
                    userIdForCheck: 0,
                    userInfo: 0
                }
            },
            {
                // Project only necessary fields to reduce payload size
                $project: {
                    _id: 1,
                    userId: 1,
                    contentType: 1,
                    caption: 1,
                    media: 1,
                    'settings.privacy': 1,
                    'settings.visibility': 1,
                    'settings.commentsEnabled': 1,
                    'settings.likesVisible': 1,
                    'engagement.likes': 1,
                    'engagement.comments': 1,
                    'engagement.shares': 1,
                    'engagement.saves': 1,
                    'engagement.views': 1,
                    location: 1,
                    tags: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    isPromoted: 1,
                    // Include customization fields (product, service, business, normal)
                    'customization.product': 1,
                    'customization.service': 1,
                    'customization.business': 1,
                    'customization.normal': 1
                }
            }
        ];

        const posts = await Post.aggregate(aggregationPipeline);

        console.log('🔍 Feed Debug - Posts found:', posts.length);

        if (posts.length === 0) {
            // Debug: Check if there are ANY posts in the database
            const totalPosts = await Post.countDocuments({});
            const publicPosts = await Post.countDocuments({ 'settings.privacy': 'public' });
            console.log('⚠️ No posts in feed. Debug info:');
            console.log('   - Total posts in DB:', totalPosts);
            console.log('   - Public posts in DB:', publicPosts);
            console.log('   - Viewable users count:', viewableUserIds.length);
            console.log('   - Blocked users count:', blockedUsers.length);

            const emptyResponse = new ApiResponse(200, {
                feed: [],
                pagination: { page, limit, total: 0, totalPages: 0 }
            }, "No posts found");

            // Cache empty response for shorter time
            if (res.locals.cacheKey) {
                await setCache(res.locals.cacheKey, emptyResponse, 60);
            }
            return res.status(200).json(emptyResponse);
        }

        // ✅ 3. Get user likes in a single optimized query
        const postIds = posts.map(post => post._id);
        let likedPostIds = new Set();
        if (userId) {
            const userLikes = await Like.find({
                userId: userId,
                postId: { $in: postIds }
            }).select('postId').lean();
            likedPostIds = new Set(userLikes.map(like => like.postId.toString()));
        }

        // ✅ 4. Get top comments efficiently (no nested queries)
        const allComments = await Comment.find({
            postId: { $in: postIds },
            parentCommentId: null,
            isDeleted: false
        })
        .sort({ createdAt: -1 })
        .limit(postIds.length * 3) // Max 3 comments per post
        .populate('userId', 'username profileImageUrl')
        .select('_id content userId createdAt postId')
        .lean();

        // Group comments by postId
        const commentsByPost = new Map();
        allComments.forEach(comment => {
            if (comment.userId) { // Filter out comments from deleted users
                const postId = comment.postId.toString();
                if (!commentsByPost.has(postId)) {
                    commentsByPost.set(postId, []);
                }
                if (commentsByPost.get(postId).length < 3) { // Limit to 3 comments per post
                    commentsByPost.get(postId).push({
                        commentId: comment._id,
                        content: comment.content,
                        createdAt: comment.createdAt,
                        user: {
                            _id: comment.userId._id,
                            username: comment.userId.username,
                            profileImageUrl: comment.userId.profileImageUrl
                        },
                        replies: [] // Don't load replies for performance - load on demand
                    });
                }
            }
        });

        // ✅ 5. Format final response
        const feedData = posts.map(post => ({
            ...post,
            comments: commentsByPost.get(post._id.toString()) || [],
            isLikedBy: likedPostIds.has(post._id.toString())
        }));

        // Get total count for pagination (cached to avoid expensive count queries)
        // Need to count posts excluding unpaid business posts
        let totalCount = posts.length; // Simplified - use actual count for better pagination
        if (page === 1 && posts.length === limit) {
            // Only do count query for first page if it's full
            try {
                // Count all posts, then filter out unpaid business posts
                const allPostsForCount = await Post.find({
                    contentType: { $in: ['normal', 'service', 'product', 'business'] },
                    userId: { $nin: blockedUsers, $in: viewableUserIds }
                }).select('userId').lean();
                
                // Filter out unpaid business posts
                const filteredPosts = allPostsForCount.filter(post => {
                    const userIdStr = post.userId.toString();
                    const isBusiness = businessUserIdsSet.has(userIdStr);
                    if (!isBusiness) return true; // Keep non-business posts
                    return activePlanUserIdsSet.has(userIdStr); // Keep only paid business posts
                });
                
                totalCount = filteredPosts.length;
            } catch (error) {
                totalCount = posts.length; // Fallback
            }
        }

        const response = new ApiResponse(200, {
            feed: feedData,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        }, "Home feed generated successfully");

        // Cache the response
        if (res.locals.cacheKey && res.locals.cacheTTL) {
            await setCache(res.locals.cacheKey, response, res.locals.cacheTTL);
        }

        return res.status(200).json(response);

    } catch (error) {
        console.error(error);
        throw new ApiError(500, 'Failed to generate home feed');
    }
});
