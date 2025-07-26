import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import { uploadBufferToCloudinary } from "../utlis/cloudinary.js";
import { getCoordinates } from "../utlis/getCoordinates.js";
import Like from "../models/like.models.js";
import Comment from "../models/comment.models.js";

const extractMediaFiles = (files) => {
    const allFiles = [];
    ["image", "video", "reel", "story"].forEach((field) => {
        if (files?.[field]) {
            allFiles.push(...files[field]);
        }
    });
    return allFiles;
};


export const createNormalPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const {
        postType,
        caption,
        description,
        mentions,
        mood,
        activity,
        location,
        tags,
        settings,
        scheduledAt,
        publishedAt,
        status,
    } = req.body;
    if (!postType || !["photo", "reel", "video", "story"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', or 'story'");
    }


    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedSettings = typeof settings === "string" ? JSON.parse(settings) : settings;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

    let resolvedLocation = parsedLocation || {};
    if (resolvedLocation.name && !resolvedLocation.coordinates) {
        const coords = await getCoordinates(resolvedLocation.name);
        if (coords?.latitude && coords?.longitude) {
            resolvedLocation.coordinates = {
                type: "Point",
                coordinates: [coords.longitude, coords.latitude]
            };
        } else {
            throw new ApiError(400, `Could not resolve coordinates for location: ${resolvedLocation.name}`);
        }
    }

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    let uploadedMedia = [];

    for (const file of files) {
        try {
            const result = await uploadBufferToCloudinary(file.buffer, "posts");
            if (result.resource_type === "image") {
                const thumbnailUrl = result.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            } else if (result.resource_type === "video") {
                let thumbnailUrl;
                const customThumbnail = req.files?.thumbnail?.[0];
                if (customThumbnail) {
                    const thumbResult = await uploadBufferToCloudinary(customThumbnail.buffer, "posts");
                    thumbnailUrl = thumbResult.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                } else {
                    // Generate Cloudinary thumbnail from video URL (first frame, 300x300 crop)
                    thumbnailUrl = result.secure_url
                        .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                        .replace(/\.(mp4|mov|webm)$/i, '.jpg');
                }
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            }
        } catch {
            throw new ApiError(500, "Cloudinary upload failed");
        }
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "normal",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            normal: {
                mood,
                activity,
                location: resolvedLocation,
                tags: parsedTags || [],
            },
        },
        settings: parsedSettings || {},
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false,
        isFeatured: false,
        isReported: false,
        reportCount: 0,
        engagement: {},
        analytics: {},
    });

    return res.status(201).json(new ApiResponse(201, post, "Normal post created successfully"));
});

export const createProductPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const {
        postType,
        caption,
        description,
        mentions,
        mood,
        activity,
        location,
        tags,
        product,
        settings,
        scheduledAt,
        publishedAt,
        status,
    } = req.body;
    if (!postType || !["photo", "reel", "video", "story"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', or 'story'");
    }

    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedProduct = typeof product === "string" ? JSON.parse(product) : product;
    const parsedSettings = typeof settings === "string" ? JSON.parse(settings) : settings;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

    let resolvedLocation = parsedLocation || {};
    if (resolvedLocation.name && !resolvedLocation.coordinates) {
        const coords = await getCoordinates(resolvedLocation.name);
        if (coords?.latitude && coords?.longitude) {
            resolvedLocation.coordinates = {
                type: "Point",
                coordinates: [coords.longitude, coords.latitude]
            };
        } else {
            throw new ApiError(400, `Could not resolve coordinates for location: ${resolvedLocation.name}`);
        }
    }

    const files = extractMediaFiles(req.files);

    if (!files.length) throw new ApiError(400, "Media file is required");

    let uploadedMedia = [];
    for (const file of files) {
        try {

            const result = await uploadBufferToCloudinary(file.buffer, "posts");
            if (result.resource_type === "image") {
                const thumbnailUrl = result.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            } else if (result.resource_type === "video") {
                let thumbnailUrl;
                const customThumbnail = req.files?.thumbnail?.[0];
                if (customThumbnail) {
                    const thumbResult = await uploadBufferToCloudinary(customThumbnail.buffer, "posts");
                    thumbnailUrl = thumbResult.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                } else {
                    // Generate Cloudinary thumbnail from video URL (first frame, 300x300 crop)
                    thumbnailUrl = result.secure_url
                        .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                        .replace(/\.(mp4|mov|webm)$/i, '.jpg');
                }
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            }
        } catch (error) {
            console.error("Upload failed for:", file.originalname, error);
            throw new ApiError(500, "Cloudinary upload failed");
        }
    }
    if (!parsedProduct?.link) {
        throw new ApiError(400, "Product post must include a product link");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "product",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            product: parsedProduct,
            normal: {
                mood,
                activity,
                location: resolvedLocation,
                tags: parsedTags || [],
            },
        },
        settings: parsedSettings || {},
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false,
        isFeatured: false,
        isReported: false,
        reportCount: 0,
        engagement: {},
        analytics: {},
    });

    return res.status(201).json(new ApiResponse(201, post, "Product post created successfully"));
});

