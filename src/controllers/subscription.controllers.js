import { asyncHandler } from '../utlis/asyncHandler.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';

/**
 * Get current user's subscription status
 */
export const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    // Get the full user object to check business profile status
    const user = await User.findById(userId);

    // Check if user is a business profile (only true if businessProfileId exists)
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    // Get active subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';

    // Calling access rules:
    // 1. Business profiles with active subscription (small_business or corporate)
    // 2. Normal users with paid subscription
    const hasCallingAccess = (subscription && ['small_business', 'corporate'].includes(subscription.plan));

    res.status(200).json(
        new ApiResponse(200, {
            subscription: subscription,
            tier: subscriptionTier,
            isBusinessProfile: isBusinessProfile,
            features: {
                calling: {
                    hasAccess: hasCallingAccess,
                    audioCall: hasCallingAccess,
                    videoCall: hasCallingAccess,
                    unlimited: hasCallingAccess
                }
            }
        }, 'Subscription status fetched successfully')
    );
});

/**
 * Get upgrade prompt information for calling features
 * This endpoint is called when free users try to access calling features
 */
export const getUpgradePrompt = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { feature = 'calling' } = req.query;

    // Check current subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const currentTier = subscription ? subscription.plan : 'free';

    // If user already has access, no upgrade needed
    if (subscription && ['small_business', 'corporate'].includes(subscription.plan)) {
        return res.status(200).json(
            new ApiResponse(200, {
                requiresUpgrade: false,
                currentTier: currentTier,
                hasAccess: true,
                message: 'You already have access to calling features'
            }, 'No upgrade required')
        );
    }

    // Build upgrade prompt for free users
    const upgradePrompt = {
        requiresUpgrade: true,
        currentTier: 'free',
        hasAccess: false,
        feature: feature,
        title: 'Upgrade to unlock calling features',
        message: 'Audio and video calls are available for paid subscribers. Choose a plan to start calling your connections.',
        benefits: [
            'Unlimited audio calls',
            'Unlimited video calls',
            'High-quality voice and video',
            'Group calling (coming soon)'
        ],
        availablePlans: [
            {
                id: 'small_business',
                name: 'Small Business',
                price: '₹999/month',
                features: [
                    'Enhanced business profile',
                    'Unlimited posts',
                    'Advanced analytics',
                    'Product catalog (up to 50 items)',
                    'Priority support',
                    'Basic advertising tools'
                ],
                recommended: true
            },
            {
                id: 'corporate',
                name: 'Corporate',
                price: '₹2999/month',
                features: [
                    'Premium business profile',
                    'Unlimited everything',
                    'Advanced analytics & insights',
                    'Unlimited product catalog',
                    'Dedicated account manager',
                    'Advanced advertising & promotion',
                    'API access',
                    'White-label options'
                ],
                recommended: false
            }
        ],
        ctaText: 'Upgrade Now',
        ctaUrl: '/subscription/upgrade'
    };

    res.status(200).json(
        new ApiResponse(200, upgradePrompt, 'Upgrade prompt generated successfully')
    );
});

/**
 * Check if user has access to a specific feature
 */
