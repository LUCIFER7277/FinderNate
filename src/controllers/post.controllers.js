import mongoose from 'mongoose';
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import Reel from "../models/reels.models.js";
import { uploadBufferToBunny, deleteMultipleFromBunny, deleteFromBunny, generateOptimizedImageUrl } from "../utlis/bunny.js";
import { getCoordinates } from "../utlis/getCoordinates.js";
import { validateDeliveryAndLocation } from "../utlis/deliveryValidation.js";
import { filterPostsByPrivacy, canViewPost } from "../utlis/postPrivacy.js";
import { User } from "../models/user.models.js";
import Follower from "../models/follower.models.js";
import Like from "../models/like.models.js";
import { CacheManager, FeedCacheManager } from "../utlis/cache.utils.js";
import { redisClient } from "../config/redis.config.js";
import Comment from "../models/comment.models.js";
import SavedPost from "../models/savedPost.models.js";
import { enrichWithRatings } from "../utlis/reviewUtils.js";
import { addBadgesToNestedUsers, addBadgesToUsers } from "../utlis/userBadge.utils.js";
import { getLikedByPreview } from "../utlis/likedByPreview.utils.js";
import { hasActivePaymentPlan } from "../utlis/businessPlan.utils.js";
import Business from "../models/business.models.js";

const extractMediaFiles = (files) => {
    const allFiles = [];
    ["image", "video", "reel", "story"].forEach((field) => {
        if (files?.[field]) {
            allFiles.push(...files[field]);
        }
    });
    return allFiles;
};

const parseField = (value) => {
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return value; }
    }
    return value;
};

const resolveLocationCoordinates = async (parsedLocation) => {
    let resolvedLocation = parsedLocation || {};
    if ((resolvedLocation.name || resolvedLocation.address) && !resolvedLocation.coordinates) {
        try {
            const coords = await getCoordinates(resolvedLocation);
            if (coords?.latitude && coords?.longitude) {
                resolvedLocation.coordinates = {
                    type: "Point",
                    coordinates: [coords.longitude, coords.latitude]
                };
            } else {
                console.warn(`Could not resolve coordinates for location: ${resolvedLocation.name || resolvedLocation.address || 'unknown'}. Post will be created without coordinates.`);
            }
        } catch (error) {
            console.error('Error resolving location coordinates:', error.message);
        }
    }
    return resolvedLocation;
};

const uploadPostMedia = async (files, customThumbnail) => {
    const uploadedMedia = [];
    for (const file of files) {
        try {
            const result = await uploadBufferToBunny(file.buffer, "posts");
            if (result.resource_type === "image") {
                const thumbnailUrl = generateOptimizedImageUrl(result.secure_url, { width: 300, height: 300, crop: 'fill' });
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: { width: result.width, height: result.height },
                });
            } else if (result.resource_type === "video") {
                let thumbnailUrl;
                if (customThumbnail) {
                    const thumbResult = await uploadBufferToBunny(customThumbnail.buffer, "posts");
                    thumbnailUrl = generateOptimizedImageUrl(thumbResult.secure_url, { width: 300, height: 300, crop: 'fill' });
                } else {
                    thumbnailUrl = `${result.secure_url}?thumbnail=1&width=300&height=300`;
                }
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: { width: result.width, height: result.height },
                });
            }
        } catch {
            throw new ApiError(500, "Bunny.net upload failed");
        }
    }
    return uploadedMedia;
};

export const createNormalPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, settings, scheduledAt, publishedAt, status } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId,
        postType,
        contentType: "normal",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    return res.status(201).json(new ApiResponse(201, post, "Normal post created successfully"));
});

export const createTweetPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { caption, description, mentions, location, tags, settings, scheduledAt, publishedAt, status } = req.body;
    if (!caption || !caption.trim()) {
        throw new ApiError(400, "Tweet text (caption) is required");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    // Media is optional for tweets
    const files = extractMediaFiles(req.files);
    const uploadedMedia = files.length ? await uploadPostMedia(files, req.files?.thumbnail?.[0]) : [];

    const post = await Post.create({
        userId,
        postType: "tweet",
        contentType: "normal",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            normal: { location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    return res.status(201).json(new ApiResponse(201, post, "Tweet post created successfully"));
});

export const createProductPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, product, settings, scheduledAt, publishedAt, status } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedProduct = parseField(product);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedProduct = await validateDeliveryAndLocation({ ...parsedProduct, location: parsedLocation }, "product");
    if (!validatedProduct?.link) throw new ApiError(400, "Product post must include a product link");

    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "product", caption, description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            product: validatedProduct,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: parsedSettings || {},
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    return res.status(201).json(new ApiResponse(201, post, "Product post created successfully"));
});

export const createServicePost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, service, settings, scheduledAt, publishedAt, status } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedService = parseField(service);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedService = await validateDeliveryAndLocation({ ...parsedService, location: parsedLocation }, "service");
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "service", caption, description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            service: validatedService,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: parsedSettings || {},
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    return res.status(201).json(new ApiResponse(201, post, "Service post created successfully"));
});