export const createServicePost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const {
        postType,
        caption,
        description,
        mentions,
        mood,
        activity,
        location,
        tags,
        service,
        settings,
        scheduledAt,
        publishedAt,
        status,
    } = req.body;
    if (!postType || !["photo", "reel", "video", "story"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', or 'story'");
    }

    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedService = typeof service === "string" ? JSON.parse(service) : service;
    const parsedSettings = typeof settings === "string" ? JSON.parse(settings) : settings;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

    let resolvedLocation = parsedLocation || {};
    if (resolvedLocation.name && !resolvedLocation.coordinates) {
        const coords = await getCoordinates(resolvedLocation.name);
        if (coords?.latitude && coords?.longitude) {
            resolvedLocation.coordinates = {
                type: "Point",
                coordinates: [coords.longitude, coords.latitude]
            };
        } else {
            throw new ApiError(400, `Could not resolve coordinates for location: ${resolvedLocation.name}`);
        }
    }

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    let uploadedMedia = [];
    for (const file of files) {
        try {
            const result = await uploadBufferToCloudinary(file.buffer, "posts");
            if (result.resource_type === "image") {
                const thumbnailUrl = result.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            } else if (result.resource_type === "video") {
                let thumbnailUrl;
                const customThumbnail = req.files?.thumbnail?.[0];
                if (customThumbnail) {
                    const thumbResult = await uploadBufferToCloudinary(customThumbnail.buffer, "posts");
                    thumbnailUrl = thumbResult.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                } else {
                    // Generate Cloudinary thumbnail from video URL (first frame, 300x300 crop)
                    thumbnailUrl = result.secure_url
                        .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                        .replace(/\.(mp4|mov|webm)$/i, '.jpg');
                }
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            }
        } catch {
            throw new ApiError(500, "Cloudinary upload failed");
        }
    }
    if (!parsedService?.link) {
        throw new ApiError(400, "Service post must include a service link");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "service",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            service: parsedService,
            normal: {
                mood,
                activity,
                location: resolvedLocation,
                tags: parsedTags || [],
            },
        },
        settings: parsedSettings || {},
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false,
        isFeatured: false,
        isReported: false,
        reportCount: 0,
        engagement: {},
        analytics: {},
    });

    return res.status(201).json(new ApiResponse(201, post, "Service post created successfully"));
});

