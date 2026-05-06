import Business from "../models/business.models.js";
import BusinessRating from "../models/businessRating.models.js";

/**
 * Fetch average ratings for multiple users
 * @param {Array<string|ObjectId>} userIds - Array of user IDs to fetch ratings for
 * @returns {Promise<Object>} Map of userId -> { averageRating, totalReviews }
 */
export const fetchUserRatings = async (userIds) => {
    try {
        if (!userIds || userIds.length === 0) {
            return {};
        }

        // Find all businesses for the given user IDs
        const businesses = await Business.find(
            { userId: { $in: userIds } },
            { _id: 1, userId: 1 }
        ).lean();

        if (businesses.length === 0) {
            return {};
        }

        // Get business IDs
        const businessIds = businesses.map(b => b._id);
        const userIdToBusinessId = {};
        businesses.forEach(b => {
            userIdToBusinessId[b.userId.toString()] = b._id;
        });

        // Aggregate ratings for all businesses
        const ratingsAggregation = await BusinessRating.aggregate([
            { $match: { businessId: { $in: businessIds } } },
            {
                $group: {
                    _id: "$businessId",
                    averageRating: { $avg: "$rating" },
                    totalReviews: { $sum: 1 }
                }
            }
        ]);

        // Create a map of businessId -> rating data
        const businessRatings = {};
        ratingsAggregation.forEach(rating => {
            businessRatings[rating._id.toString()] = {
                averageRating: parseFloat(rating.averageRating.toFixed(1)),
                totalReviews: rating.totalReviews
            };
        });

        // Map ratings back to user IDs
        const userRatings = {};
        Object.entries(userIdToBusinessId).forEach(([userId, businessId]) => {
            const businessIdStr = businessId.toString();
            if (businessRatings[businessIdStr]) {
                userRatings[userId] = businessRatings[businessIdStr];
            }
        });

        return userRatings;
    } catch (error) {
        console.error('Error fetching user ratings:', error);
        return {};
    }
};

/**
 * Fetch rating for a single user
 * @param {string|ObjectId} userId - User ID to fetch rating for
 * @returns {Promise<Object|null>} { averageRating, totalReviews } or null
 */
export const fetchUserRating = async (userId) => {
    try {
        const ratings = await fetchUserRatings([userId]);
        return ratings[userId.toString()] || null;
    } catch (error) {
        console.error('Error fetching user rating:', error);
        return null;
    }
};

/**
 * Enrich posts/reels with user rating data
 * @param {Array} items - Array of posts or reels
 * @param {string} userField - Field name containing user data (default: 'userId')
 * @returns {Promise<Array>} Items with rating data added
 */
export const enrichWithRatings = async (items, userField = 'userId') => {
    try {
        if (!items || items.length === 0) {
            return items;
        }

        // Extract unique user IDs
        const userIds = [...new Set(
            items
                .map(item => {
                    const user = item[userField];
                    if (user?._id) return user._id.toString();
                    if (user) return user.toString();
                    return null;
                })
                .filter(id => id !== null)
        )];

        // Fetch ratings for all users
        const userRatings = await fetchUserRatings(userIds);

        // Add rating data to each item
        return items.map(item => {
            const user = item[userField];
            let userId = null;

            if (user?._id) {
                userId = user._id.toString();
            } else if (user) {
                userId = user.toString();
            }

            if (userId && userRatings[userId]) {
                // If item is a Mongoose document, convert to plain object
                const itemObj = item.toObject ? item.toObject() : { ...item };

                // Add review data to user object
                if (typeof itemObj[userField] === 'object' && itemObj[userField] !== null) {
                    itemObj[userField] = {
                        ...itemObj[userField],
                        review: userRatings[userId]
                    };
                } else {
                    // If userId is just an ID, add review at top level
                    itemObj.userReview = userRatings[userId];
                }

                return itemObj;
            }

            return item.toObject ? item.toObject() : item;
        });
    } catch (error) {
        console.error('Error enriching with ratings:', error);
        return items;
    }
};
