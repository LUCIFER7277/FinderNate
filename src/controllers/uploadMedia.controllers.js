// Cloudinary import removed - now using Bunny.net
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { uploadBufferToBunny, isBunnyUrl, isStreamUrl } from "../utils/bunny.js";
import { User } from "../models/user.models.js";
import Post from "../models/userPost.models.js";
import Reel from "../models/reels.models.js";
import Story from "../models/story.models.js";
import Message from "../models/message.models.js";
import { POST_MEDIA_LIMITS_MB, tooLargeMessage } from "../constants/uploadLimits.js";

// How many URLs one /delete-multiple call may carry. Each URL now costs a few
// lookups to establish ownership, so the batch has to be bounded — an unbounded
// array was also what let the mass deletion described below happen in a single
// request.
const MAX_DELETE_BATCH = 20;

/**
 * Who owns a stored media file.
 *
 * Nothing in the storage path encodes an uploader — generateFilePath writes
 * `<folder>/<timestamp>-<uuid>.<ext>` — so the only trustworthy record of who
 * a file belongs to is the document that references it. This resolves that
 * document and returns its owner.
 *
 * Returns null when no document references the URL. That is deliberately
 * treated as "cannot prove ownership" by the callers rather than as "free to
 * delete": an unreferenced file may be someone else's upload that has not been
 * attached to a post yet, and there is no way to tell from the URL alone.
 *
 * None of the url fields below is indexed, which is why the batch route is
 * capped. Indexes on Post.media.url, Reel.videoUrl, Story.mediaUrl and
 * Message.mediaUrl belong in the schemas and would make this cheap.
 *
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
const findMediaOwnerId = async (url) => {
    // CDN transform params (?width=300&...) are decoration on the same file.
    const bareUrl = String(url).split('?')[0];
    const match = { $in: [url, bareUrl] };

    const post = await Post.findOne({
        $or: [
            { 'media.url': match },
            { 'media.thumbnailUrl': match },
            { 'media.additionalMedia.url': match },
            { 'media.additionalMedia.thumbnailUrl': match },
            { 'productDetails.images': match },
        ]
    }).select('userId').lean();
    if (post) return post.userId;

    const reel = await Reel.findOne({
        $or: [{ videoUrl: match }, { thumbnailUrl: match }]
    }).select('userId').lean();
    if (reel) return reel.userId;

    const story = await Story.findOne({ mediaUrl: match }).select('userId').lean();
    if (story) return story.userId;

    const message = await Message.findOne({ mediaUrl: match }).select('sender').lean();
    if (message) return message.sender;

    const user = await User.findOne({ profileImageUrl: match }).select('_id').lean();
    if (user) return user._id;

    return null;
};

/**
 * Throws unless `userId` may delete `url`.
 *
 * Both delete routes previously handed a caller-supplied URL straight to
 * deleteFromBunny(), which issues the DELETE with the master storage key — so
 * any logged-in account could wipe any file in the zone just by copying media
 * URLs out of a public profile.
 */
const assertCanDeleteMedia = async (url, userId) => {
    if (typeof url !== 'string' || (!isBunnyUrl(url) && !isStreamUrl(url))) {
        throw new ApiError(400, "Invalid media URL");
    }

    const ownerId = await findMediaOwnerId(url);
    if (!ownerId) {
        // 404, not 403: telling an unrelated caller "that isn't yours" would
        // confirm the file exists.
        throw new ApiError(404, "Media not found");
    }
    if (ownerId.toString() !== userId.toString()) {
        throw new ApiError(403, "You are not authorized to delete this media");
    }
};

