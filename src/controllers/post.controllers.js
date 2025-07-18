import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import { uploadBufferToCloudinary } from "../utlis/cloudinary.js";
import { getCoordinates } from "../utlis/getCoordinates.js";

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
            uploadedMedia.push({
                type: result.resource_type,
                url: result.secure_url,
                thumbnailUrl: result.secure_url,
                fileSize: result.bytes,
                format: result.format,
                duration: result.duration || null,
                dimensions: {
                    width: result.width,
                    height: result.height,
                },
            });
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
            uploadedMedia.push({
                type: result.resource_type,
                url: result.secure_url,
                thumbnailUrl: result.secure_url,
                fileSize: result.bytes,
                format: result.format,
                duration: result.duration || null,
                dimensions: {
                    width: result.width,
                    height: result.height,
                },
            });
        } catch (error) {
            console.error("Upload failed for:", file.originalname, error);
            throw new ApiError(500, "Cloudinary upload failed");
        }
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
            uploadedMedia.push({
                type: result.resource_type,
                url: result.secure_url,
                thumbnailUrl: result.secure_url,
                fileSize: result.bytes,
                format: result.format,
                duration: result.duration || null,
                dimensions: {
                    width: result.width,
                    height: result.height,
                },
            });
        } catch {
            throw new ApiError(500, "Cloudinary upload failed");
        }
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
            uploadedMedia.push({
                type: result.resource_type,
                url: result.secure_url,
                thumbnailUrl: result.secure_url,
                fileSize: result.bytes,
                format: result.format,
                duration: result.duration || null,
                dimensions: {
                    width: result.width,
                    height: result.height,
                },
            });
        } catch {
            throw new ApiError(500, "Cloudinary upload failed");
        }
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
