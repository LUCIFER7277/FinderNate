import Post from "../models/userPost.models.js";
import Reel from "../models/reels.models.js";
import Story from "../models/story.models.js";
import { User } from "../models/user.models.js";
import Business from "../models/business.models.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { getViewableUserIds } from "../middlewares/privacy.middleware.js";
import { enrichWithRatings } from "../utlis/reviewUtils.js";
import { addBadgesToNestedUsers, addBadgesToUsers } from "../utlis/userBadge.utils.js";
import mongoose from "mongoose";

export const getExploreFeed = asyncHandler(async (req, res) => {
    let { contentType = "all", sortBy = "time", page = 1, limit = 10 } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 10;

    // Get blocked users from middleware
    const blockedUsers = req.blockedUsers || [];
    
    // Get viewable user IDs based on privacy settings
    const viewerId = req.user?._id;
    const viewableUserIds = await getViewableUserIds(viewerId);

    // Calculate how many reels and posts per page (default: 2 reels, rest posts)
    const reelsPerPage = Math.min(2, limit);
    const postsPerPage = limit - reelsPerPage;

    // If contentType=all, fetch all allowed types; otherwise, use the provided contentType
    const allowedTypes = ['normal', 'service', 'product', 'business'];
    let postMatch = {};

    if (contentType !== "all") {
        const typeArray = contentType.split(",").map(t => t.trim().toLowerCase());
        postMatch.contentType = { $in: typeArray };
        // When filtering by specific contentType, include ALL postTypes (including reels)
    } else {
        // When contentType=all, exclude reels to avoid duplication with separate reel query
        postMatch.postType = { $ne: "reel" };
        postMatch.contentType = { $in: allowedTypes };
    }

    // 1. Get reels (only when contentType=all, otherwise reels are included in posts query)
    let reels = [];
    let paidBusinessStories = []; // Initialize paid business stories array

    if (contentType === "all") {
        // For types=all, get reels separately to avoid duplication
        const legacyReels = await Reel.aggregate([
            { 
                $match: { 
                    isPublic: true,
                    userId: { $in: viewableUserIds, $nin: blockedUsers }
                } 
            },
            { $sample: { size: reelsPerPage } },
            {
                $project: {
                    analytics: 0,
                    __v: 0,
                    "settings.customAudience": 0,
                    "customization.normal": 0
                }
            }
        ]);
        reels = legacyReels;
    }
    // When filtering by specific contentType, reels are included in the posts query below

    // 2. Get posts using reliable find() method like homeFeed (not aggregation)
    const EXPLORE_LIMIT = 100;

    // Get all posts matching the criteria using the same reliable approach as homeFeed (excluding blocked users and respecting privacy)
    const allPosts = await Post.find({
        ...postMatch,
        userId: { $in: viewableUserIds, $nin: blockedUsers }
    })
        .sort({ createdAt: -1 })
        .limit(EXPLORE_LIMIT)
        .populate('userId', 'username profileImageUrl')
        .select('-analytics -__v -settings.customAudience');

    // Filter out unpaid business posts
    const filteredPosts = await filterBusinessPostsByPaymentPlan(allPosts);

    // Separate paid business posts and regular posts for interspersing
    const paidBusinessPosts = [];
    const regularPosts = [];
    
    // Get active payment plan user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));
    
    // Get business user IDs
    const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
    const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

    filteredPosts.forEach(post => {
        const userId = post.userId?._id || post.userId;
        const userIdStr = userId ? userId.toString() : null;
        const isBusiness = userIdStr && businessUserIdsSet.has(userIdStr);
        const hasActivePlan = userIdStr && activePlanUserIdsSet.has(userIdStr);
        
        if (isBusiness && hasActivePlan) {
            paidBusinessPosts.push(post);
        } else {
            regularPosts.push(post);
        }
    });

    // Shuffle arrays separately
    function shuffleArray(arr) {
        return arr
            .map(value => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);
    }

    const shuffledRegularPosts = shuffleArray(regularPosts);
    const shuffledPaidBusinessPosts = shuffleArray(paidBusinessPosts);

    // Intersperse paid business posts between regular posts
    // Insert 1 paid business post every 3-5 regular posts
    let posts = [];
    let regularIndex = 0;
    let paidIndex = 0;
    const insertInterval = 4; // Insert paid post every 4 regular posts
    
    while (regularIndex < shuffledRegularPosts.length || paidIndex < shuffledPaidBusinessPosts.length) {
        // Add regular posts
        const regularBatch = shuffledRegularPosts.slice(regularIndex, regularIndex + insertInterval);
        posts.push(...regularBatch);
        regularIndex += insertInterval;
        
        // Add one paid business post if available
        if (paidIndex < shuffledPaidBusinessPosts.length) {
            posts.push(shuffledPaidBusinessPosts[paidIndex]);
            paidIndex++;
        }
        
        // Break if we've added enough posts
        if (posts.length >= EXPLORE_LIMIT) {
            posts = posts.slice(0, EXPLORE_LIMIT);
            break;
        }
    }

    // Apply sorting if requested (but keep shuffled by default)
    if (sortBy !== "time") {
        posts = posts.sort((a, b) => {
            switch (sortBy) {
                case "likes":
                    return (b.engagement?.likes || 0) - (a.engagement?.likes || 0);
                case "comments":
                    return (b.engagement?.comments || 0) - (a.engagement?.comments || 0);
                case "shares":
                    return (b.engagement?.shares || 0) - (a.engagement?.shares || 0);
                case "views":
                    return (b.engagement?.views || 0) - (a.engagement?.views || 0);
                case "engagement":
                    const aEng = (a.engagement?.likes || 0) + (a.engagement?.comments || 0) + (a.engagement?.shares || 0) + (a.engagement?.views || 0);
                    const bEng = (b.engagement?.likes || 0) + (b.engagement?.comments || 0) + (b.engagement?.shares || 0) + (b.engagement?.views || 0);
                    return bEng - aEng;
                default:
                    return 0; // Keep shuffled order
            }
        });
    }

    // Paginate posts (adjust pagination based on whether reels are separate or included)
    let skip, take;
    if (contentType === "all") {
        // For contentType=all, paginate only posts (reels handled separately)
        skip = (page - 1) * postsPerPage;
        take = postsPerPage;
    } else {
        // For specific contentType, paginate all content (posts + reels together)
        skip = (page - 1) * limit;
        take = limit;
    }
    posts = posts.slice(skip, skip + take);

    // Handle reel user details (reels need separate user fetching)
    if (reels.length > 0) {
        const reelUserIds = [...new Set(reels.map(reel => reel.userId))].filter(id => id != null);

        const reelUsers = await User.find(
            { _id: { $in: reelUserIds } },
            { _id: 1, username: 1, fullName: 1, profileImageUrl: 1 }
        );

        const reelUserMap = {};
        reelUsers.forEach(user => {
            reelUserMap[user._id.toString()] = user;
        });

        reels.forEach(reel => {
            const user = reelUserMap[reel.userId?.toString()];
            if (user) {
                reel.userId = {
                    _id: user._id,
                    username: user.username,
                    fullName: user.fullName
                };
                reel.profileImageUrl = user.profileImageUrl;
            } else {
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
    }

    // Posts already have populated user details from the query

    // Enrich posts with review/rating data
    posts = await enrichWithRatings(posts, 'userId');
    
    // Add subscription badges to post authors
    posts = await addBadgesToNestedUsers(posts);

    // Combine and shuffle final feed based on query type
    let feed, totalAvailable, totalPages, hasNextPage;

    if (contentType === "all") {
        // For contentType=all, combine reels, posts, and business stories
        feed = [
            ...reels.map(r => ({ ...r, _type: "reel", location: null })), // Legacy reels don't have location
            ...paidBusinessStories.map(s => ({
                ...s,
                _type: "business_story",
                postType: s.mediaType,
                location: null
            })),
            ...posts.map(p => {
                const post = p.toObject ? p.toObject() : p;

                // Extract location from customization based on contentType
                let location = null;
                if (post.customization) {
                    if (post.contentType && post.customization[post.contentType]?.location) {
                        location = post.customization[post.contentType].location;
                    } else if (post.customization.normal?.location) {
                        location = post.customization.normal.location;
                    }
                }

                // Ensure location has proper structure with name and coordinates
                if (location && (location.name || location.coordinates)) {
                    location = {
                        name: location.name || null,
                        coordinates: location.coordinates || null,
                        // Include other location fields if they exist
                        ...(location.address && { address: location.address }),
                        ...(location.city && { city: location.city }),
                        ...(location.state && { state: location.state }),
                        ...(location.country && { country: location.country }),
                        ...(location.type && { type: location.type })
                    };
                }

                return {
                    ...post,
                    _type: post.postType === "reel" ? "reel" : "post",
                    location
                };
            })
        ];

        // Final shuffle of the combined feed for variety
        for (let i = feed.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [feed[i], feed[j]] = [feed[j], feed[i]];
        }

        totalAvailable = allPosts.length;
        totalPages = Math.ceil(totalAvailable / postsPerPage);
        hasNextPage = page < totalPages;
    } else {
        // For specific contentType, everything comes from posts query
        feed = posts.map(p => {
            const post = p.toObject ? p.toObject() : p;

            // Extract location from customization based on contentType
            let location = null;
            if (post.customization) {
                if (post.contentType && post.customization[post.contentType]?.location) {
                    location = post.customization[post.contentType].location;
                } else if (post.customization.normal?.location) {
                    location = post.customization.normal.location;
                }
            }

            // Ensure location has proper structure with name and coordinates
            if (location && (location.name || location.coordinates)) {
                location = {
                    name: location.name || null,
                    coordinates: location.coordinates || null,
                    // Include other location fields if they exist
                    ...(location.address && { address: location.address }),
                    ...(location.city && { city: location.city }),
                    ...(location.state && { state: location.state }),
                    ...(location.country && { country: location.country }),
                    ...(location.type && { type: location.type })
                };
            }

            return {
                ...post,
                _type: post.postType === "reel" ? "reel" : "post",
                location
            };
        });

        totalAvailable = allPosts.length;
        totalPages = Math.ceil(totalAvailable / limit);
        hasNextPage = page < totalPages;
    }

    res.status(200).json(new ApiResponse(200, {
        feed,
        pagination: {
            page,
            limit,
            reelsCount: contentType === "all" ? reels.length : feed.filter(item => item._type === "reel").length,
            postsCount: contentType === "all" ? posts.length : feed.filter(item => item._type === "post").length,
            businessStoriesCount: contentType === "all" ? paidBusinessStories.length : 0,
            total: feed.length,
            totalAvailable,
            totalPages,
            hasNextPage
        }
    }, "Explore feed generated"));
});