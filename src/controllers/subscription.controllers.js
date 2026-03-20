import { asyncHandler } from '../utlis/asyncHandler.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';
import {
    initiatePhonePePayment,
    checkPhonePePaymentStatus,
    generateMerchantTransactionId
} from '../config/phonepe.config.js';
import {
    PaymentLogger,
    SubscriptionLogger,
    ErrorLogger,
    MetricsCollector
} from '../utlis/monitoring.utils.js';

// Subscription pricing configuration (in INR)
const SUBSCRIPTION_PLANS = {
    free: {
        id: 'free',
        name: 'Free',
        price: 0, // ₹0
        duration: 'lifetime'
    },
    small_business: {
        id: 'small_business',
        name: 'Small Business',
        price: 999, // ₹999 per month
        duration: 'monthly'
    },
    corporate: {
        id: 'corporate',
        name: 'Corporate',
        price: 2999, // ₹2999 per month
        duration: 'monthly'
    }
};

// PhonePe requires amount in paise (1 INR = 100 paise)
const convertToPaise = (rupees) => rupees * 100;

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
 * Create PhonePe order for subscription upgrade
 * This initiates the payment flow for upgrading to a paid plan
 */
export const createSubscriptionOrder = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    // Validate plan
    const validPaidPlans = ['small_business', 'corporate'];
    if (!plan || !validPaidPlans.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${validPaidPlans.join(', ')}`);
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // Get plan details
    const planDetails = SUBSCRIPTION_PLANS[plan];
    if (!planDetails) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    const merchantTransactionId = generateMerchantTransactionId();
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://findernate.com';
    const BACKEND_URL = process.env.BACKEND_URL || 'https://api.findernate.com';

    try {
        const paymentData = {
            merchantOrderId: merchantTransactionId,
            amount: convertToPaise(planDetails.price),
            expireAfter: 1200,
            paymentFlow: {
                type: 'PG_CHECKOUT',
                message: `FinderNate ${planDetails.name} Subscription`,
                merchantUrls: {
                    redirectUrl: `${FRONTEND_URL}/subscription/success?txnId=${merchantTransactionId}&plan=${plan}`
                }
            }
        };

        const phonePeResponse = await initiatePhonePePayment(paymentData);

        if (!phonePeResponse?.redirectUrl) {
            throw new Error(phonePeResponse?.message || 'Failed to get PhonePe redirect URL');
        }

        const phonePeRedirectUrl = phonePeResponse.redirectUrl;

        PaymentLogger.logPaymentInitiated(userId.toString(), merchantTransactionId, plan, planDetails.price);
        MetricsCollector.recordPaymentAttempt();

        res.status(200).json(
            new ApiResponse(200, {
                merchantTransactionId,
                phonePeRedirectUrl,
                plan,
                planName: planDetails.name,
                planPrice: planDetails.price
            }, 'PhonePe payment initiated for subscription')
        );
    } catch (error) {
        console.error('❌ PhonePe subscription order creation failed:', error);
        ErrorLogger.logRazorpayError(userId.toString(), null, error);
        throw new ApiError(500, `Payment gateway error: ${error.message}`);
    }
});

/**
 * Verify PhonePe payment and activate subscription
 * Called from /subscription/success page after PhonePe redirect
 */
export const verifySubscriptionPayment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { merchantTransactionId, plan } = req.body;

    if (!merchantTransactionId || !plan) {
        throw new ApiError(400, 'Missing required fields: merchantTransactionId and plan');
    }

    // Validate plan
    const validPaidPlans = ['small_business', 'corporate'];
    if (!validPaidPlans.includes(plan)) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    // Verify with PhonePe status API
    let statusResponse;
    try {
        statusResponse = await checkPhonePePaymentStatus(merchantTransactionId);
    } catch (error) {
        throw new ApiError(400, 'Failed to verify payment status with PhonePe');
    }

    const isSuccess = statusResponse?.state === 'COMPLETED';
    const phonePeTransactionId = statusResponse?.transactionId || merchantTransactionId;

    PaymentLogger.logPaymentVerification(userId.toString(), phonePeTransactionId, merchantTransactionId, isSuccess);

    if (!isSuccess) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Payment not completed: ${statusResponse?.message || 'Unknown error'}`);
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    const planMapping = {
        'small_business': 'plan2',
        'corporate': 'plan3'
    };

    const now = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    // Upsert subscription
    let subscription = await Subscription.findOne({ userId });

    if (subscription) {
        subscription.plan = plan;
        subscription.status = 'active';
        subscription.startDate = now;
        subscription.endDate = endDate;
        subscription.paymentId = phonePeTransactionId;
        await subscription.save();
    } else {
        subscription = await Subscription.create({
            userId,
            plan,
            status: 'active',
            startDate: now,
            endDate: endDate,
            paymentId: phonePeTransactionId
        });
    }

    // Update Business model if user has a business profile
    const Business = (await import('../models/business.models.js')).default;
    const business = await Business.findOne({ userId });

    if (business) {
        business.plan = planMapping[plan];
        business.subscriptionStatus = 'active';
        await business.save();
        console.log(`✅ Updated Business model: plan=${business.plan}, status=${business.subscriptionStatus}`);
    }

    // Invalidate feed caches
    try {
        const { FeedCacheManager } = await import('../utlis/cache.utils.js');
        await Promise.allSettled([
            FeedCacheManager.invalidateUserFeed(userId),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed()
        ]);
        const { redisClient } = await import('../config/redis.config.js');
        const feedKeys = await redisClient.keys('fn:user:*:feed:*');
        if (feedKeys.length > 0) await redisClient.del(...feedKeys);
        console.log(`✅ Cache invalidated for user ${userId} after subscription upgrade`);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    const hasCallingAccess = ['small_business', 'corporate'].includes(plan);

    PaymentLogger.logPaymentSuccess(userId.toString(), phonePeTransactionId, merchantTransactionId, plan, SUBSCRIPTION_PLANS[plan].price);
    SubscriptionLogger.logSubscriptionCreated(userId.toString(), plan, subscription.startDate, subscription.endDate);
    MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[plan].price, plan);

    res.status(200).json(
        new ApiResponse(200, {
            subscription,
            business: business ? { plan: business.plan, subscriptionStatus: business.subscriptionStatus } : null,
            tier: plan,
            features: {
                calling: {
                    hasAccess: hasCallingAccess,
                    audioCall: hasCallingAccess,
                    videoCall: hasCallingAccess,
                    unlimited: hasCallingAccess
                }
            },
            message: `Successfully upgraded to ${SUBSCRIPTION_PLANS[plan].name} plan!`,
            paymentId: phonePeTransactionId
        }, 'Subscription activated successfully')
    );
});

