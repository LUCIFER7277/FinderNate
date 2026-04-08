import { asyncHandler } from '../utlis/asyncHandler.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';
import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
    verifyCashfreeWebhook,
} from '../config/cashfree.config.js';
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
        price: 1, // ₹999 per month
        duration: 'monthly'
    },
    corporate: {
        id: 'corporate',
        name: 'Corporate',
        price: 2999, // ₹2999 per month
        duration: 'monthly'
    }
};

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
            price: '₹1',
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
 * Create Cashfree order for subscription upgrade
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

    const cashfreeOrderId = generateCashfreeOrderId();
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://findernate.com';
    const BACKEND_URL = process.env.BACKEND_URL || 'https://api.findernate.com';

    try {
        const cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        planDetails.price,
            customerId:    userId.toString(),
            customerName:  user.fullName || user.username || 'Customer',
            customerEmail: user.email || 'noreply@findernate.com',
            customerPhone: user.phoneNumber || '9999999999',
            orderNote:     `FinderNate ${planDetails.name} Subscription`,
            returnUrl:     `${FRONTEND_URL}/subscription/success?txnId=${cashfreeOrderId}&plan=${plan}`,
            notifyUrl:     `${BACKEND_URL}/api/v1/subscription/webhook`,
            expiryMinutes: 20
        });

        const paymentSessionId = cfOrder?.payment_session_id;
        if (!paymentSessionId) {
            throw new Error('Failed to get payment session from Cashfree');
        }

        const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);

        PaymentLogger.logPaymentInitiated(userId.toString(), cashfreeOrderId, plan, planDetails.price);
        MetricsCollector.recordPaymentAttempt();

        res.status(200).json(
            new ApiResponse(200, {
                cashfreeOrderId,
                checkoutUrl,
                plan,
                planName: planDetails.name,
                planPrice: planDetails.price
            }, 'Cashfree payment initiated for subscription')
        );
    } catch (error) {
        console.error('❌ Cashfree subscription order creation failed:', error);
        ErrorLogger.logRazorpayError(userId.toString(), null, error);
        throw new ApiError(500, `Payment gateway error: ${error.message}`);
    }
});

/**
 * Verify Cashfree payment and activate subscription
 * Called from /subscription/success page after Cashfree redirect
 */
export const verifySubscriptionPayment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { cashfreeOrderId, plan } = req.body;

    if (!cashfreeOrderId || !plan) {
        throw new ApiError(400, 'Missing required fields: cashfreeOrderId and plan');
    }

    // Validate plan
    const validPaidPlans = ['small_business', 'corporate'];
    if (!validPaidPlans.includes(plan)) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    // Verify with Cashfree status API
    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch (error) {
        throw new ApiError(400, 'Failed to verify payment status with Cashfree');
    }

    const isSuccess = cfOrder?.order_status === 'PAID';

    // Fetch Cashfree payment ID
    let cfPaymentId = cashfreeOrderId;
    if (isSuccess) {
        try {
            const payments = await getCashfreePayments(cashfreeOrderId);
            const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
            if (paid?.cf_payment_id) {
                cfPaymentId = paid.cf_payment_id.toString();
            }
        } catch { /* non-critical */ }
    }

    PaymentLogger.logPaymentVerification(userId.toString(), cfPaymentId, cashfreeOrderId, isSuccess);

    if (!isSuccess) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
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
        subscription.paymentId = cfPaymentId;
        await subscription.save();
    } else {
        subscription = await Subscription.create({
            userId,
            plan,
            status: 'active',
            startDate: now,
            endDate: endDate,
            paymentId: cfPaymentId
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

    PaymentLogger.logPaymentSuccess(userId.toString(), cfPaymentId, cashfreeOrderId, plan, SUBSCRIPTION_PLANS[plan].price);
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
            paymentId: cfPaymentId
        }, 'Subscription activated successfully')
    );
});

/**
 * Cashfree webhook for subscription payments
 * Called asynchronously by Cashfree after payment completion
 */
export const subscriptionWebhook = asyncHandler(async (req, res) => {
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    const signature = req.headers['x-webhook-signature'] || '';
    const rawBody   = req.rawBody || JSON.stringify(req.body);

    if (timestamp && signature) {
        const isValid = verifyCashfreeWebhook(timestamp, signature, rawBody);
        if (!isValid) {
            console.error('❌ Invalid Cashfree subscription webhook signature');
            return res.status(200).json({ success: true }); // always 200 to Cashfree
        }
    }

    const payload       = req.body;
    const cfOrderId     = payload?.data?.order?.order_id;
    const orderStatus   = payload?.data?.order?.order_status;
    const cfPaymentId   = payload?.data?.payment?.cf_payment_id?.toString();
    const paymentStatus = payload?.data?.payment?.payment_status;

    if (orderStatus !== 'PAID' || paymentStatus !== 'SUCCESS' || !cfOrderId) {
        return res.status(200).json({ success: true });
    }

    // Subscription activation is handled by verifySubscriptionPayment on the success page.
    // Webhook just logs for audit.
    console.log(`✅ Subscription Cashfree webhook received: orderId=${cfOrderId}, cfPaymentId=${cfPaymentId}`);
    PaymentLogger.logPaymentSuccess('webhook', cfPaymentId || '', cfOrderId, 'subscription', payload?.data?.order?.order_amount || 0);

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
