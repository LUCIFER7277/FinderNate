// Cloudinary import removed - now using Bunny.net
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { uploadBufferToBunny } from "../utlis/bunny.js";
import { User } from "../models/user.models.js";

// Upload single media file (image or video)
const uploadSingleMedia = asyncHandler(async (req, res) => {
    const { file } = req;
    const userId = req.user?._id;

    if (!file) {
        throw new ApiError(400, "No file uploaded");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    // Check file type
    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm'];
    const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];

    if (!allowedTypes.includes(file.mimetype)) {
        throw new ApiError(400, "Invalid file type. Only images and videos are allowed");
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
        throw new ApiError(400, "File size too large. Maximum size is 50MB");
    }

    try {
        // Determine folder based on file type
        const isVideo = allowedVideoTypes.includes(file.mimetype);
        const folder = isVideo ? "videos" : "images";

        // Upload to Bunny.net
        const result = await uploadBufferToBunny(file.buffer, folder, file.originalname);

        // Get user details
        const user = await User.findById(userId).select("-password -refreshToken");

        // Return success response with file details and user info
        return res.status(200).json(
            new ApiResponse(200, {
                public_id: result.public_id,
                secure_url: result.secure_url,
                format: result.format,
                resource_type: result.resource_type,
                bytes: result.bytes,
                width: result.width,
                height: result.height,
                duration: result.duration, // for videos
                folder: folder,
                original_name: file.originalname,
                mimetype: file.mimetype,
                uploaded_by: {
                    _id: user._id,
                    username: user.username,
                    fullName: user.fullName,
                    email: user.email,
                    profileImageUrl: user.profileImageUrl,
                    isBusinessProfile: user.isBusinessProfile
                },
                uploaded_at: new Date().toISOString()
            }, "Media uploaded successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Error uploading file to Bunny.net", [error.message]);
    }
});

// Upload multiple media files
const uploadMultipleMedia = asyncHandler(async (req, res) => {
    const { files } = req;
    const userId = req.user?._id;

    if (!files || files.length === 0) {
        throw new ApiError(400, "No files uploaded");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm'];
    const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];
    const maxSize = 50 * 1024 * 1024; // 50MB

    const uploadedFiles = [];
    const errors = [];

    for (const file of files) {
        try {
            // Validate file type
            if (!allowedTypes.includes(file.mimetype)) {
                errors.push({
                    filename: file.originalname,
                    error: "Invalid file type. Only images and videos are allowed"
                });
                continue;
            }

            // Validate file size
            if (file.size > maxSize) {
                errors.push({
                    filename: file.originalname,
                    error: "File size too large. Maximum size is 50MB"
                });
                continue;
            }

            // Determine folder based on file type
            const isVideo = allowedVideoTypes.includes(file.mimetype);
            const folder = isVideo ? "videos" : "images";

            // Upload to Bunny.net
            const result = await uploadBufferToBunny(file.buffer, folder, file.originalname);

            uploadedFiles.push({
                public_id: result.public_id,
                secure_url: result.secure_url,
                format: result.format,
                resource_type: result.resource_type,
                bytes: result.bytes,
                width: result.width,
                height: result.height,
                duration: result.duration,
                folder: folder,
                original_name: file.originalname,
                mimetype: file.mimetype,
                uploaded_by: {
                    _id: req.user._id,
                    username: req.user.username,
                    fullName: req.user.fullName,
                    email: req.user.email,
                    profileImageUrl: req.user.profileImageUrl,
                    isBusinessProfile: req.user.isBusinessProfile
                },
                uploaded_at: new Date().toISOString()
            });
        } catch (error) {
            errors.push({
                filename: file.originalname,
                error: error.message
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            uploaded_files: uploadedFiles,
            errors: errors,
            total_files: files.length,
            successful_uploads: uploadedFiles.length,
            failed_uploads: errors.length
        }, "Multiple media upload completed")
    );
});

// Delete media from Bunny.net
const deleteMedia = asyncHandler(async (req, res) => {
    const { url } = req.body;
    const userId = req.user?._id;

    if (!url) {
        throw new ApiError(400, "Media URL is required");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    try {
        const { deleteFromBunny } = await import("../utlis/bunny.js");
        const result = await deleteFromBunny(url);

        if (result.success) {
            return res.status(200).json(
                new ApiResponse(200, {
                    url: url,
                    deleted: true,
                    deleted_by: {
                        _id: req.user._id,
                        username: req.user.username,
                        fullName: req.user.fullName,
                        email: req.user.email
                    },
                    deleted_at: new Date().toISOString()
                }, "Media deleted successfully")
            );
        } else {
            throw new ApiError(400, "Failed to delete media from Bunny.net");
        }
    } catch (error) {
        throw new ApiError(500, "Error deleting media from Bunny.net", [error.message]);
    }
});

// Delete multiple media files
const deleteMultipleMedia = asyncHandler(async (req, res) => {
    const { urls } = req.body;
    const userId = req.user?._id;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        throw new ApiError(400, "URLs array is required");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    try {
        const { deleteMultipleFromBunny } = await import("../utlis/bunny.js");
        const deletionResult = await deleteMultipleFromBunny(urls);

        const results = deletionResult.results.map(result => ({
            url: result.url,
            deleted: result.success,
            deleted_by: {
                _id: req.user._id,
                username: req.user.username,
                fullName: req.user.fullName,
                email: req.user.email
            },
            deleted_at: new Date().toISOString(),
            error: result.error || null
        }));

        return res.status(200).json(
            new ApiResponse(200, {
                deleted_files: results,
                total_files: urls.length,
                successful_deletions: deletionResult.totalDeleted,
                failed_deletions: deletionResult.errors.length,
                skipped_deletions: deletionResult.totalSkipped
            }, "Multiple media deletion completed")
        );
    } catch (error) {
        throw new ApiError(500, "Error deleting multiple media from Bunny.net", [error.message]);
    }
});

// Get media information - Note: Bunny.net doesn't provide detailed metadata API
// This function now returns basic URL validation and structure info
const getMediaInfo = asyncHandler(async (req, res) => {
    const { url } = req.query;
    const userId = req.user?._id;

    if (!url) {
        throw new ApiError(400, "Media URL is required");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    try {
        const { isBunnyUrl } = await import("../utlis/bunny.js");

        if (!isBunnyUrl(url)) {
            throw new ApiError(400, "Invalid Bunny.net URL");
        }

        // Extract basic info from URL
        const urlParts = url.split('/');
        const filename = urlParts[urlParts.length - 1].split('?')[0];
        const folder = urlParts[urlParts.length - 2];
        const extension = filename.split('.').pop();

        return res.status(200).json(
            new ApiResponse(200, {
                url: url,
                filename: filename,
                folder: folder,
                format: extension,
                isBunnyHosted: true,
                requested_by: {
                    _id: req.user._id,
                    username: req.user.username,
                    fullName: req.user.fullName,
                    email: req.user.email
                },
                requested_at: new Date().toISOString()
            }, "Media information retrieved successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Error retrieving media information", [error.message]);
    }
});

export {
    uploadSingleMedia,
    uploadMultipleMedia,
    deleteMedia,
    deleteMultipleMedia,
    getMediaInfo,
};