// Upload single media file (image, video, audio, document)
const uploadSingleMedia = asyncHandler(async (req, res) => {
    const { file } = req;
    const userId = req.user?._id;

    if (!file) {
        throw new ApiError(400, "No file uploaded");
    }

    if (!userId) {
        throw new ApiError(401, "User authentication required");
    }

    // Allowed types — prefix matching accepts any browser MIME variant
    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/quicktime', 'video/mov', 'video/x-ms-wmv', 'video/wmv', 'video/webm', 'video/x-flv', 'video/flv'];
    const allowedAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/webm'];
    const allowedDocTypes = [
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'application/zip', 'application/x-rar-compressed',
    ];

    const mime = file.mimetype || '';
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');
    const isDoc   = allowedDocTypes.some(t => mime.startsWith(t));

    if (!isImage && !isVideo && !isAudio && !isDoc) {
        throw new ApiError(400, `File type "${mime}" is not allowed`);
    }

    // Per-type size limits
    const category = isVideo ? 'video' : isAudio ? 'audio' : isDoc ? 'file' : 'image';
    const limitMB = POST_MEDIA_LIMITS_MB[category];
    if (file.size > limitMB * 1024 * 1024) {
        // 413, not 400: this is a payload-size refusal specifically, and the
        // message names the file's actual size so the user can see the gap.
        throw new ApiError(413, tooLargeMessage({
            category,
            actualBytes: file.size,
            limitMB,
        }));
    }

    // image/video → existing proven Bunny folders; audio/docs → new folders
    const folderMap = { image: 'images', video: 'videos', audio: 'chat_audio', file: 'chat_files' };
    const folder = folderMap[category];

    // mimeTypeHint only for audio/docs — image/video use original magic-byte detection
    const mimeHint = (isAudio || isDoc) ? mime : null;

    let result;
    try {
        result = await uploadBufferToBunny(file.buffer, folder, file.originalname, mimeHint);
    } catch (uploadError) {
        throw new ApiError(500, `Upload failed: ${uploadError.message}`);
    }

    // User details — non-fatal if DB lookup fails
    let uploadedBy = null;
    try {
        const user = await User.findById(userId).select("-password -refreshToken");
        if (user) {
            uploadedBy = {
                _id: user._id,
                username: user.username,
                fullName: user.fullName,
                email: user.email,
                profileImageUrl: user.profileImageUrl,
                isBusinessProfile: user.isBusinessProfile
            };
        }
    } catch (_) {}

    return res.status(200).json(
        new ApiResponse(200, {
            public_id: result.public_id,
            secure_url: result.secure_url,
            format: result.format,
            resource_type: result.resource_type,
            category,
            bytes: result.bytes,
            folder,
            original_name: file.originalname,
            mimetype: file.mimetype,
            uploaded_by: uploadedBy,
            uploaded_at: new Date().toISOString()
        }, "Media uploaded successfully")
    );
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

            const isVideo = allowedVideoTypes.includes(file.mimetype);

            // Validate file size against the same per-type ceilings the
            // single-file route uses — a flat 50 MB here rejected videos this
            // API is meant to accept and waved through oversized images.
            const category = isVideo ? 'video' : 'image';
            const limitMB = POST_MEDIA_LIMITS_MB[category];
            if (file.size > limitMB * 1024 * 1024) {
                errors.push({
                    filename: file.originalname,
                    error: tooLargeMessage({
                        category,
                        actualBytes: file.size,
                        limitMB,
                    })
                });
                continue;
            }

            // Determine folder based on file type
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

    // Ownership is settled before the try block: an ApiError raised inside it
    // would be swallowed by the catch and re-reported as a 500.
    await assertCanDeleteMedia(url, userId);

    try {
        const { deleteFromBunny } = await import("../utils/bunny.js");
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
        // Keep a deliberate status (the 400 above) instead of relabelling it 500.
        if (error instanceof ApiError) throw error;
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

    if (urls.length > MAX_DELETE_BATCH) {
        throw new ApiError(400, `A maximum of ${MAX_DELETE_BATCH} URLs can be deleted in one request`);
    }

    // Same ownership gate as the single-file route, per URL. A URL the caller
    // does not own is reported as a failure for that entry and never reaches
    // Bunny — one bad entry does not fail the whole batch.
    const deletableUrls = [];
    const rejected = [];
    for (const url of urls) {
        try {
            await assertCanDeleteMedia(url, userId);
            deletableUrls.push(url);
        } catch (error) {
            rejected.push({
                url,
                deleted: false,
                deleted_by: null,
                deleted_at: null,
                error: error.message
            });
        }
    }

    try {
        const { deleteMultipleFromBunny } = await import("../utils/bunny.js");
        const deletionResult = await deleteMultipleFromBunny(deletableUrls);

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
                deleted_files: [...results, ...rejected],
                total_files: urls.length,
                successful_deletions: deletionResult.totalDeleted,
                failed_deletions: deletionResult.errors.length + rejected.length,
                skipped_deletions: deletionResult.totalSkipped
            }, "Multiple media deletion completed")
        );
    } catch (error) {
        if (error instanceof ApiError) throw error;
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
        const { isBunnyUrl } = await import("../utils/bunny.js");

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