export const createBusinessPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, business, settings, scheduledAt, publishedAt, status } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedBusiness = parseField(business);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedBusiness = await validateDeliveryAndLocation({ ...parsedBusiness, location: parsedLocation }, "business");
    if (!validatedBusiness?.link) throw new ApiError(400, "Business post must include a business link");

    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "business", caption, description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            business: validatedBusiness,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: parsedSettings || {},
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    return res.status(201).json(new ApiResponse(201, post, "Business post created successfully"));
});


// Get all posts
export const getAllPosts = asyncHandler(async (req, res) => {
    const filter = { ...req.query };
    const currentUser = req.user;

    // Get all posts with user information
    const posts = await Post.find(filter)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .sort({ createdAt: -1 });

    // Get viewer's following/followers for privacy filtering
    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    // Filter posts based on privacy settings
    let visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);

    // Enrich posts with review/rating data
    visiblePosts = await enrichWithRatings(visiblePosts, 'userId');
    
    // Add subscription badges to post authors
    const postsWithBadges = await addBadgesToNestedUsers(visiblePosts);

    return res.status(200).json(new ApiResponse(200, postsWithBadges, "Posts fetched successfully"));
});

// Get post by ID
export const getPostById = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const currentUser = req.user;

    const post = await Post.findById(postId)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .lean();

    if (!post) throw new ApiError(404, "Post not found");

    // Block access if post author is banned or deleted
    const postOwner = await User.findById(post.userId?._id || post.userId)
        .select('accountStatus isDeleted').lean();
    if (!postOwner || postOwner.isDeleted || postOwner.accountStatus !== 'active') {
        throw new ApiError(404, "Post not found");
    }

    // Get viewer's following/followers for privacy check
    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    // Check if user can view this post
    if (!canViewPost(post, post.userId, currentUser, viewerFollowing, viewerFollowers)) {
        throw new ApiError(403, "You don't have permission to view this post");
    }

    // Check if post author is a business account with inactive payment
    // Business posts are hidden from ALL users (including followers) if payment is inactive
    // EXCEPT when viewing your own post
    const postAuthorId = post.userId?._id || post.userId;
    const postAuthor = await User.findById(postAuthorId).select('isBusinessProfile').lean();
    const isViewingOwnPost = currentUser && currentUser._id.toString() === postAuthorId.toString();

    // Business posts on free plan are visible on profile/direct view
    // They are only hidden from home feed, not from direct access

    // Add visibility indicator if viewing own post on free plan
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

    // Fetch likes for this post and populate user details
    const likes = await Like.find({ postId: postId }).lean();
    const likedByUserIds = likes.map(like => like.userId.toString());

    // Fetch user details for all users who liked the post
    let likedByUsers = [];
    if (likedByUserIds.length > 0) {
        likedByUsers = await Post.db.model('User').find(
            { _id: { $in: likedByUserIds } },
            'username fullName profileImageUrl isVerified'
        ).lean();
    }

    // Add likedBy array and isLikedBy flag to the post
    post.likedBy = likedByUsers;
    post.isLikedBy = currentUser ? likedByUserIds.includes(currentUser._id.toString()) : false;

    // Add "Liked by" preview
    if (currentUser) {
        const user = await User.findById(currentUser._id).select('following followers').lean();
        const userFollowing = user?.following || [];
        const userFollowers = user?.followers || [];

        const likedByPreview = getLikedByPreview(
            likedByUsers,
            currentUser._id.toString(),
            userFollowing,
            userFollowers
        );

        post.likedByPreview = likedByPreview.likedByText ? {
            text: likedByPreview.likedByText,
            previewUser: likedByPreview.previewUser,
            othersCount: likedByPreview.othersCount
        } : null;
    }

    // Add subscription badge to post author
    const [postWithBadge] = await addBadgesToNestedUsers([post]);

    return res.status(200).json(new ApiResponse(200, postWithBadge, "Post fetched successfully"));
});

