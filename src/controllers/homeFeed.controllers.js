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
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import { getViewableUserIds } from '../middlewares/privacy.middleware.js';
import { bulkCheckActivePaymentPlans } from '../utlis/businessPlan.utils.js';
import mongoose from 'mongoose';
import { enrichWithRatings } from '../utlis/reviewUtils.js';
import { addBadgesToNestedUsers } from '../utlis/userBadge.utils.js';
import { getLikedByPreview } from '../utlis/likedByPreview.utils.js';

/**
 * ✅ HOME FEED - DATE SORTED WITH PAID BUSINESS PRIORITY
 *
 * Sorting Rules:
 * 1. Paid business posts (plan2/plan3/plan4) appear at the TOP, sorted by newest first
 * 2. All other posts appear below, sorted by newest first (date descending)
 * 3. Only business/product/service CONTENT TYPE posts from unpaid business accounts are HIDDEN
 * 4. Normal content (photos, tweets, videos) from ALL accounts always shows
 * 5. Reels from ALL accounts always show regardless of content type or payment status
 *
 * Payment Plan Criteria:
 * - subscriptionStatus must be 'active'
 * - plan must NOT be 'plan1' (plan1 is free)
 * - Valid paid plans: plan2, plan3, plan4
 */
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

        // Check cache first — isLikedBy is never stored in cache, always computed fresh
        const FEED_CACHE_KEY = RedisKeys.userFeed(userId, page);
        const cachedRaw = await redisClient.get(FEED_CACHE_KEY);
        if (cachedRaw) {
            console.log('📦 Returning cached feed');
            const cached = JSON.parse(cachedRaw);
            if (userId && cached?.data?.feed?.length) {
                const cachedPostIds = cached.data.feed.map(p => p._id);
                const userLikes = await Like.find({ userId, postId: { $in: cachedPostIds } })
                    .select('postId').lean();
                const likedSet = new Set(userLikes.map(l => l.postId.toString()));
                cached.data.feed = cached.data.feed.map(post => ({
                    ...post,
                    isLikedBy: likedSet.has(post._id.toString())
                }));
            }
            return res.status(200).json(cached);
        }

        const FEED_LIMIT = 50; // Reduced from 100

        // ✅ 1. Get viewable user IDs based on privacy settings and following relationships
        // For logged-out users (userId is null), this returns only users with public privacy
        // For logged-in users, this returns their following + their own posts + public users
        const viewableUserIdsRaw = await getViewableUserIds(userId);
        // ✅ FIXED: Convert string IDs back to ObjectIds for MongoDB aggregation
        const viewableUserIds = viewableUserIdsRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );
        console.log('🔍 Feed Debug - viewableUserIds count:', viewableUserIds.length);

        // ✅ BUSINESS POST PRIORITY SYSTEM
        // Get business users with active payment plans (plan2, plan3, plan4 - NOT plan1 which is free)
        const activePaymentPlanUserIds = await Business.find({
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId').lean();

        // Convert to both ObjectIds and strings for aggregation compatibility
        const activePlanUserIds = activePaymentPlanUserIds.map(b => b.userId);
        const activePlanUserIdsStrings = activePlanUserIds.map(id => id.toString());
        const activePlanUserIdsSet = new Set(activePlanUserIdsStrings);

        console.log('💼 Business Debug - Active paid plans count:', activePlanUserIds.length);
        console.log('💼 Business Debug - Active plan user IDs:', activePlanUserIdsStrings);

        // Get all business user IDs
        const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
        const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

        console.log('💼 Business Debug - Total business users:', businessUsers.length);

        // ✅ 3. OPTIMIZED: Single aggregation query with privacy filtering
        const matchQuery = {
            contentType: { $in: ['normal', 'service', 'product', 'business'] },
            postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
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
                    // Convert userId to string for comparison
                    userIdString: { $toString: '$userId' }
                }
            },
            {
                // ✅ CRITICAL: Filter out business-type content from unpaid business accounts
                // Rule: Only business/product/service CONTENT TYPE posts from unpaid business accounts are hidden
                // All other posts (normal posts, reels, tweets, videos) from ANY account are always shown
                // Reels are ALWAYS shown regardless of content type or business payment status
                $match: {
                    $expr: {
                        $or: [
                            // Keep ALL posts from users with active paid plans (no need to check isBusinessProfile)
                            { $in: ['$userIdString', activePlanUserIdsStrings] },
                            // Keep ALL posts from non-business accounts
                            { $eq: ['$isBusinessAccount', false] },
                            // Keep ALL reels regardless of content type or business status
                            { $eq: ['$postType', 'reel'] },
                            // For unpaid business accounts: only keep normal content type posts
                            {
                                $and: [
                                    { $eq: ['$isBusinessAccount', true] },
                                    { $not: { $in: ['$userIdString', activePlanUserIdsStrings] } },
                                    { $eq: ['$contentType', 'normal'] }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $addFields: {
                    // ✅ SIMPLE PRIORITY: Paid business posts on top, then everything sorted by date
                    // 1 = paid business post (appears on top), 0 = normal post (appears below)
                    // Only checks activePlanUserIdsStrings - no dependency on isBusinessProfile
                    isPaidBusiness: {
                        $cond: [
                            { $in: ['$userIdString', activePlanUserIdsStrings] },
                            1,
                            0
                        ]
                    }
                }
            },
            {
                // Sort: paid business posts first, then by newest date
                $sort: { isPaidBusiness: -1, createdAt: -1 }
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
                // Remove temporary fields used for filtering
                $project: {
                    isBusinessAccount: 0,
                    isPaidBusiness: 0,
                    userIdString: 0,
                    userInfo: 0
                }
            },
            {
                // Project only necessary fields to reduce payload size
                $project: {
                    _id: 1,
                    userId: 1,
                    contentType: 1,
                    postType: 1,
                    caption: 1,
                    description: 1,
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

        // ✅ 3.5. Get all likes for posts with user details for "Liked by" preview
        const allLikes = await Like.find({
            postId: { $in: postIds }
        })
        .populate('userId', 'username fullName profileImageUrl')
        .select('postId userId')
        .lean();

        // Group likes by postId
        const likesByPost = new Map();
        allLikes.forEach(like => {
            if (like.userId) { // Filter out likes from deleted users
                const postId = like.postId.toString();
                if (!likesByPost.has(postId)) {
                    likesByPost.set(postId, []);
                }
                likesByPost.get(postId).push({
                    _id: like.userId._id,
                    username: like.userId.username,
                    fullName: like.userId.fullName,
                    profileImageUrl: like.userId.profileImageUrl
                });
            }
        });

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
        // Get user's followers and following for "Liked by" preview (reuse from earlier fetch if available)
        let userFollowing = [];
        let userFollowers = [];
        if (userId) {
            const user = await User.findById(userId)
                .select('following followers')
                .lean();
            userFollowing = user?.following || [];
            userFollowers = user?.followers || [];
        }

        const feedData = posts.map(post => {
            const postIdStr = post._id.toString();
            const likedByUsers = likesByPost.get(postIdStr) || [];

            // Generate "Liked by" preview
            const likedByPreview = getLikedByPreview(
                likedByUsers,
                userId,
                userFollowing,
                userFollowers
            );

            return {
                ...post,
                comments: commentsByPost.get(postIdStr) || [],
                isLikedBy: likedPostIds.has(postIdStr),
                likedByPreview: likedByPreview.likedByText ? {
                    text: likedByPreview.likedByText,
                    previewUser: likedByPreview.previewUser,
                    othersCount: likedByPreview.othersCount
                } : null
            };
        });
        // Enrich posts with review/rating data
        const enrichedFeedData = await enrichWithRatings(feedData, 'userId');
        
        // Add subscription badges to post authors
        const feedDataWithBadges = await addBadgesToNestedUsers(enrichedFeedData);

        // Get total count for pagination (cached to avoid expensive count queries)
        // Need to count posts excluding unpaid business posts
        let totalCount = posts.length; // Simplified - use actual count for better pagination
        if (page === 1 && posts.length === limit) {
            // Only do count query for first page if it's full
            try {
                // Count all posts, filtering out business content from unpaid business accounts
                const allPostsForCount = await Post.find({
                    contentType: { $in: ['normal', 'service', 'product', 'business'] },
                    postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
                    userId: { $nin: blockedUsers, $in: viewableUserIds }
                }).select('userId contentType postType').lean();

                // Filter: keep all posts from paid plans, all from non-business,
                // all reels, and only normal contentType from unpaid business accounts
                const filteredPosts = allPostsForCount.filter(post => {
                    const userIdStr = post.userId.toString();
                    // Keep all posts from users with active paid plans
                    if (activePlanUserIdsSet.has(userIdStr)) return true;
                    // Keep all posts from non-business accounts
                    const isBusiness = businessUserIdsSet.has(userIdStr);
                    if (!isBusiness) return true;
                    // Always keep reels regardless of content type or business status
                    if (post.postType === 'reel') return true;
                    // For unpaid business accounts, only keep normal content type
                    return post.contentType === 'normal';
                });

                totalCount = filteredPosts.length;
            } catch (error) {
                totalCount = posts.length; // Fallback
            }
        }

        const response = new ApiResponse(200, {
            feed: feedDataWithBadges,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        }, "Home feed generated successfully");

        // Cache WITHOUT isLikedBy — it's always computed fresh to avoid stale heart state
        const feedToCache = feedDataWithBadges.map(({ isLikedBy, ...rest }) => rest);
        const responseToCache = new ApiResponse(200, {
            feed: feedToCache,
            pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) }
        }, "Home feed generated successfully");
        await setCache(FEED_CACHE_KEY, responseToCache, RedisTTL.USER_FEED);

        return res.status(200).json(response);

    } catch (error) {
        console.error(error);
        throw new ApiError(500, 'Failed to generate home feed');
    }
});
