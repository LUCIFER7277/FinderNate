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

    // Check if user is a business profile
    const isBusinessProfile = req.user.isBusinessProfile;

    // Get active subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';
    const hasCallingAccess = isBusinessProfile || (subscription && subscription.plan !== 'free');

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
    const isBusinessProfile = req.user.isBusinessProfile;

    // If user already has access, no upgrade needed
    if (isBusinessProfile || (subscription && subscription.plan !== 'free')) {
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

    const isBusinessProfile = req.user.isBusinessProfile;

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
            hasAccess = isBusinessProfile || (subscription && subscription.plan !== 'free');
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'unlimited_posts':
            hasAccess = isBusinessProfile || (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'advanced_analytics':
            hasAccess = isBusinessProfile || (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'product_catalog':
            hasAccess = isBusinessProfile || (subscription && ['small_business', 'corporate'].includes(subscription.plan));
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'api_access':
        case 'white_label':
        case 'dedicated_manager':
            hasAccess = isBusinessProfile || (subscription && subscription.plan === 'corporate');
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