// Edit post
export const createBatchPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    let posts;
    try {
        posts = typeof req.body.posts === "string" ? JSON.parse(req.body.posts) : req.body.posts;
    } catch {
        throw new ApiError(400, "Invalid posts data. Must be a valid JSON array.");
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        throw new ApiError(400, "posts must be a non-empty array");
    }
    if (posts.length > 6) {
        throw new ApiError(400, "Maximum 6 posts allowed per batch");
    }

    const validPostTypes = ["photo", "reel", "video", "story", "tweet"];
    const validContentTypes = ["normal", "product", "service", "business"];

    // Phase 1: Validate all posts before any uploads
    const parsedPosts = [];
    for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const contentType = p.contentType || "normal";
        const postType = p.postType;

        if (!postType || !validPostTypes.includes(postType)) {
            throw new ApiError(400, `Post ${i + 1}: postType must be one of '${validPostTypes.join("', '")}'`);
        }
        if (!validContentTypes.includes(contentType)) {
            throw new ApiError(400, `Post ${i + 1}: contentType must be one of '${validContentTypes.join("', '")}'`);
        }

        const parsedMentions = parseField(p.mentions);
        const parsedTags = parseField(p.tags);
        const parsedSettings = parseField(p.settings);
        const parsedLocation = parseField(p.location);

        // Extract files for this post index
        const images = req.files?.[`post_${i}_image`] || [];
        const videos = req.files?.[`post_${i}_video`] || [];
        const thumbnail = req.files?.[`post_${i}_thumbnail`]?.[0] || null;
        const files = [...images, ...videos];

        // Media required for non-tweet posts
        if (postType !== "tweet" && !files.length) {
            throw new ApiError(400, `Post ${i + 1}: Media file is required for ${postType} posts`);
        }
        if (postType === "tweet" && (!p.caption || !p.caption.trim())) {
            throw new ApiError(400, `Post ${i + 1}: Tweet text (caption) is required`);
        }

        // Validate content-type-specific fields
        let validatedDetails = null;
        if (contentType === "product") {
            const parsedProduct = parseField(p.product);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedProduct, location: parsedLocation }, "product");
            if (!validatedDetails?.link) {
                throw new ApiError(400, `Post ${i + 1}: Product post must include a product link`);
            }
        } else if (contentType === "service") {
            const parsedService = parseField(p.service);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedService, location: parsedLocation }, "service");
        } else if (contentType === "business") {
            const parsedBusiness = parseField(p.business);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedBusiness, location: parsedLocation }, "business");
            if (!validatedDetails?.link) {
                throw new ApiError(400, `Post ${i + 1}: Business post must include a business link`);
            }
        }

        parsedPosts.push({
            postType, contentType,
            caption: p.caption, description: p.description,
            mood: p.mood, activity: p.activity,
            parsedMentions, parsedTags, parsedSettings, parsedLocation,
            validatedDetails, files, thumbnail,
            scheduledAt: p.scheduledAt, publishedAt: p.publishedAt, status: p.status,
        });
    }

    // Phase 2: Upload media for all posts + resolve locations
    const allUploadedUrls = [];
    const postMediaAndLocations = [];

    try {
        for (let i = 0; i < parsedPosts.length; i++) {
            const p = parsedPosts[i];
            const uploadedMedia = p.files.length ? await uploadPostMedia(p.files, p.thumbnail) : [];
            allUploadedUrls.push(...uploadedMedia.map(m => m.url));
            const resolvedLocation = await resolveLocationCoordinates(p.parsedLocation);
            postMediaAndLocations.push({ uploadedMedia, resolvedLocation });
        }
    } catch (error) {
        // Cleanup already-uploaded media on failure
        if (allUploadedUrls.length > 0) {
            await deleteMultipleFromBunny(allUploadedUrls).catch(err => console.error("Cleanup failed:", err));
        }
        throw error;
    }

    // Phase 3: Create all posts in a transaction
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const createdPosts = [];
        for (let i = 0; i < parsedPosts.length; i++) {
            const p = parsedPosts[i];
            const { uploadedMedia, resolvedLocation } = postMediaAndLocations[i];

            const customization = {
                normal: { mood: p.mood, activity: p.activity, location: resolvedLocation, tags: p.parsedTags || [] },
            };
            if (p.contentType === "product") customization.product = p.validatedDetails;
            if (p.contentType === "service") customization.service = p.validatedDetails;
            if (p.contentType === "business") customization.business = p.validatedDetails;

            const postSettings = p.contentType === "normal" ? {
                ...p.parsedSettings,
                privacy: p.parsedSettings?.privacy || req.user?.privacy || 'public',
                isPrivacyTouched: p.parsedSettings?.privacy ? true : false
            } : (p.parsedSettings || {});

            const [created] = await Post.create([{
                userId,
                postType: p.postType,
                contentType: p.contentType,
                caption: p.caption,
                description: p.description,
                mentions: p.parsedMentions || [],
                media: uploadedMedia,
                customization,
                settings: postSettings,
                scheduledAt: p.scheduledAt,
                publishedAt: p.publishedAt,
                status: p.status || (p.scheduledAt ? "scheduled" : "published"),
                isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
                engagement: {}, analytics: {},
            }], { session });

            createdPosts.push(created);
        }

        // Push all post IDs to user's posts array in one operation
        await Post.db.model('User').findByIdAndUpdate(
            userId,
            { $push: { posts: { $each: createdPosts.map(p => p._id) } } },
            { session }
        );

        await session.commitTransaction();

        return res.status(201).json(
            new ApiResponse(201, { posts: createdPosts, count: createdPosts.length }, `${createdPosts.length} posts created successfully`)
        );
    } catch (error) {
        await session.abortTransaction();
        // Cleanup uploaded media from Bunny CDN
        if (allUploadedUrls.length > 0) {
            await deleteMultipleFromBunny(allUploadedUrls).catch(err => console.error("Cleanup failed:", err));
        }
        throw error;
    } finally {
        session.endSession();
    }
});

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

    // Find the post first to check ownership
    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    // Check if user owns the post
    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only edit your own posts");
    }

    // Parse JSON fields if they're strings
    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
    const parsedProduct = typeof product === "string" ? JSON.parse(product) : product;
    const parsedService = typeof service === "string" ? JSON.parse(service) : service;
    const parsedBusiness = typeof business === "string" ? JSON.parse(business) : business;

    // Handle location coordinates if needed
    let resolvedLocation = parsedLocation || post.customization?.normal?.location;
    if (parsedLocation && (parsedLocation.name || parsedLocation.address) && !parsedLocation.coordinates) {
        try {
            // Pass the full location object to allow multiple fallback strategies
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

    // Prepare update object
    const updateData = {
        updatedAt: new Date()
    };

    // Update basic fields
    if (caption !== undefined) updateData.caption = caption;
    if (description !== undefined) updateData.description = description;
    if (parsedMentions) updateData.mentions = parsedMentions;

    // Update customization based on content type
    // Convert Mongoose subdocument to plain object to avoid serialization issues with $set
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

    // Track if privacy is changing from private to public
    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy && privacy === 'public' && oldPrivacy === 'private';

    // Update privacy if provided
    if (privacy && ['public', 'private'].includes(privacy)) {
        updateData["settings.privacy"] = privacy;
        updateData["settings.isPrivacyTouched"] = true;
    }

    // Update the post
    const updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $set: updateData },
        { new: true, runValidators: true }
    ).populate('userId', 'username fullName profileImageUrl');

    // Invalidate caches so edited data is visible immediately on refresh
    // Always invalidate author's feed cache on any edit
    await FeedCacheManager.invalidateUserFeed(userId);

    if (isPrivacyChangingToPublic) {
        // Invalidate explore and trending feeds so the post can appear
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();
    }

    return res.status(200).json(new ApiResponse(200, updatedPost, "Post updated successfully"));
});

