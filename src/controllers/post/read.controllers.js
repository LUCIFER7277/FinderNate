import mongoose from 'mongoose';
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import { User } from "../../models/user.models.js";
import Follower from "../../models/follower.models.js";
import { filterPostsByPrivacy, canViewPost } from "../../utils/postPrivacy.js";
import { enrichWithRatings } from "../../utils/reviewUtils.js";
import { addBadgesToNestedUsers } from "../../utils/userBadge.utils.js";
import { getLikedByPreview } from "../../utils/likedByPreview.utils.js";
import { batchIsLikedByUser, batchGetLikesCount, batchGetLikedByUsers, stitchEngagement } from "../../utils/postEngagement.utils.js";
import { hasActivePaymentPlan } from "../../utils/businessPlan.utils.js";
import { getFollowStatus } from '../../utils/followEngagement.utils.js';

export const getAllPosts = asyncHandler(async (req, res) => {
    const filter = { ...req.query };
    const currentUser = req.user;

    const posts = await Post.find(filter)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .sort({ createdAt: -1 });

    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    let visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);
    visiblePosts = await enrichWithRatings(visiblePosts, 'userId');
    const postsWithBadges = await addBadgesToNestedUsers(visiblePosts);

    return res.status(200).json(new ApiResponse(200, postsWithBadges, "Posts fetched successfully"));
});

export const getPostById = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const currentUser = req.user;

    const post = await Post.findById(postId)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .lean();

    if (!post) throw new ApiError(404, "Post not found");

    const postOwner = await User.findById(post.userId?._id || post.userId)
        .select('accountStatus isDeleted').lean();
    if (!postOwner || postOwner.isDeleted || postOwner.accountStatus !== 'active') {
        throw new ApiError(404, "Post not found");
    }

    const isFollowing = await getFollowStatus(currentUser?._id, post.userId?._id || post.userId);

    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    if (!canViewPost(post, post.userId, currentUser, viewerFollowing, viewerFollowers)) {
        throw new ApiError(403, "You don't have permission to view this post");
    }

    const postAuthorId = post.userId?._id || post.userId;
    const postAuthor = await User.findById(postAuthorId).select('isBusinessProfile').lean();
    const isViewingOwnPost = currentUser && currentUser._id.toString() === postAuthorId.toString();

    if (postAuthor?.isBusinessProfile && isViewingOwnPost) {
        const hasActivePlan = await hasActivePaymentPlan(postAuthorId);
        if (!hasActivePlan) {
            post.isHiddenFromFeed = true;
            post.visibilityMessage = "Hidden from home feed - Upgrade to show in feed";
            post.upgradeMessage = {
                title: "Upgrade Plan",
                message: "Your business posts are visible on your profile but hidden from the home feed. Upgrade to a paid plan for more reach.",
                ctaText: "Upgrade Now",
                ctaUrl: "/business/select-plan"
            };
        } else {
            post.isHiddenFromFeed = false;
        }
    }

    const [likedByMap, likedSet, likeCountMap] = await Promise.all([
        batchGetLikedByUsers([postId]),
        currentUser ? batchIsLikedByUser(currentUser._id, [postId]) : Promise.resolve(new Set()),
        batchGetLikesCount([post]),
    ]);

    const postIdStr = postId.toString();
    let likedByUsers = likedByMap.get(postIdStr) || [];
    const currentUserLiked = currentUser ? likedSet.has(postIdStr) : false;

    if (currentUserLiked) {
        const curIdStr = currentUser._id.toString();
        if (!likedByUsers.find(u => (u._id || u.userId)?.toString() === curIdStr)) {
            likedByUsers = [{
                _id: curIdStr,
                userId: curIdStr,
                username: currentUser.username,
                fullName: currentUser.fullName,
                profileImageUrl: currentUser.profileImageUrl,
                isVerified: currentUser.isVerified,
            }, ...likedByUsers];
        }
    }

    post.likedBy = likedByUsers;
    post.isLikedBy = currentUserLiked;
    post.engagement = {
        ...(post.engagement || {}),
        likes: likeCountMap.get(postIdStr) ?? post.engagement?.likes ?? 0,
    };

    if (currentUser) {
        const preview = getLikedByPreview(likedByUsers, currentUser._id.toString());
        post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
    }

    const [postWithBadge] = await addBadgesToNestedUsers([post]);

    return res.status(200).json(new ApiResponse(200, { ...postWithBadge, isFollowing }, "Post fetched successfully"));
});

