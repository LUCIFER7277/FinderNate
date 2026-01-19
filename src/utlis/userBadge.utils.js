import Subscription from '../models/subscription.models.js';
import mongoose from 'mongoose';

/**
 * Get subscription badge for a user based on their subscription status
 * @param {Object|String} user - User object or userId
 * @param {Boolean} isBusinessProfile - Whether user has business profile
 * @returns {Object|null} Badge object or null if no badge
 */
export const getUserBadge = async (user, isBusinessProfile = false) => {
    // If user is passed as an object with isBusinessProfile, use that
    if (typeof user === 'object' && user.isBusinessProfile !== undefined) {
        isBusinessProfile = user.isBusinessProfile;
    }

    // Business profiles always get corporate badge
    if (isBusinessProfile) {
        return {
            type: 'corporate',
            label: 'Corporate',
            color: '#F59E0B', // gold
            isPaid: true
        };
    }

    // Get userId
    const userId = typeof user === 'object' ? (user._id || user.id) : user;

    // Check active subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    if (!subscription || subscription.plan === 'free') {
        return null; // No badge for free users
    }

    // Return badge based on plan
    const badgeMap = {
        small_business: {
            type: 'small_business',
            label: 'Small Business',
            color: '#3B82F6', // blue
            isPaid: true
        },
        corporate: {
            type: 'corporate',
            label: 'Corporate',
            color: '#F59E0B', // gold
            isPaid: true
        }
    };

    return badgeMap[subscription.plan] || null;
};

/**
 * Add subscription badge to a single user object
 * @param {Object} userObj - User object (can be lean or document)
 * @returns {Object} User object with badge added
 */
export const addBadgeToUser = async (userObj) => {
    if (!userObj) return null;

    // Convert to plain object if it's a mongoose document
    const user = userObj.toObject ? userObj.toObject() : { ...userObj };

    // Get the badge
    const badge = await getUserBadge(user);

    // Add badge to user object
    user.subscriptionBadge = badge;

    return user;
};

/**
 * Add subscription badges to an array of user objects
 * @param {Array} users - Array of user objects
 * @returns {Array} Array of user objects with badges added
 */
export const addBadgesToUsers = async (users) => {
    if (!users || !Array.isArray(users)) return [];

    // Get all user IDs and their business profile status
    const userMap = new Map();
    users.forEach(user => {
        if (user) {
            const userId = (user._id || user.id)?.toString();
            if (userId) {
                userMap.set(userId, {
                    isBusinessProfile: user.isBusinessProfile || false
                });
            }
        }
    });

    const userIds = Array.from(userMap.keys()).map(id => new mongoose.Types.ObjectId(id));

    // Get all active subscriptions in one query
    const subscriptions = await Subscription.find({
        userId: { $in: userIds },
        status: 'active',
        endDate: { $gt: new Date() }
    }).lean();

    // Create a map of userId -> subscription plan
    const subscriptionMap = new Map();
    subscriptions.forEach(sub => {
        subscriptionMap.set(sub.userId.toString(), sub.plan);
    });

    // Badge definitions
    const badgeMap = {
        small_business: {
            type: 'small_business',
            label: 'Small Business',
            color: '#3B82F6', // blue
            isPaid: true
        },
        corporate: {
            type: 'corporate',
            label: 'Corporate',
            color: '#F59E0B', // gold
            isPaid: true
        }
    };

    // Add badges to all users
    return users.map(userObj => {
        if (!userObj) return null;

        // Convert to plain object if it's a mongoose document
        const user = userObj.toObject ? userObj.toObject() : { ...userObj };
        const userId = (user._id || user.id)?.toString();

        if (!userId) return user;

        // Business profiles get corporate badge
        if (user.isBusinessProfile) {
            user.subscriptionBadge = badgeMap.corporate;
            return user;
        }

        // Get subscription plan for this user
        const plan = subscriptionMap.get(userId);

        // Add badge based on plan
        user.subscriptionBadge = plan && badgeMap[plan] ? badgeMap[plan] : null;

        return user;
    });
};

/**
 * Add subscription badge to nested user objects in posts/comments
 * @param {Array} items - Array of posts/comments with populated userId
 * @returns {Array} Array with badges added to nested user objects
 */
export const addBadgesToNestedUsers = async (items) => {
    if (!items || !Array.isArray(items)) return [];

    // Extract all unique users
    const userMap = new Map();
    items.forEach(item => {
        if (item && item.userId) {
            const userId = (item.userId._id || item.userId.id || item.userId)?.toString();
            if (userId && typeof item.userId === 'object') {
                userMap.set(userId, item.userId);
            }
        }
    });

    // Get badges for all users
    const users = Array.from(userMap.values());
    const usersWithBadges = await addBadgesToUsers(users);

    // Create a map of userId -> user with badge
    const badgeMap = new Map();
    usersWithBadges.forEach(user => {
        if (user) {
            const userId = (user._id || user.id)?.toString();
            if (userId) {
                badgeMap.set(userId, user);
            }
        }
    });

    // Update items with badged users
    return items.map(item => {
        if (!item || !item.userId || typeof item.userId !== 'object') return item;

        const userId = (item.userId._id || item.userId.id)?.toString();
        if (userId && badgeMap.has(userId)) {
            item.userId = badgeMap.get(userId);
        }

        return item;
    });
};