// Toggle post privacy
export const togglePostPrivacy = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;
    const { privacy } = req.body;

    if (!userId) throw new ApiError(401, "User authentication required");

    // Validate privacy value
    if (!privacy || !['public', 'private'].includes(privacy)) {
        throw new ApiError(400, "Invalid privacy value. Must be 'public' or 'private'");
    }

    // Find the post first to check ownership
    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    // Check if user owns the post
    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only modify your own posts");
    }

    // Track if privacy is changing from private to public
    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy === 'public' && oldPrivacy === 'private';

    // Update only the privacy settings
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

    // Invalidate caches if post privacy changed from private to public
    if (isPrivacyChangingToPublic) {
        // Invalidate explore and trending feeds so the post can appear
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();

        // Invalidate author's feed
        await FeedCacheManager.invalidateUserFeed(userId);
    }

    // Invalidate share caches when privacy changes to private
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

// Update post
export const updatePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    updates.updatedAt = new Date();

    const post = await Post.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!post) throw new ApiError(404, "Post not found");

    return res.status(200).json(new ApiResponse(200, post, "Post updated successfully"));
});

// Delete post
export const deletePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    // Find the post first to check ownership and get media URLs
    const post = await Post.findById(id);
    if (!post) throw new ApiError(404, "Post not found");

    // Check if user owns the post
    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own posts");
    }

    let bunnyDeletionResult = {
        totalDeleted: 0,
        errors: []
    };

    // Extract all media URLs from the post
    const mediaUrls = [];
    if (post.media && post.media.length > 0) {
        post.media.forEach(media => {
            if (media.url) mediaUrls.push(media.url);
            if (media.thumbnailUrl) mediaUrls.push(media.thumbnailUrl);
            // Handle additional media
            if (media.additionalMedia && media.additionalMedia.length > 0) {
                media.additionalMedia.forEach(additionalMedia => {
                    if (additionalMedia.url) mediaUrls.push(additionalMedia.url);
                    if (additionalMedia.thumbnailUrl) mediaUrls.push(additionalMedia.thumbnailUrl);
                });
            }
        });
    }

    // Delete media files from Bunny.net if any exist
    if (mediaUrls.length > 0) {
        try {
            bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
        } catch (error) {
            // Continue with database deletion even if Bunny.net deletion fails
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({
                error: `Bunny.net deletion failed: ${error.message}`
            });
        }
    }

    // Delete the post from database
    await Post.findByIdAndDelete(id);

    // Remove post ID from user's posts array
    await Post.db.model('User').findByIdAndUpdate(
        userId,
        { $pull: { posts: id } }
    );

    // Delete related data (likes, comments, saved posts)
    await Promise.allSettled([
        Like.deleteMany({ postId: id }),
        // Comment.deleteMany({ postId: id }), // Uncomment when Comment model is available
        // SavedPost.deleteMany({ postId: id }) // Uncomment when SavedPost model is available
    ]);

    const responseData = {
        postId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: bunnyDeletionResult.totalSkipped || 0,
            totalMediaFiles: mediaUrls.length,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Post deleted successfully, but some media files could not be removed from cloud storage"
                : "Post and all associated media deleted successfully"
        )
    );
});

