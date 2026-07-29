import { FeedCacheManager, CacheManager } from "../../utils/cache.utils.js";
import { uploadBufferToBunny, generateOptimizedImageUrl } from "../../utils/bunny.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import { ApiError } from "../../utils/ApiError.js";
import { MAX_IMAGES_PER_POST, MAX_VIDEOS_PER_POST } from "../../constants/uploadLimits.js";
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
    if (videoCount > MAX_VIDEOS_PER_POST) {
        throw new ApiError(400,
            `A post can include at most ${MAX_VIDEOS_PER_POST} video${MAX_VIDEOS_PER_POST === 1 ? '' : 's'}, but ${videoCount} were attached. ` +
            `Post the other clips separately — images can still be combined, up to ${MAX_IMAGES_PER_POST} per post.`
        );
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
