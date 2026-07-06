import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';

export const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';
    const hasCallingAccess = subscription && ['small_business', 'corporate'].includes(subscription.plan);

    res.status(200).json(
        new ApiResponse(200, {
            subscription,
            tier: subscriptionTier,
            isBusinessProfile,
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

export const getUpgradePrompt = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { feature = 'calling' } = req.query;

    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const currentTier = subscription ? subscription.plan : 'free';

    if (subscription && ['small_business', 'corporate'].includes(subscription.plan)) {
        return res.status(200).json(
            new ApiResponse(200, {
                requiresUpgrade: false,
                currentTier,
                hasAccess: true,
                message: 'You already have access to calling features'
            }, 'No upgrade required')
        );
    }

    const upgradePrompt = {
        requiresUpgrade: true,
        currentTier: 'free',
        hasAccess: false,
        feature,
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
                price: '₹1/month',
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

export const checkFeatureAccess = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { feature } = req.params;

    const user = await User.findById(userId);
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';

    let hasAccess = false;
    let requiredTier = null;

    switch (feature) {
        case 'calling':
        case 'audio_call':
        case 'video_call':
        case 'unlimited_posts':
        case 'advanced_analytics':
        case 'product_catalog':
            hasAccess = subscription && ['small_business', 'corporate'].includes(subscription.plan);
            requiredTier = hasAccess ? null : 'small_business';
            break;

        case 'api_access':
        case 'white_label':
        case 'dedicated_manager':
            hasAccess = subscription && subscription.plan === 'corporate';
            requiredTier = hasAccess ? null : 'corporate';
            break;

        default:
            throw new ApiError(400, 'Invalid feature specified');
    }

    res.status(200).json(
        new ApiResponse(200, {
            feature,
            hasAccess,
            currentTier: subscriptionTier,
            requiredTier,
            isBusinessProfile,
            requiresUpgrade: !hasAccess
        }, 'Feature access checked successfully')
    );
});