// Delete story
export const deleteStory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    // Find the story first to check ownership and get media URL
    const story = await Story.findById(id);
    if (!story) throw new ApiError(404, "Story not found");

    // Check if user owns the story
    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own stories");
    }

    let bunnyDeletionResult = {
        totalDeleted: 0,
        errors: []
    };

    // Delete media from Bunny.net if exists
    if (story.mediaUrl) {
        try {
            await deleteFromBunny(story.mediaUrl);
            bunnyDeletionResult.totalDeleted = 1;
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({
                error: `Bunny.net deletion failed: ${error.message}`
            });
        }
    }

    // Delete the story from database
    await Story.findByIdAndDelete(id);

    const responseData = {
        storyId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: 0,
            totalMediaFiles: story.mediaUrl ? 1 : 0,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Story deleted successfully, but media file could not be removed from cloud storage"
                : "Story and associated media deleted successfully"
        )
    );
});

// Delete reel
export const deleteReel = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    // Find the reel first to check ownership and get media URLs
    const reel = await Reel.findById(id);
    if (!reel) throw new ApiError(404, "Reel not found");

    // Check if user owns the reel
    if (reel.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own reels");
    }

    let bunnyDeletionResult = {
        totalDeleted: 0,
        errors: []
    };

    // Extract media URLs for deletion
    const mediaUrls = [];
    if (reel.videoUrl) mediaUrls.push(reel.videoUrl);
    if (reel.thumbnailUrl) mediaUrls.push(reel.thumbnailUrl);

    // Delete media files from Bunny.net if any exist
    if (mediaUrls.length > 0) {
        try {
            const deletionResult = await deleteMultipleFromBunny(mediaUrls);
            bunnyDeletionResult = deletionResult;
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({
                error: `Bunny.net deletion failed: ${error.message}`
            });
        }
    }

    // Delete the reel from database
    await Reel.findByIdAndDelete(id);

    // Delete related data (likes, comments)
    await Promise.allSettled([
        // Remove reel from likes if using the Like model for reels
        Like.deleteMany({ postId: id }),
        // Comment.deleteMany({ reelId: id }), // Uncomment when Comment model supports reels
    ]);

    const responseData = {
        reelId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: bunnyDeletionResult.totalSkipped || 0,
            totalMediaFiles: mediaUrls.length,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Reel deleted successfully, but some media files could not be removed from cloud storage"
                : "Reel and all associated media deleted successfully"
        )
    );
});

/**
 * Helper function to invalidate all caches when content is deleted
 * Ensures deleted posts/reels/stories are removed from all feeds immediately
 */
const invalidatePostCaches = async (postId, userId) => {
    try {
        // 1. Invalidate all user feeds (home feed, explore, trending)
        const pattern1 = 'fn:user:*:feed:*';
        const pattern2 = 'fn:posts:trending:*';
        const pattern3 = 'fn:explore:feed:*';
        const pattern4 = 'fn:reels:*';

        await Promise.allSettled([
            CacheManager.delPattern(pattern1),
            CacheManager.delPattern(pattern2),
            CacheManager.delPattern(pattern3),
            CacheManager.delPattern(pattern4)
        ]);

        // 2. Invalidate Redis cache for reels section
        // This ensures the reel is removed from the getSuggestedReels cache
        try {
            const reelKeys = await redisClient.keys('fn:reels:*');
            if (reelKeys.length > 0) {
                await redisClient.del(...reelKeys);
            }
        } catch (err) {
            console.error('Redis reel cache clear error:', err);
        }

        // 3. Invalidate share caches for deleted content
        await redisClient.del(`fn:share:post:${postId}`);
        await redisClient.del(`fn:share:reel:${postId}`);
        await redisClient.del(`fn:share:preview:${postId}`);
        await redisClient.del(`fn:share:preview:reel:${postId}`);

        console.log(`✅ Cache invalidated for deleted content: ${postId}`);
    } catch (error) {
        console.error('Cache invalidation error:', error);
        // Don't throw - cache invalidation failure shouldn't block deletion
    }
};