export const createBusinessPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const {
        postType,
        caption,
        description,
        mentions,
        mood,
        activity,
        location,
        tags,
        business,
        settings,
        scheduledAt,
        publishedAt,
        status,
    } = req.body;
    if (!postType || !["photo", "reel", "video", "story"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', or 'story'");
    }

    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedBusiness = typeof business === "string" ? JSON.parse(business) : business;
    const parsedSettings = typeof settings === "string" ? JSON.parse(settings) : settings;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

    let resolvedLocation = parsedLocation || {};
    if (resolvedLocation.name && !resolvedLocation.coordinates) {
        const coords = await getCoordinates(resolvedLocation.name);
        if (coords?.latitude && coords?.longitude) {
            resolvedLocation.coordinates = {
                type: "Point",
                coordinates: [coords.longitude, coords.latitude]
            };
        } else {
            throw new ApiError(400, `Could not resolve coordinates for location: ${resolvedLocation.name}`);
        }
    }

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    let uploadedMedia = [];
    for (const file of files) {
        try {
            const result = await uploadBufferToCloudinary(file.buffer, "posts");
            if (result.resource_type === "image") {
                const thumbnailUrl = result.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            } else if (result.resource_type === "video") {
                let thumbnailUrl;
                const customThumbnail = req.files?.thumbnail?.[0];
                if (customThumbnail) {
                    const thumbResult = await uploadBufferToCloudinary(customThumbnail.buffer, "posts");
                    thumbnailUrl = thumbResult.secure_url.replace('/upload/', '/upload/w_300,h_300,c_fill/');
                } else {
                    // Generate Cloudinary thumbnail from video URL (first frame, 300x300 crop)
                    thumbnailUrl = result.secure_url
                        .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                        .replace(/\.(mp4|mov|webm)$/i, '.jpg');
                }
                uploadedMedia.push({
                    type: result.resource_type,
                    url: result.secure_url,
                    thumbnailUrl,
                    fileSize: result.bytes,
                    format: result.format,
                    duration: result.duration || null,
                    dimensions: {
                        width: result.width,
                        height: result.height,
                    },
                });
            }
        } catch {
            throw new ApiError(500, "Cloudinary upload failed");
        }
    }

    if (!parsedBusiness?.link) {
        throw new ApiError(400, "Business post must include a business link");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "business",
        caption,
        description,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            business: parsedBusiness,
            normal: {
                mood,
                activity,
                location: resolvedLocation,
                tags: parsedTags || [],
            },
        },
        settings: parsedSettings || {},
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false,
        isFeatured: false,
        isReported: false,
        reportCount: 0,
        engagement: {},
        analytics: {},
    });

    return res.status(201).json(new ApiResponse(201, post, "Business post created successfully"));
});


// Get all posts
export const getAllPosts = asyncHandler(async (req, res) => {
    const filter = { ...req.query };
    const posts = await Post.find(filter).sort({ createdAt: -1 });
    return res.status(200).json(new ApiResponse(200, posts, "Posts fetched successfully"));
});

// Get post by ID
export const getPostById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const post = await Post.findById(id);
    if (!post) throw new ApiError(404, "Post not found");
    return res.status(200).json(new ApiResponse(200, post, "Post fetched successfully"));
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
    const post = await Post.findByIdAndDelete(id);
    if (!post) throw new ApiError(404, "Post not found");

    return res.status(200).json(new ApiResponse(200, {}, "Post deleted successfully"));
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

