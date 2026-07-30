import { FeedCacheManager, CacheManager } from "../../utils/cache.utils.js";
import { uploadBufferToBunny, generateOptimizedImageUrl } from "../../utils/bunny.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import { ApiError } from "../../utils/ApiError.js";
import {
    MAX_IMAGES_PER_POST,
    MAX_IMAGES_WITH_VIDEO,
    MAX_MEDIA_PER_POST,
    MAX_VIDEOS_PER_POST,
    POST_MEDIA_LIMITS_MB,
    tooLargeMessage,
} from "../../constants/uploadLimits.js";
import { redisClient } from "../../config/redis.config.js";

export const pushNewPostToBuffer = async (postId, userId) => {
    await Promise.all([
        FeedCacheManager.invalidateUserFeed(userId),
        FeedCacheManager.invalidateTrendingFeed(),
        FeedCacheManager.invalidateExploreFeed(),
    ]);
};

export const extractMediaFiles = (files) => {
    const allFiles = [];
    ["image", "video", "reel", "story"].forEach((field) => {
        if (files?.[field]) {
            allFiles.push(...files[field]);
        }
    });
    return allFiles;
};

export const parseField = (value) => {
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return value; }
    }
    return value;
};

export const resolveLocationCoordinates = async (parsedLocation) => {
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

/**
 * Uploads a post's media to Bunny.
 *
 * Uploads run in PARALLEL. The old sequential loop made an N-file post cost
 * N x (AVIF re-encode + Bunny PUT), and since the client waits for this before
 * it gets a response, a 6-post batch or a 10-image carousel routinely ran past
 * the mobile client's request timeout — the app reported a failure for posts
 * the server went on to create.
 *
 * `map` + `Promise.all` rather than push-as-you-go: media[0] is the cover, so
 * the output order must match the input order.
 *
 * A custom video thumbnail is now uploaded ONCE rather than once per video.
 */
export const uploadPostMedia = async (files, customThumbnail) => {
    // One video per post. Enforced here rather than in the route because a
    // video can arrive under any of the "video", "reel" or "story" fields —
    // extractMediaFiles merges all three, and the batch route builds its own
    // list — so a per-field maxCount cannot see the total. Checked before any
    // upload begins, so a rejected post leaves nothing behind on Bunny.
    const videoCount = files.filter((f) => f.mimetype?.startsWith("video/")).length;
    const imageCount = files.filter((f) => f.mimetype?.startsWith("image/")).length;

    if (videoCount > MAX_VIDEOS_PER_POST) {
        throw new ApiError(400,
            `A post can include at most ${MAX_VIDEOS_PER_POST} video${MAX_VIDEOS_PER_POST === 1 ? '' : 's'}, but ${videoCount} were attached. ` +
            `Post the other clips separately — images can still be combined, up to ${MAX_IMAGES_PER_POST} per post.`
        );
    }

    // Ten media in total either way: ten images alone, or one video plus nine.
    // This is the ceiling that bounds request memory, since multer buffers
    // every file in RAM before a controller sees it.
    const imageAllowance = videoCount > 0 ? MAX_IMAGES_WITH_VIDEO : MAX_IMAGES_PER_POST;
    if (imageCount > imageAllowance) {
        throw new ApiError(400,
            videoCount > 0
                ? `A post with a video can include up to ${MAX_IMAGES_WITH_VIDEO} images, but ${imageCount} were attached — ${MAX_MEDIA_PER_POST} items in total.`
                : `A post can include up to ${MAX_IMAGES_PER_POST} images, but ${imageCount} were attached.`
        );
    }

    // Per-type size ceilings.
    //
    // multerConfig says "per-type limits enforced in controllers" and that was
    // true of the media and chat controllers — but NOT of this one, the path
    // every post takes. So POST_MEDIA_LIMITS_MB existed and the post pipeline
    // ignored it: the only ceiling in play was multer's blanket 600 MB, which
    // let a 500 MB file through as an "image" against a 10 MB stated limit, and
    // let it through as a fully buffered RAM copy at that.
    //
    // Checked before the Bunny loop, alongside the count checks, so an
    // oversized post leaves nothing uploaded.
    const categoryOf = (mimetype = "") => {
        if (mimetype.startsWith("image/")) return "image";
        if (mimetype.startsWith("video/")) return "video";
        if (mimetype.startsWith("audio/")) return "audio";
        return "file";
    };

    for (const file of files) {
        const category = categoryOf(file.mimetype);
        const limitMB = POST_MEDIA_LIMITS_MB[category];
        if (!limitMB) continue;
        // buffer.length as the fallback: if `size` were ever absent, comparing
        // undefined would be false and this whole guard would silently pass
        // everything — a check that cannot fail loudly is worse than no check.
        const size = file.size ?? file.buffer?.length ?? 0;
        if (size > limitMB * 1024 * 1024) {
            throw new ApiError(400, tooLargeMessage({
                category,
                actualBytes: size,
                limitMB,
            }));
        }
    }

    let videoThumbnailUrl = null;
    if (customThumbnail) {
        const thumbResult = await uploadBufferToBunny(customThumbnail.buffer, "posts");
        videoThumbnailUrl = generateOptimizedImageUrl(thumbResult.secure_url, { width: 300, height: 300, crop: 'fill' });
    }

    const uploaded = await Promise.all(files.map(async (file) => {
        let result;
        try {
            result = await uploadBufferToBunny(file.buffer, "posts");
        } catch {
            throw new ApiError(500, "Bunny.net upload failed");
        }

        if (result.resource_type !== "image" && result.resource_type !== "video") return null;

        // Video thumbnails: the uploader's own still wins, then whatever the
        // upload produced (Stream returns a real frame). The old fallback
        // appended "?thumbnail=1" to the video URL, but Bunny's Optimizer is
        // not enabled, so that URL served the MP4 itself — clients downloaded
        // megabytes and then failed to decode a video as an image. Null is
        // honest; they already render a placeholder for it.
        const thumbnailUrl = result.resource_type === "image"
            ? generateOptimizedImageUrl(result.secure_url, { width: 300, height: 300, crop: 'fill' })
            : (videoThumbnailUrl || result.thumbnailUrl || null);

        return {
            type: result.resource_type,
            url: result.secure_url,
            thumbnailUrl,
            fileSize: result.bytes,
            format: result.format,
            duration: result.duration || null,
            dimensions: { width: result.width, height: result.height },
            // Stream encodes after the upload returns, so the URL is valid but
            // not yet playable. Clients show the thumbnail until this clears.
            processing: result.processing === true,
        };
    }));

    return uploaded.filter(Boolean);
};

export const invalidatePostCaches = async (postId, userId) => {
    try {
        await Promise.allSettled([
            CacheManager.delPattern('fn:user:*:feed:*'),
            CacheManager.delPattern('fn:posts:trending:*'),
            CacheManager.delPattern('fn:explore:feed:*'),
            CacheManager.delPattern('fn:reels:*'),
        ]);

        try {
            const reelKeys = await redisClient.keys('fn:reels:*');
            if (reelKeys.length > 0) {
                await redisClient.del(...reelKeys);
            }
        } catch (err) {
            console.error('Redis reel cache clear error:', err);
        }

        await redisClient.del(`fn:share:post:${postId}`);
        await redisClient.del(`fn:share:reel:${postId}`);
        await redisClient.del(`fn:share:preview:${postId}`);
        await redisClient.del(`fn:share:preview:reel:${postId}`);
    } catch (error) {
        console.error('Cache invalidation error:', error);
    }
};