// Common delete function - handles posts, stories, and reels using postId
export const deleteContent = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    let content = null;
    let contentType = null;
    let mediaUrls = [];
    let bunnyDeletionResult = {
        totalDeleted: 0,
        totalSkipped: 0,
        errors: []
    };

    try {
        // 1. Try to find in Post collection first
        content = await Post.findById(postId);
        if (content) {
            contentType = 'post';

            // Check ownership
            if (content.userId.toString() !== userId.toString()) {
                throw new ApiError(403, "You can only delete your own posts");
            }

            // Extract media URLs from post
            if (content.media && content.media.length > 0) {
                content.media.forEach(media => {
                    if (media.url) mediaUrls.push(media.url);
                    if (media.thumbnailUrl) mediaUrls.push(media.thumbnailUrl);
                    if (media.additionalMedia && media.additionalMedia.length > 0) {
                        media.additionalMedia.forEach(additionalMedia => {
                            if (additionalMedia.url) mediaUrls.push(additionalMedia.url);
                            if (additionalMedia.thumbnailUrl) mediaUrls.push(additionalMedia.thumbnailUrl);
                        });
                    }
                });
            }

            // Delete media from Bunny.net
            if (mediaUrls.length > 0) {
                try {
                    bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
                } catch (error) {
                    console.error("Bunny.net deletion error:", error);
                    bunnyDeletionResult.errors.push({
                        error: `Bunny.net deletion failed: ${error.message}`
                    });
                }
            }

            // Delete post from database
            await Post.findByIdAndDelete(postId);

            // Remove post ID from user's posts array
            await Post.db.model('User').findByIdAndUpdate(
                userId,
                { $pull: { posts: postId } }
            );

            // Delete related data (likes, comments, saved posts, post interactions)
            await Promise.allSettled([
                Like.deleteMany({ postId: postId }),
                Comment.deleteMany({ postId: postId }),
                SavedPost.deleteMany({ postId: postId })
            ]);

            // ✅ Invalidate all caches to remove post from everywhere
            await invalidatePostCaches(postId, userId);
        }

        // 2. If not found in Post, try Story collection
        if (!content) {
            content = await Story.findById(postId);
            if (content) {
                contentType = 'story';

                // Check ownership
                if (content.userId.toString() !== userId.toString()) {
                    throw new ApiError(403, "You can only delete your own stories");
                }

                // Extract media URL from story
                if (content.mediaUrl) {
                    mediaUrls.push(content.mediaUrl);
                }

                // Delete media from Bunny.net
                if (mediaUrls.length > 0) {
                    try {
                        const result = await deleteFromBunny(content.mediaUrl);
                        bunnyDeletionResult.totalDeleted = 1;
                    } catch (error) {
                        console.error("Bunny.net deletion error:", error);
                        bunnyDeletionResult.errors.push({
                            error: `Bunny.net deletion failed: ${error.message}`
                        });
                    }
                }

                // Delete story from database
                await Story.findByIdAndDelete(postId);

                // ✅ Invalidate all caches to remove story from everywhere
                await invalidatePostCaches(postId, userId);
            }
        }

        // 3. If not found in Post or Story, try Reel collection
        if (!content) {
            content = await Reel.findById(postId);
            if (content) {
                contentType = 'reel';

                // Check ownership
                if (content.userId.toString() !== userId.toString()) {
                    throw new ApiError(403, "You can only delete your own reels");
                }

                // Extract media URLs from reel
                if (content.videoUrl) mediaUrls.push(content.videoUrl);
                if (content.thumbnailUrl) mediaUrls.push(content.thumbnailUrl);

                // Delete media from Bunny.net
                if (mediaUrls.length > 0) {
                    try {
                        bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
                    } catch (error) {
                        console.error("Bunny.net deletion error:", error);
                        bunnyDeletionResult.errors.push({
                            error: `Bunny.net deletion failed: ${error.message}`
                        });
                    }
                }

                // Delete reel from database
                await Reel.findByIdAndDelete(postId);

                // Delete related data
                await Promise.allSettled([
                    Like.deleteMany({ postId: postId }),
                    Comment.deleteMany({ postId: postId }),
                    SavedPost.deleteMany({ postId: postId })
                ]);

                // ✅ Invalidate all caches to remove reel from everywhere
                await invalidatePostCaches(postId, userId);
            }
        }

        // 4. If content not found in any collection
        if (!content) {
            throw new ApiError(404, "Content not found. The post, story, or reel may have already been deleted.");
        }

        // 5. Prepare response data
        const responseData = {
            postId: postId,
            contentType: contentType,
            mediaCleanup: {
                filesDeleted: bunnyDeletionResult.totalDeleted,
                filesSkipped: bunnyDeletionResult.totalSkipped || 0,
                totalMediaFiles: mediaUrls.length,
                errors: bunnyDeletionResult.errors
            }
        };

        return res.status(200).json(
            new ApiResponse(
                200,
                responseData,
                bunnyDeletionResult.errors.length > 0
                    ? `${contentType.charAt(0).toUpperCase() + contentType.slice(1)} deleted successfully, but some media files could not be removed from cloud storage`
                    : `${contentType.charAt(0).toUpperCase() + contentType.slice(1)} and all associated media deleted successfully`
            )
        );

    } catch (error) {
        // If it's already an ApiError, re-throw it
        if (error instanceof ApiError) {
            throw error;
        }
        // Otherwise, wrap it in a generic error
        throw new ApiError(500, `Error deleting content: ${error.message}`);
    }
});

// Get nearby posts using 2dsphere index
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