/**
 * PhonePe webhook for subscription payments
 * Called asynchronously by PhonePe after payment completion
 */
export const subscriptionWebhook = asyncHandler(async (req, res) => {
    // v2: Authorization: SHA256(username:password)
    const authHeader = req.headers['authorization'] || '';
    if (authHeader) {
        const { verifyPhonePeWebhookSignature } = await import('../config/phonepe.config.js');
        const isValid = verifyPhonePeWebhookSignature(authHeader);
        if (!isValid) {
            console.error('❌ Invalid PhonePe subscription webhook signature');
            return res.status(200).json({ success: true }); // always 200 to PhonePe
        }
    }

    // v2 body is plain JSON
    const payload = req.body;
    const state   = payload?.state;
    const merchantTransactionId = payload?.merchantOrderId || payload?.merchantTransactionId;

    if (state !== 'COMPLETED' || !merchantTransactionId) {
        return res.status(200).json({ success: true });
    }

    // Subscription activation is handled by verifySubscriptionPayment on the success page.
    // Webhook just logs for audit.
    console.log(`✅ Subscription PhonePe webhook received: txn=${merchantTransactionId}, amount=${payload.amount}`);
    PaymentLogger.logPaymentSuccess('webhook', payload.transactionId || '', merchantTransactionId, 'subscription', payload.amount / 100);

    return res.status(200).json({ success: true });
});

/**
 * @deprecated - TEST ONLY: Simulate subscription upgrade without payment
 * This endpoint is for testing purposes only and should not be used in production
 * Use createSubscriptionOrder + verifySubscriptionPayment instead
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
        business.subscriptionStatus = plan === 'free' ? 'pending' : 'active';
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
