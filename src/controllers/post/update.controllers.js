import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import { FeedCacheManager } from "../../utils/cache.utils.js";
import { redisClient } from "../../config/redis.config.js";

export const editPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    const {
        caption,
        description,
        mentions,
        tags,
        location,
        privacy,
        product,
        service,
        business
    } = req.body;

    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only edit your own posts");
    }

    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
    const parsedProduct = typeof product === "string" ? JSON.parse(product) : product;
    const parsedService = typeof service === "string" ? JSON.parse(service) : service;
    const parsedBusiness = typeof business === "string" ? JSON.parse(business) : business;

    let resolvedLocation = parsedLocation || post.customization?.normal?.location;
    if (parsedLocation && (parsedLocation.name || parsedLocation.address) && !parsedLocation.coordinates) {
        try {
            const coords = await getCoordinates(parsedLocation);
            if (coords?.latitude && coords?.longitude) {
                resolvedLocation.coordinates = {
                    type: "Point",
                    coordinates: [coords.longitude, coords.latitude]
                };
            }
        } catch (error) {
            console.error('Error resolving location coordinates during edit:', error.message);
        }
    }

    const updateData = { updatedAt: new Date() };

    if (caption !== undefined) updateData.caption = caption;
    if (description !== undefined) updateData.description = description;
    if (parsedMentions) updateData.mentions = parsedMentions;

    const customization = post.customization?.toObject?.() || { ...post.customization } || {};

    if (post.contentType === "normal") {
        customization.normal = {
            ...(customization.normal || {}),
            tags: parsedTags || customization.normal?.tags || [],
            location: resolvedLocation || customization.normal?.location
        };
    } else if (post.contentType === "product" && parsedProduct) {
        customization.product = { ...(customization.product || {}), ...parsedProduct };
        customization.normal = {
            ...(customization.normal || {}),
            tags: parsedTags || customization.normal?.tags || [],
            location: resolvedLocation || customization.normal?.location
        };
    } else if (post.contentType === "service" && parsedService) {
        customization.service = { ...(customization.service || {}), ...parsedService };
        customization.normal = {
            ...(customization.normal || {}),
            tags: parsedTags || customization.normal?.tags || [],
            location: resolvedLocation || customization.normal?.location
        };
    } else if (post.contentType === "business" && parsedBusiness) {
        customization.business = { ...(customization.business || {}), ...parsedBusiness };
        customization.normal = {
            ...(customization.normal || {}),
            tags: parsedTags || customization.normal?.tags || [],
            location: resolvedLocation || customization.normal?.location
        };
    }

    updateData.customization = customization;

    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy && privacy === 'public' && oldPrivacy === 'private';

    if (privacy && ['public', 'private'].includes(privacy)) {
        updateData["settings.privacy"] = privacy;
        updateData["settings.isPrivacyTouched"] = true;
    }

    const updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $set: updateData },
        { new: true, runValidators: true }
    ).populate('userId', 'username fullName profileImageUrl');

    await FeedCacheManager.invalidateUserFeed(userId);

    if (isPrivacyChangingToPublic) {
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();
    }

    return res.status(200).json(new ApiResponse(200, updatedPost, "Post updated successfully"));
});

export const togglePostPrivacy = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;
    const { privacy } = req.body;

    if (!userId) throw new ApiError(401, "User authentication required");

    if (!privacy || !['public', 'private'].includes(privacy)) {
        throw new ApiError(400, "Invalid privacy value. Must be 'public' or 'private'");
    }

    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only modify your own posts");
    }

    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy === 'public' && oldPrivacy === 'private';

    const updatedPost = await Post.findByIdAndUpdate(
        postId,
        {
            $set: {
                "settings.privacy": privacy,
                "settings.isPrivacyTouched": true,
                updatedAt: new Date()
            }
        },
        { new: true, runValidators: true }
    ).populate('userId', 'username fullName profileImageUrl');

    if (isPrivacyChangingToPublic) {
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();
        await FeedCacheManager.invalidateUserFeed(userId);
    }

    if (privacy === 'private') {
        await redisClient.del(`fn:share:post:${postId}`);
        await redisClient.del(`fn:share:reel:${postId}`);
        await redisClient.del(`fn:share:preview:${postId}`);
        await redisClient.del(`fn:share:preview:reel:${postId}`);
    }

    return res.status(200).json(new ApiResponse(200, {
        postId: updatedPost._id,
        privacy: updatedPost.settings.privacy,
        post: updatedPost
    }, `Post privacy updated to ${privacy}`));
});

export const updatePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    updates.updatedAt = new Date();

    const post = await Post.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!post) throw new ApiError(404, "Post not found");

    return res.status(200).json(new ApiResponse(200, post, "Post updated successfully"));
});

export const saveDraft = asyncHandler(async (req, res) => {
    const userId = req.user?._id || req.body.userId;
    const postData = req.body;

    const post = await Post.create({
        ...postData,
        userId,
        status: "draft"
    });

    return res.status(201).json(new ApiResponse(201, post, "Post saved as draft"));
});

export const schedulePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { scheduledAt } = req.body;
    if (!scheduledAt) throw new ApiError(400, "scheduledAt time is required");

    const post = await Post.findByIdAndUpdate(id, {
        status: "scheduled",
        scheduledAt
    }, { new: true });

    return res.status(200).json(new ApiResponse(200, post, "Post scheduled successfully"));
});