export const checkFeatureAccess = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { feature } = req.params;

    // Get the full user object
    const user = await User.findById(userId);
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    // Get active subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';

    let hasAccess = false;
    let requiredTier = null;

    // Check feature access based on subscription tier
    switch (feature) {
        case 'calling':
        case 'audio_call':
        case 'video_call':
            hasAccess = (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'unlimited_posts':
            hasAccess = (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'advanced_analytics':
            hasAccess = (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'product_catalog':
            hasAccess = (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'api_access':
        case 'white_label':
        case 'dedicated_manager':
            hasAccess = (subscription && subscription.plan === 'corporate');
            requiredTier = hasAccess ? null : 'corporate';
            break;

        default:
            throw new ApiError(400, 'Invalid feature specified');
    }

    res.status(200).json(
        new ApiResponse(200, {
            feature: feature,
            hasAccess: hasAccess,
            currentTier: subscriptionTier,
            requiredTier: requiredTier,
            isBusinessProfile: isBusinessProfile,
            requiresUpgrade: !hasAccess
        }, 'Feature access checked successfully')
    );
});

/**
 * Get all available subscription plans
 */
export const getAvailablePlans = asyncHandler(async (req, res) => {
    const plans = [
        {
            id: 'free',
            name: 'Free',
            price: '₹0',
            period: 'Forever',
            features: [
                'Basic business profile',
                'Up to 10 posts per month',
                'Basic analytics',
                'Community support'
            ],
            limitations: [
                'Limited posts',
                'Basic features only',
                'No priority support'
            ],
            isCurrentPlan: true
        },
        {
            id: 'small_business',
            name: 'Small Business',
            price: '₹999',
            period: 'per month',
            features: [
                'Enhanced business profile',
                'Unlimited posts',
                'Advanced analytics',
                'Product catalog (up to 50 items)',
                'Priority support',
                'Basic advertising tools'
            ],
            recommended: true
        },
        {
            id: 'corporate',
            name: 'Corporate',
            price: '₹2999',
            period: 'per month',
            features: [
                'Premium business profile',
                'Unlimited everything',
                'Advanced analytics & insights',
                'Unlimited product catalog',
                'Dedicated account manager',
                'Advanced advertising & promotion',
                'API access',
                'White-label options'
            ],
            recommended: false
        }
    ];

    res.status(200).json(
        new ApiResponse(200, { plans }, 'Available plans fetched successfully')
    );
});

/**
 * TEST ONLY: Simulate subscription upgrade without payment
 * This endpoint is for testing purposes until payment integration is complete
 * It creates/updates a subscription record with active status
 */
export const testUpgradeSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    // Debug logging
    console.log('=== TEST UPGRADE DEBUG ===');
    console.log('Request body:', req.body);
    console.log('Plan received:', plan);
    console.log('Plan type:', typeof plan);
    console.log('========================');

    // Valid plan options for testing
    const validPlans = ['free', 'small_business', 'corporate'];

    if (!plan || !validPlans.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${validPlans.join(', ')}`);
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // Map subscription plan names to business plan names
    const planMapping = {
        'free': 'plan1',
        'small_business': 'plan2',
        'corporate': 'plan3'
    };

    // Find existing subscription or create new one
    let subscription = await Subscription.findOne({ userId });

    const now = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // 1 month from now

    // Handle free plan differently - delete subscription record for free users
    if (plan === 'free') {
        if (subscription) {
            // Delete existing subscription when downgrading to free
            await Subscription.deleteOne({ userId });
            subscription = null;
        }
        // Free users don't have a subscription record
    } else {
        // Handle paid plans (small_business, corporate)
        if (subscription) {
            // Update existing subscription
            subscription.plan = plan;
            subscription.status = 'active';
            subscription.startDate = now;
            subscription.endDate = endDate;
            await subscription.save();
        } else {
            // Create new subscription
            subscription = await Subscription.create({
                userId: userId,
                plan: plan,
                status: 'active',
                startDate: now,
                endDate: endDate
            });
        }
    }

    // IMPORTANT: Also update Business model if user has a business profile
    // The home feed checks Business model for post visibility
    const Business = (await import('../models/business.models.js')).default;
    const business = await Business.findOne({ userId });

    if (business) {
        business.plan = planMapping[plan];
        business.subscriptionStatus = plan === 'free' ? 'inactive' : 'active';
        await business.save();
        console.log(`✅ Updated Business model: plan=${business.plan}, status=${business.subscriptionStatus}`);
    }

    // ✅ CRITICAL: Invalidate all feed caches when subscription changes
    // This ensures business posts appear/disappear immediately based on payment status
    try {
        const { FeedCacheManager } = await import('../utlis/cache.utils.js');

        // Invalidate all feed types since business post visibility affects them all
        await Promise.allSettled([
            FeedCacheManager.invalidateUserFeed(userId),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed()
        ]);

        // Also invalidate Redis cache patterns for home feeds
        const { redisClient } = await import('../config/redis.config.js');
        const feedKeys = await redisClient.keys('fn:user:*:feed:*');
        if (feedKeys.length > 0) {
            await redisClient.del(...feedKeys);
        }

        console.log(`✅ Cache invalidated for user ${userId} after subscription change`);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
        // Don't throw - cache invalidation failure shouldn't block subscription update
    }

    // Get updated subscription status
    const hasCallingAccess = plan !== 'free';

    res.status(200).json(
        new ApiResponse(200, {
            subscription: subscription, // Will be null for free plan
            business: business ? { plan: business.plan, subscriptionStatus: business.subscriptionStatus } : null,
            tier: plan,
            hasCallingAccess: hasCallingAccess,
            message: plan === 'free'
                ? 'Successfully downgraded to free plan. Subscription record removed.'
                : `Successfully upgraded to ${plan} plan (TEST MODE - No payment required)`,
            note: 'This is a test endpoint. In production, payment will be required.'
        }, 'Subscription updated successfully (TEST MODE)')
    );
});