// Get user profile posts with filters
export const getUserProfilePosts = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { postType, contentType, page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    if (!userId) {
        throw new ApiError(400, "User ID is required");
    }

    // Build filter object
    const filter = { 
        userId,
        status: { $in: ['published', 'scheduled'] } // Only show published or scheduled posts
    };

    // Apply post type filter (photo, reel, video)
    if (postType) {
        const validPostTypes = ['photo', 'reel', 'video'];
        if (!validPostTypes.includes(postType.toLowerCase())) {
            throw new ApiError(400, "Invalid post type. Must be one of: photo, reel, video");
        }
        filter.postType = postType.toLowerCase();
    }

    // Apply content type filter (normal, business, product, service)
    if (contentType) {
        const validContentTypes = ['normal', 'business', 'product', 'service'];
        if (!validContentTypes.includes(contentType.toLowerCase())) {
            throw new ApiError(400, "Invalid content type. Must be one of: normal, business, product, service");
        }
        filter.contentType = contentType.toLowerCase();
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDirection };

    try {
        // Get posts with pagination
        const posts = await Post.find(filter)
            .populate('userId', 'username profilePicture fullName isVerified')
            .populate('mentions', 'username fullName profilePicture')
            .sort(sortObj)
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Add isLiked field for each post
        const currentUserId = req.user?._id;
        const postsWithLikeStatus = await Promise.all(
            posts.map(async post => {
                const userLike = await Like.findOne({
                    userId: currentUserId,
                    postId: post._id
                });
                return {
                    ...post,
                    isLiked: !!userLike
                };
            })
        );

        // Get total count for pagination info
        const totalPosts = await Post.countDocuments(filter);
        const totalPages = Math.ceil(totalPosts / parseInt(limit));
        const hasNextPage = parseInt(page) < totalPages;
        const hasPrevPage = parseInt(page) > 1;

        // Prepare response with pagination metadata
        const response = {
            posts: postsWithLikeStatus,
            pagination: {
                currentPage: parseInt(page),
                totalPages,
                totalPosts,
                hasNextPage,
                hasPrevPage,
                limit: parseInt(limit)
            },
            filters: {
                postType: postType || 'all',
                contentType: contentType || 'all'
            }
        };

        return res.status(200).json(
            new ApiResponse(200, response, "User profile posts fetched successfully")
        );

    } catch (error) {
        console.error("Error fetching user profile posts:", error);
        throw new ApiError(500, "Failed to fetch user profile posts");
    }
});
export const getMyPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, "Unauthorized: User ID missing");

    const { postType, contentType, page = 1, limit = 10 } = req.query;

    const filter = { userId };

    if (postType) {
        filter.postType = postType;
    }

    if (contentType) {
        filter.contentType = contentType;
    }

    const posts = await Post.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit));

    const total = await Post.countDocuments(filter);

    // Ensure thumbnailUrl is always present in media array, and generate for videos if missing
    const postsWithThumbnails = posts.map(post => {
        const postObj = post.toObject();
        postObj.media = (postObj.media || []).map(media => {
            let thumbnailUrl = media.thumbnailUrl ?? null;
            if (
                media.type === "video" &&
                (!thumbnailUrl || thumbnailUrl === "null") &&
                typeof media.url === "string"
            ) {
                // Generate Cloudinary thumbnail from video URL (first frame, 300x300 crop)
                // Example: .../upload/ -> .../upload/w_300,h_300,c_fill,so_1/ and .mp4 -> .jpg
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

    return res.status(200).json(
        new ApiResponse(200, {
            totalPosts: total,
            page: Number(page),
            totalPages: Math.ceil(total / limit),
            posts: postsWithThumbnails
        }, "User posts fetched successfully")
    );
});

// Like a post
export const likePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    // Try to create a like (will fail if duplicate due to unique index)
    try {
        await Like.create({ userId, postId });
        // Optionally increment like count on post
        await Post.findByIdAndUpdate(postId, { $inc: { "engagement.likes": 1 } });
        return res.status(200).json(new ApiResponse(200, null, "Post liked successfully"));
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "You have already liked this post");
        }
        throw err;
    }
});

// Unlike a post
export const unlikePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    const like = await Like.findOneAndDelete({ userId, postId });
    if (like) {
        await Post.findByIdAndUpdate(postId, { $inc: { "engagement.likes": -1 } });
        return res.status(200).json(new ApiResponse(200, null, "Post unliked successfully"));
    } else {
        throw new ApiError(404, "Like not found for this post");
    }
});

// Like a comment
export const likeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    try {
        await Like.create({ userId, commentId });
        // Optionally add userId to comment.likes array
        await Comment.findByIdAndUpdate(commentId, { $addToSet: { likes: userId } });
        return res.status(200).json(new ApiResponse(200, null, "Comment liked successfully"));
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "You have already liked this comment");
        }
        throw err;
    }
});

// Unlike a comment
export const unlikeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    const like = await Like.findOneAndDelete({ userId, commentId });
    if (like) {
        // Optionally remove userId from comment.likes array
        await Comment.findByIdAndUpdate(commentId, { $pull: { likes: userId } });
        return res.status(200).json(new ApiResponse(200, null, "Comment unliked successfully"));
    } else {
        throw new ApiError(404, "Like not found for this comment");
    }
});