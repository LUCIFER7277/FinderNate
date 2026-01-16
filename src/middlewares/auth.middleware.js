import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";
import { redisClient } from "../config/redis.config.js";

/**
 * Verify JWT and authenticate user
 * ✅ OPTIMIZED: Uses Redis caching to avoid DB lookups on every request
 */
export const verifyJWT = asyncHandler(async (req, _, next) => {
    try {
        let token;

        if (req.cookies?.accessToken) {
            token = req.cookies.accessToken;
        }

        else if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        if (!token) {
            throw new ApiError(401, "Unauthorized request");
        }

        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const userId = decodedToken?._id;

        // Try to get user from cache first
        const cacheKey = `auth:user:${userId}`;
        let user;

        try {
            const cachedUser = await redisClient.get(cacheKey);
            if (cachedUser) {
                user = JSON.parse(cachedUser);
            }
        } catch (cacheError) {
            console.error('Auth cache read error:', cacheError);
            // Continue to DB query if cache fails
        }

        // If not in cache, query database
        if (!user) {
            user = await User.findById(userId).select("-password -refreshToken").lean();

            if (!user) {
                throw new ApiError(401, "Invalid Access Token");
            }

            // Cache user data for 10 minutes
            try {
                await redisClient.setex(cacheKey, 600, JSON.stringify(user));
            } catch (cacheError) {
                console.error('Auth cache write error:', cacheError);
                // Continue without caching
            }
        }

        req.user = user;

        next();
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid access token");
    }
});

/**
 * Optional JWT verification - continues without error if no token or invalid token
 * ✅ OPTIMIZED: Uses Redis caching to avoid DB lookups
 */
export const optionalVerifyJWT = asyncHandler(async (req, _, next) => {
    try {
        let token;

        if (req.cookies?.accessToken) {
            token = req.cookies.accessToken;
        }
        else if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        // If no token is provided, continue without setting req.user
        if (!token) {
            return next();
        }

        // Try to verify the token
        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const userId = decodedToken?._id;

        // Try to get user from cache first
        const cacheKey = `auth:user:${userId}`;
        let user;

        try {
            const cachedUser = await redisClient.get(cacheKey);
            if (cachedUser) {
                user = JSON.parse(cachedUser);
            }
        } catch (cacheError) {
            // Continue to DB query if cache fails
        }

        // If not in cache, query database
        if (!user) {
            user = await User.findById(userId).select("-password -refreshToken").lean();

            // Cache user data for 10 minutes
            if (user) {
                try {
                    await redisClient.setex(cacheKey, 600, JSON.stringify(user));
                } catch (cacheError) {
                    // Continue without caching
                }
            }
        }

        // If user is found, set req.user
        if (user) {
            req.user = user;
        }

        next();
    } catch (error) {
        // If token verification fails, continue without setting req.user
        next();
    }
});

/**
 * Helper function to invalidate auth cache when user data changes
 * Call this when user profile is updated
 */
export const invalidateAuthCache = async (userId) => {
    try {
        const cacheKey = `auth:user:${userId}`;
        await redisClient.del(cacheKey);
    } catch (error) {
        console.error('Error invalidating auth cache:', error);
    }
};

