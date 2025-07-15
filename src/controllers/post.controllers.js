import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import { uploadBufferToCloudinary } from "../utlis/cloudinary.js";
import { getCoordinates } from "../utlis/getCoordinates.js";


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

    // 🔒 Validate postType
    if (!postType || !["photo", "reel"].includes(postType)) {
        throw new ApiError(400, "postType must be 'photo' or 'reel'");
    }

    // 🧠 Parse JSON strings if necessary (Postman sends form-data as strings)
    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedSettings = typeof settings === "string" ? JSON.parse(settings) : settings;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;

    // 🗺️ Add coordinates if location name is present
    let resolvedLocation = parsedLocation || {};
    if (resolvedLocation.name && !resolvedLocation.coordinates) {
        const coords = await getCoordinates(resolvedLocation.name);
        console.log("Coordinates for", resolvedLocation.name, ":", coords);
        if (coords && coords.latitude && coords.longitude) {
            resolvedLocation.coordinates = {
                type: "Point",
                coordinates: [coords.longitude, coords.latitude]
            };
        } else {
            throw new ApiError(400, `Could not resolve coordinates for location: ${resolvedLocation.name}`);
        }
    }

    // 📸 Upload media to Cloudinary
    let uploadedMedia = null;
    if (req.file) {
        try {
            const result = await uploadBufferToCloudinary(req.file.buffer, "posts");
            uploadedMedia = {
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
            };
        } catch (err) {
            throw new ApiError(500, "Cloudinary upload failed");
        }
    } else {
        throw new ApiError(400, "Media file is required");
    }

    // 🛠️ Create the post
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

    return res
        .status(201)
        .json(new ApiResponse(201, post, "Normal post created successfully"));
});

export const createProductPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, media, settings, product } = req.body;

    if (!postType || !['photo', 'reel'].includes(postType)) {
        throw new ApiError(400, "postType must be 'photo' or 'reel'");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "product",
        caption,
        description,
        mentions,
        media,
        settings,
        customization: { product }
    });

    return res.status(201).json(new ApiResponse(201, post, "Product post created"));
});

export const createServicePost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, media, settings, service } = req.body;

    if (!postType || !['photo', 'reel'].includes(postType)) {
        throw new ApiError(400, "postType must be 'photo' or 'reel'");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "service",
        caption,
        description,
        mentions,
        media,
        settings,
        customization: { service }
    });

    return res.status(201).json(new ApiResponse(201, post, "Service post created"));
});
export const createBusinessPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, media, settings, business } = req.body;

    if (!postType || !['photo', 'reel'].includes(postType)) {
        throw new ApiError(400, "postType must be 'photo' or 'reel'");
    }

    const post = await Post.create({
        userId,
        postType,
        contentType: "business",
        caption,
        description,
        mentions,
        media,
        settings,
        customization: { business }
    });

    return res.status(201).json(new ApiResponse(201, post, "Business post created"));
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
