import { User } from '../models/user.models.js';

/**
 * Batch fetch users and create a lookup map
 * @param {Array} userIds - Array of user IDs to fetch
 * @param {String} fields - Fields to select (default: 'username profileImageUrl')
 * @returns {Object} Map of userId -> user object
 */
export const batchFetchUsers = async (userIds, fields = 'username profileImageUrl') => {
    if (!userIds || userIds.length === 0) {
        return {};
    }

    // Remove duplicates
    const uniqueUserIds = [...new Set(userIds.map(id => id.toString()))];

    // Fetch all users in one query
    const users = await User.find({ _id: { $in: uniqueUserIds } })
        .select(fields)
        .lean();

    // Create map for O(1) lookup
    const userMap = {};
    users.forEach(user => {
        userMap[user._id.toString()] = user;
    });

    return userMap;
};

/**
 * Attach user data to array of objects
 * @param {Array} items - Array of items with userId field
 * @param {String} userField - Name of the field containing userId (default: 'userId')
 * @param {String} fields - Fields to select from User model
 * @returns {Array} Items with attached user data
 */
export const attachUserData = async (items, userField = 'userId', fields = 'username profileImageUrl fullName isVerified') => {
    if (!items || items.length === 0) {
        return items;
    }

    // Extract all user IDs
    const userIds = items
        .map(item => item[userField])
        .filter(id => id);

    // Batch fetch users
    const userMap = await batchFetchUsers(userIds, fields);

    // Attach user data to items
    return items.map(item => {
        const userId = item[userField]?.toString() || item[userField];
        const userData = userMap[userId];

        return {
            ...item,
            [userField]: userData || item[userField] // Keep original if user not found
        };
    });
};

/**
 * Batch fetch users with caching
 * Uses in-memory cache with TTL for frequently accessed users
 */
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const batchFetchUsersWithCache = async (userIds, fields = 'username profileImageUrl') => {
    if (!userIds || userIds.length === 0) {
        return {};
    }

    const uniqueUserIds = [...new Set(userIds.map(id => id.toString()))];
    const userMap = {};
    const idsToFetch = [];

    // Check cache first
    const now = Date.now();
    uniqueUserIds.forEach(id => {
        const cached = userCache.get(id);
        if (cached && (now - cached.timestamp) < CACHE_TTL) {
            userMap[id] = cached.data;
        } else {
            idsToFetch.push(id);
        }
    });

    // Fetch missing users from database
    if (idsToFetch.length > 0) {
        const users = await User.find({ _id: { $in: idsToFetch } })
            .select(fields)
            .lean();

        users.forEach(user => {
            const id = user._id.toString();
            userMap[id] = user;
            // Cache the user
            userCache.set(id, {
                data: user,
                timestamp: now
            });
        });
    }

    return userMap;
};

/**
 * Clear user cache (useful for testing or manual cache invalidation)
 */
export const clearUserCache = (userId) => {
    if (userId) {
        userCache.delete(userId.toString());
    } else {
        userCache.clear();
    }
};

/**
 * Batch populate users for posts
 * Optimized for feed queries
 */
export const populatePostUsers = async (posts) => {
    if (!posts || posts.length === 0) {
        return posts;
    }

    // Extract all unique user IDs from posts
    const userIds = [...new Set(posts.map(post => post.userId).filter(id => id))];

    // Batch fetch all users
    const userMap = await batchFetchUsersWithCache(userIds, 'username profileImageUrl fullName isVerified');

    // Attach user data to posts
    return posts.map(post => {
        const userId = post.userId?.toString() || post.userId;
        return {
            ...post,
            userId: userMap[userId] || post.userId
        };
    });
};