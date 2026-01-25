import { ApiError } from "./ApiError.js";
import { getCoordinates } from "./getCoordinates.js";

/**
 * Validates delivery options and location requirements for business posts
 * @param {Object} postData - Product, Service, or Business data
 * @param {string} postType - Type of post (product, service, business)
 * @returns {Object} Validated and potentially enhanced location data
 */
export const validateDeliveryAndLocation = async (postData, postType) => {
    if (!postData) {
        throw new ApiError(400, `${postType} data is required`);
    }

    const { deliveryOptions, location } = postData;

    // Validate delivery options
    if (!deliveryOptions) {
        throw new ApiError(400, "Delivery options (online/offline/both) are required");
    }

    if (!['online', 'offline', 'both'].includes(deliveryOptions)) {
        throw new ApiError(400, "Delivery options must be 'online', 'offline', or 'both'");
    }

    // If online only, no location validation needed
    if (deliveryOptions === 'online') {
        return postData;
    }

    // For offline or both, location is mandatory
    if (deliveryOptions === 'offline' || deliveryOptions === 'both') {
        if (!location) {
            throw new ApiError(400, `Location is mandatory when delivery option is '${deliveryOptions}'`);
        }

        // Check if basic location info is provided
        if (!location.name && !location.address) {
            throw new ApiError(400, "Location name or address is required for offline/both delivery options");
        }

        // If location name/address provided but no coordinates, resolve them
        if ((location.name || location.address) && !location.coordinates) {
            try {
                // Pass the full location object to allow multiple fallback strategies
                const coords = await getCoordinates(location);

                if (coords?.latitude && coords?.longitude) {
                    location.coordinates = {
                        type: "Point",
                        coordinates: [coords.longitude, coords.latitude]
                    };
                } else {
                    const locationQuery = location.address || location.name;
                    throw new ApiError(400, `Could not resolve coordinates for location: ${locationQuery}`);
                }
            } catch (error) {
                // If it's already an ApiError, re-throw it
                if (error instanceof ApiError) {
                    throw error;
                }
                // Otherwise, wrap it
                const locationQuery = location.address || location.name;
                throw new ApiError(400, `Could not resolve coordinates for location: ${locationQuery}`);
            }
        }

        // Ensure we have either name or address
        if (!location.name && !location.address) {
            throw new ApiError(400, "Location must include either name or address");
        }
    }

    return { ...postData, location };
};

/**
 * Validates location format for business posts
 * @param {Object} location - Location object
 * @returns {boolean} True if valid
 */
export const isValidLocation = (location) => {
    if (!location) return false;

    // Must have either name or address
    if (!location.name && !location.address) return false;

    // If coordinates exist, validate GeoJSON format
    if (location.coordinates) {
        if (location.coordinates.type !== 'Point') return false;
        if (!Array.isArray(location.coordinates.coordinates)) return false;
        if (location.coordinates.coordinates.length !== 2) return false;

        const [lng, lat] = location.coordinates.coordinates;
        if (typeof lng !== 'number' || typeof lat !== 'number') return false;
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
    }

    return true;
};

/**
 * Helper function to check if location is required based on delivery options
 * @param {string} deliveryOptions - online, offline, or both
 * @returns {boolean} True if location is required
 */
export const isLocationRequired = (deliveryOptions) => {
    return deliveryOptions === 'offline' || deliveryOptions === 'both';
};

/**
 * Sanitize and prepare location data for database storage
 * @param {Object} location - Raw location data
 * @returns {Object} Sanitized location data
 */
export const sanitizeLocationData = (location) => {
    if (!location) return null;

    const sanitized = {};

    // Copy allowed fields
    if (location.name) sanitized.name = location.name.trim();
    if (location.address) sanitized.address = location.address.trim();
    if (location.city) sanitized.city = location.city.trim();
    if (location.state) sanitized.state = location.state.trim();
    if (location.country) sanitized.country = location.country.trim();

    // Copy coordinates if valid
    if (location.coordinates && isValidLocation({ coordinates: location.coordinates })) {
        sanitized.coordinates = location.coordinates;
    }

    return sanitized;
};

export default {
    validateDeliveryAndLocation,
    isValidLocation,
    isLocationRequired,
    sanitizeLocationData
};