export const getMyPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, "Unauthorized: User ID missing");

    const { postType, contentType } = req.query;
    let { page, limit } = req.query;

    page = parseInt(page) > 0 ? parseInt(page) : 1;
    limit = parseInt(limit) > 0 ? parseInt(limit) : 10;

    const filter = { userId };
    if (postType) filter.postType = postType;
    if (contentType) filter.contentType = contentType;

    const posts = await Post.find(filter)
        .populate('userId', 'username profileImageUrl fullName isVerified location bio')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);

    const total = await Post.countDocuments(filter);

    const postsWithThumbnails = posts.map(post => {
        const postObj = post.toObject();
        postObj.media = (postObj.media || []).map(media => {
            let thumbnailUrl = media.thumbnailUrl ?? null;
            if (
                media.type === "video" &&
                (!thumbnailUrl || thumbnailUrl === "null") &&
                typeof media.url === "string"
            ) {
                thumbnailUrl = media.url
                    .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                    .replace(/\.(mp4|mov|webm)$/i, '.jpg');
            }
            return { ...media, thumbnailUrl };
        });
        return postObj;
    });

    const currentUserId = req.user?._id?.toString();
    const [likedSet, likeCountMap, likedByUsersMap] = await Promise.all([
        currentUserId ? batchIsLikedByUser(req.user._id, postsWithThumbnails.map(p => p._id)) : Promise.resolve(new Set()),
        batchGetLikesCount(postsWithThumbnails),
        batchGetLikedByUsers(postsWithThumbnails.map(p => p._id)),
    ]);

    postsWithThumbnails.forEach(post => {
        const idStr = post._id.toString();
        post.isLikedBy = currentUserId ? likedSet.has(idStr) : false;
        post.likedBy = likedByUsersMap.get(idStr) || [];
        post.engagement = { ...(post.engagement || {}), likes: likeCountMap.get(idStr) ?? post.engagement?.likes ?? 0 };
    });

    postsWithThumbnails.forEach(post => {
        const preview = getLikedByPreview(post.likedBy || [], currentUserId);
        post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
    });

    const enrichedPosts = await enrichWithRatings(postsWithThumbnails, 'userId');
    const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

    let upgradeMessage = null;
    let hiddenPostsCount = 0;
    const { User } = await import('../../models/user.models.js');
    const currentUserData = await User.findById(userId).select('isBusinessProfile').lean();

    if (currentUserData?.isBusinessProfile) {
        const { hasActivePaymentPlan } = await import('../../utils/businessPlan.utils.js');
        const hasActivePlan = await hasActivePaymentPlan(userId);

        if (!hasActivePlan) {
            hiddenPostsCount = postsWithBadges.length;
            upgradeMessage = {
                title: "Upgrade Plan",
                message: "Your business posts are currently only visible to you. Upgrade to a paid plan.",
                ctaText: "Upgrade Now",
                ctaUrl: "/business/select-plan"
            };
            postsWithBadges.forEach(post => {
                post.isVisibleToOthers = false;
                post.visibilityMessage = "Only visible to you - Upgrade to show to others";
            });
        } else {
            postsWithBadges.forEach(post => {
                post.isVisibleToOthers = true;
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            totalPosts: total,
            page,
            totalPages: Math.ceil(total / limit),
            posts: postsWithBadges,
            upgradeMessage,
            hiddenPostsCount
        }, "User posts fetched successfully")
    );
});

