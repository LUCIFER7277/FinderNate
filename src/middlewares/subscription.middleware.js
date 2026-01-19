import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { User } from "../models/user.models.js";
import Subscription from "../models/subscription.models.js";

/**
 * Middleware to verify user has calling features access
 * Free users are blocked from audio and video calls
 * Paid users (basic, pro, premium, business) and business profiles have access
 */
export const verifyCallingAccess = asyncHandler(async (req, res, next) => {
    try {
        const userId = req.user._id;

        // Check if user is a business profile (they have calling access)
        if (req.user.isBusinessProfile) {
            req.user.subscriptionTier = 'business';
            return next();
        }

        // Check user subscription
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        const subscriptionTier = subscription ? subscription.plan : 'free';
        req.user.subscriptionTier = subscriptionTier;

        // Free users don't have calling access
        if (subscriptionTier === 'free') {
            throw new ApiError(403, "Calling features are not available for free users. Please upgrade your subscription to access audio and video calls.", {
                errorCode: 'CALLING_FEATURE_RESTRICTED',
                subscriptionTier: 'free',
                requiresUpgrade: true,
                availablePlans: ['basic', 'pro', 'premium', 'business']
            });
        }

        // All other paid plans have calling access
        next();
    } catch (error) {
        // If error is already an ApiError, throw it
        if (error instanceof ApiError) {
            throw error;
        }
        // Otherwise, throw a generic error
        throw new ApiError(500, "Error verifying calling access");
    }
});

/**
 * Middleware to check subscription tier and attach to request
 * This doesn't block the request, just adds subscription info
 */
export const attachSubscriptionInfo = asyncHandler(async (req, res, next) => {
    try {
        const userId = req.user._id;

        // Check if user is a business profile
        if (req.user.isBusinessProfile) {
            req.user.subscriptionTier = 'business';
            req.user.hasCallingAccess = true;
            return next();
        }

        // Check user subscription
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        const subscriptionTier = subscription ? subscription.plan : 'free';
        req.user.subscriptionTier = subscriptionTier;
        req.user.hasCallingAccess = subscriptionTier !== 'free';

        next();
    } catch (error) {
        console.error('Error attaching subscription info:', error);
        // Continue even if there's an error - just set defaults
        req.user.subscriptionTier = 'free';
        req.user.hasCallingAccess = false;
        next();
    }
});

/**
 * Helper function to get user subscription details
 */
export const getUserSubscription = async (userId) => {
    try {
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        return {
            tier: subscription ? subscription.plan : 'free',
            hasActiveSubscription: !!subscription,
            subscription: subscription,
            hasCallingAccess: subscription && subscription.plan !== 'free'
        };
    } catch (error) {
        console.error('Error getting user subscription:', error);
        return {
            tier: 'free',
            hasActiveSubscription: false,
            subscription: null,
            hasCallingAccess: false
        };
    }
};