// Get trending posts (basic version using likes + comments)
export const getTrendingPosts = asyncHandler(async (req, res) => {
    const posts = await Post.find()
        .sort({
            "engagement.likes": -1,
            "engagement.comments": -1,
            createdAt: -1
        })
        .limit(20);

    return res.status(200).json(new ApiResponse(200, posts, "Trending posts fetched successfully"));
});

// Save post as draft
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

// Schedule post for future
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

export const getMyPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, "Unauthorized: User ID missing");

    const { postType, contentType } = req.query;
    let { page, limit } = req.query;

    page = parseInt(page) > 0 ? parseInt(page) : 1;
    limit = parseInt(limit) > 0 ? parseInt(limit) : 10;

    const filter = { userId };

    if (postType) {
        filter.postType = postType;
    }

    if (contentType) {
        filter.contentType = contentType;
    }

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
            return {
                ...media,
                thumbnailUrl
            };
        });
        return postObj;
    });

    // Enhancement: Add isLikedBy and likedBy fields (like getUserProfilePosts)
    const currentUserId = req.user?._id?.toString();
    const postIds = postsWithThumbnails.map(post => post._id.toString());
    const likes = await Like.find({ postId: { $in: postIds } }).lean();
    // Map postId to array of userIds who liked it
    const likesByPost = {};
    likes.forEach(like => {
        const pid = like.postId.toString();
        if (!likesByPost[pid]) likesByPost[pid] = [];
        likesByPost[pid].push(like.userId.toString());
    });
    // Fetch user details for all liked users
    const allLikedUserIds = Array.from(new Set(likes.flatMap(like => like.userId.toString())));
    let likedUsersMap = {};
    if (allLikedUserIds.length > 0) {
        const likedUsers = await Post.db.model('User').find(
            { _id: { $in: allLikedUserIds } },
            'username profileImageUrl fullName isVerified'
        ).lean();
        likedUsersMap = likedUsers.reduce((acc, user) => {
            acc[user._id.toString()] = user;
            return acc;
        }, {});
    }
    postsWithThumbnails.forEach(post => {
        const pid = post._id.toString();
        const likedByIds = likesByPost[pid] || [];
        post.likedBy = likedByIds.map(uid => likedUsersMap[uid]).filter(Boolean); // array of user details
        post.isLikedBy = currentUserId ? likedByIds.includes(currentUserId) : false;
    });

    // Add "Liked by" preview to each post
    const currentUserFollowData = await User.findById(userId).select('following followers').lean();
    const userFollowing = currentUserFollowData?.following || [];
    const userFollowers = currentUserFollowData?.followers || [];

    postsWithThumbnails.forEach(post => {
        const likedByUsers = post.likedBy || [];
        const likedByPreview = getLikedByPreview(
            likedByUsers,
            currentUserId,
            userFollowing,
            userFollowers
        );

        post.likedByPreview = likedByPreview.likedByText ? {
            text: likedByPreview.likedByText,
            previewUser: likedByPreview.previewUser,
            othersCount: likedByPreview.othersCount
        } : null;
    });

    // Enrich posts with review/rating data
    const enrichedPosts = await enrichWithRatings(postsWithThumbnails, 'userId');

    // Add subscription badges to post authors
    const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

    // Check if user is a business account and add visibility indicators
    let upgradeMessage = null;
    let hiddenPostsCount = 0;
    const { User } = await import('../models/user.models.js');
    const currentUserData = await User.findById(userId).select('isBusinessProfile').lean();

    if (currentUserData?.isBusinessProfile) {
        const { hasActivePaymentPlan } = await import('../utlis/businessPlan.utils.js');
        const hasActivePlan = await hasActivePaymentPlan(userId);

        if (!hasActivePlan) {
            // User has free plan - add visibility indicators to all posts
            hiddenPostsCount = postsWithBadges.length;
            upgradeMessage = {
                title: "Upgrade Plan",
                message: "Your business posts are currently only visible to you. Upgrade to a paid plan.",
                ctaText: "Upgrade Now",
                ctaUrl: "/business/select-plan"
            };

            // Mark all posts as hidden from others
            postsWithBadges.forEach(post => {
                post.isVisibleToOthers = false;
                post.visibilityMessage = "Only visible to you - Upgrade to show to others";
            });
        } else {
            // User has active plan - all posts are visible
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
            upgradeMessage: upgradeMessage,
            hiddenPostsCount: hiddenPostsCount
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

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new ApiError(400, "Invalid User ID format");
    }

    // Parse pagination values or use defaults
    const currentPage = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (currentPage - 1) * pageLimit;

    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDirection };

    // Build filter object
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

        // Get viewer's following/followers for privacy filtering
        const currentUser = req.user;
        let viewerFollowing = [];
        let viewerFollowers = [];

        if (currentUser) {
            const followingRecords = await Follower.find({ followerId: currentUser._id });
            const followerRecords = await Follower.find({ userId: currentUser._id });

            viewerFollowing = followingRecords.map(f => f.userId.toString());
            viewerFollowers = followerRecords.map(f => f.followerId.toString());
        }

        // Filter posts based on privacy settings
        const visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);

        // Check if viewer is viewing their own profile
        const isViewingOwnProfile = currentUser && currentUser._id.toString() === userId.toString();

        let postsAfterBusinessFilter;
        let upgradeMessage = null;
        let hiddenPostsCount = 0;

        if (isViewingOwnProfile) {
            // User is viewing their own profile - show all posts but add visibility indicators
            postsAfterBusinessFilter = visiblePosts;

            // Check if user is a business account with free plan
            const { User } = await import('../models/user.models.js');
            const profileUser = await User.findById(userId).select('isBusinessProfile').lean();

            if (profileUser?.isBusinessProfile) {
                const { hasActivePaymentPlan } = await import('../utlis/businessPlan.utils.js');
                const hasActivePlan = await hasActivePaymentPlan(userId);

                if (!hasActivePlan) {
                    // User has free plan - posts visible on profile but hidden from home feed
                    hiddenPostsCount = visiblePosts.length;
                    upgradeMessage = {
                        title: "Upgrade Plan",
                        message: "Your business posts are visible on your profile but hidden from the home feed. Upgrade to a paid plan for more reach.",
                        ctaText: "Upgrade Now",
                        ctaUrl: "/business/select-plan"
                    };

                    // Mark all posts as hidden from feed
                    postsAfterBusinessFilter.forEach(post => {
                        post.isHiddenFromFeed = true;
                        post.visibilityMessage = "Hidden from home feed - Upgrade to show in feed";
                    });
                } else {
                    // User has active plan - all posts are visible everywhere
                    postsAfterBusinessFilter.forEach(post => {
                        post.isHiddenFromFeed = false;
                    });
                }
            }
        } else {
            // Viewing someone else's profile - show all posts (including free plan business posts)
            // Business posts are only hidden from home feed, not from profile
            postsAfterBusinessFilter = visiblePosts;
        }

        const totalPosts = await Post.countDocuments(filter);
        const totalPages = Math.ceil(totalPosts / pageLimit);
        const visiblePostsCount = postsAfterBusinessFilter.length;

        // Enhancement: Add isLikedBy and likedBy fields
        const currentUserId = req.user?._id?.toString();
        const postIds = postsAfterBusinessFilter.map(post => post._id);
        // Fetch all likes for these posts
        const likes = await Like.find({ postId: { $in: postIds } }).lean();
        // Map postId to array of userIds who liked it
        const likesByPost = {};
        likes.forEach(like => {
            const pid = like.postId.toString();
            if (!likesByPost[pid]) likesByPost[pid] = [];
            likesByPost[pid].push(like.userId.toString());
        });
        // Add isLikedBy and likedBy to each post
        // Instead of just userIds, fetch user details for likedBy
        const allLikedUserIds = Array.from(new Set(likes.flatMap(like => like.userId.toString())));
        let likedUsersMap = {};
        if (allLikedUserIds.length > 0) {
            const likedUsers = await Post.db.model('User').find(
                { _id: { $in: allLikedUserIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
            likedUsersMap = likedUsers.reduce((acc, user) => {
                acc[user._id.toString()] = user;
                return acc;
            }, {});
        }
        postsAfterBusinessFilter.forEach(post => {
            const pid = post._id.toString();
            const likedByIds = likesByPost[pid] || [];
            post.likedBy = likedByIds.map(uid => likedUsersMap[uid]).filter(Boolean); // array of user details
            post.isLikedBy = currentUserId ? likedByIds.includes(currentUserId) : false;
        });

        // Add "Liked by" preview to each post
        if (currentUser) {
            const currentUserData = await User.findById(currentUser._id).select('following followers').lean();
            const userFollowing = currentUserData?.following || [];
            const userFollowers = currentUserData?.followers || [];

            postsAfterBusinessFilter.forEach(post => {
                const likedByUsers = post.likedBy || [];
                const likedByPreview = getLikedByPreview(
                    likedByUsers,
                    currentUserId,
                    userFollowing,
                    userFollowers
                );

                post.likedByPreview = likedByPreview.likedByText ? {
                    text: likedByPreview.likedByText,
                    previewUser: likedByPreview.previewUser,
                    othersCount: likedByPreview.othersCount
                } : null;
            });
        }

        // Enrich posts with review/rating data
        const enrichedPosts = await enrichWithRatings(postsAfterBusinessFilter, 'userId');
        
        // Add subscription badges to post authors
        const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

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
                upgradeMessage: upgradeMessage,
                hiddenPostsCount: hiddenPostsCount,
                isViewingOwnProfile: isViewingOwnProfile
            }, "User profile posts fetched successfully")
        );
    } catch (error) {
        console.error("Error fetching user profile posts:", error);
        throw new ApiError(500, "Failed to fetch user profile posts");
    }
});