export const getUserProfilePosts = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const {
        postType,
        contentType,
        page,
        limit,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;

    if (!userId) {
        throw new ApiError(400, "User ID is required");
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new ApiError(400, "Invalid User ID format");
    }

    const currentPage = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (currentPage - 1) * pageLimit;

    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDirection };

    const filter = {
        userId,
        status: { $in: ['published', 'scheduled'] }
    };

    if (postType) {
        const validPostTypes = ['photo', 'reel', 'video'];
        if (!validPostTypes.includes(postType.toLowerCase())) {
            throw new ApiError(400, "Invalid post type. Must be one of: photo, reel, video");
        }
        filter.postType = postType.toLowerCase();
    }

    if (contentType) {
        const validContentTypes = ['normal', 'business', 'product', 'service'];
        if (!validContentTypes.includes(contentType.toLowerCase())) {
            throw new ApiError(400, "Invalid content type. Must be one of: normal, business, product, service");
        }
        filter.contentType = contentType.toLowerCase();
    }

    try {
        const posts = await Post.find(filter)
            .populate('userId', 'username profileImageUrl fullName isVerified location bio privacy isFullPrivate')
            .populate('mentions', 'username fullName profileImageUrl')
            .sort(sortObj)
            .skip(skip)
            .limit(pageLimit)
            .lean();

        const currentUser = req.user;
        let viewerFollowing = [];
        let viewerFollowers = [];

        if (currentUser) {
            const followingRecords = await Follower.find({ followerId: currentUser._id });
            const followerRecords = await Follower.find({ userId: currentUser._id });

            viewerFollowing = followingRecords.map(f => f.userId.toString());
            viewerFollowers = followerRecords.map(f => f.followerId.toString());
        }

        const visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);

        const isViewingOwnProfile = currentUser && currentUser._id.toString() === userId.toString();

        let postsAfterBusinessFilter;
        let upgradeMessage = null;
        let hiddenPostsCount = 0;

        if (isViewingOwnProfile) {
            postsAfterBusinessFilter = visiblePosts;

            const { User } = await import('../../models/user.models.js');
            const profileUser = await User.findById(userId).select('isBusinessProfile').lean();

            if (profileUser?.isBusinessProfile) {
                const { hasActivePaymentPlan } = await import('../../utils/businessPlan.utils.js');
                const hasActivePlan = await hasActivePaymentPlan(userId);

                if (!hasActivePlan) {
                    hiddenPostsCount = visiblePosts.length;
                    upgradeMessage = {
                        title: "Upgrade Plan",
                        message: "Your business posts are visible on your profile but hidden from the home feed. Upgrade to a paid plan for more reach.",
                        ctaText: "Upgrade Now",
                        ctaUrl: "/business/select-plan"
                    };
                    postsAfterBusinessFilter.forEach(post => {
                        post.isHiddenFromFeed = true;
                        post.visibilityMessage = "Hidden from home feed - Upgrade to show in feed";
                    });
                } else {
                    postsAfterBusinessFilter.forEach(post => {
                        post.isHiddenFromFeed = false;
                    });
                }
            }
        } else {
            postsAfterBusinessFilter = visiblePosts;
        }

        const totalPosts = await Post.countDocuments(filter);
        const totalPages = Math.ceil(totalPosts / pageLimit);

        const currentUserId = req.user?._id?.toString();
        const [likedSet, likeCountMap, likedByUsersMap] = await Promise.all([
            currentUserId ? batchIsLikedByUser(req.user._id, postsAfterBusinessFilter.map(p => p._id)) : Promise.resolve(new Set()),
            batchGetLikesCount(postsAfterBusinessFilter),
            batchGetLikedByUsers(postsAfterBusinessFilter.map(p => p._id)),
        ]);

        postsAfterBusinessFilter.forEach(post => {
            const idStr = post._id.toString();
            post.isLikedBy = currentUserId ? likedSet.has(idStr) : false;
            post.likedBy = likedByUsersMap.get(idStr) || [];
            post.engagement = { ...(post.engagement || {}), likes: likeCountMap.get(idStr) ?? post.engagement?.likes ?? 0 };
        });

        if (currentUser) {
            postsAfterBusinessFilter.forEach(post => {
                const preview = getLikedByPreview(post.likedBy || [], currentUserId);
                post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
            });
        }

        const enrichedPosts = await enrichWithRatings(postsAfterBusinessFilter, 'userId');
        const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

        // description is NOT stripped.
        //
        // It used to be deleted from every post here, with no reason recorded.
        // For posts created in the app that is the only copy of the text — the
        // app writes the body into `description` and leaves `caption` for the
        // short line — so the profile grid showed those posts with nothing
        // written on them at all.

        return res.status(200).json(
            new ApiResponse(200, {
                posts: postsWithBadges,
                pagination: {
                    currentPage,
                    totalPages,
                    totalPosts,
                    hasNextPage: currentPage < totalPages,
                    hasPrevPage: currentPage > 1,
                    limit: pageLimit
                },
                filters: {
                    postType: postType || 'all',
                    contentType: contentType || 'all'
                },
                upgradeMessage,
                hiddenPostsCount,
                isViewingOwnProfile
            }, "User profile posts fetched successfully")
        );
    } catch (error) {
        console.error("Error fetching user profile posts:", error);
        throw new ApiError(500, "Failed to fetch user profile posts");
    }
});

export const getNearbyPosts = asyncHandler(async (req, res) => {
    const { latitude, longitude, distance = 1000 } = req.query;
    if (!latitude || !longitude) {
        throw new ApiError(400, "Latitude and longitude are required");
    }

    const posts = await Post.find({
        "customization.normal.location.coordinates": {
            $near: {
                $geometry: {
                    type: "Point",
                    coordinates: [parseFloat(longitude), parseFloat(latitude)]
                },
                $maxDistance: parseInt(distance)
            }
        }
    });

    return res.status(200).json(new ApiResponse(200, posts, "Nearby posts fetched successfully"));
});

export const getTrendingPosts = asyncHandler(async (req, res) => {
    const currentUser = req.user ?? null;

    const posts = await Post.find()
        .sort({ "engagement.likes": -1, "engagement.comments": -1, createdAt: -1 })
        .limit(20)
        .lean();

    if (!posts.length) {
        return res.status(200).json(new ApiResponse(200, posts, "Trending posts fetched successfully"));
    }

    const stitched = await stitchEngagement(currentUser?._id ?? null, posts);

    return res.status(200).json(new ApiResponse(200, stitched, "Trending posts fetched successfully"));
});
