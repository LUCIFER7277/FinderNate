import { FeedCacheManager, CacheManager } from "../../utils/cache.utils.js";
import { uploadBufferToBunny, generateOptimizedImageUrl } from "../../utils/bunny.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import { ApiError } from "../../utils/ApiError.js";
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

export const uploadPostMedia = async (files, customThumbnail) => {
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
