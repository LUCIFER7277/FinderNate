import { asyncHandler } from '../utlis/asyncHandler.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';
import razorpay from '../config/razorpay.config.js';
import crypto from 'crypto';
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

// Helper function to convert rupees to paise (Razorpay requires amount in paise: 1 INR = 100 paise)
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
 * Create Razorpay order for subscription upgrade
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

    // Check if user already has an active subscription
    const existingSubscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    // Get plan details
    const planDetails = SUBSCRIPTION_PLANS[plan];
    if (!planDetails) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    // Verify Razorpay configuration
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        console.error('❌ Razorpay credentials missing!');
        throw new ApiError(500, 'Payment gateway not configured. Please contact support.');
    }

    try {
        // Create Razorpay order
        // Generate a short receipt ID (max 40 chars for Razorpay)
        const shortReceipt = `sub_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`.substring(0, 40);

        const razorpayOrder = await razorpay.orders.create({
            amount: convertToPaise(planDetails.price), // Convert ₹999 to 99900 paise
            currency: 'INR',
            receipt: shortReceipt,
            notes: {
                userId: userId.toString(),
                plan: plan,
                planName: planDetails.name,
                type: 'subscription_upgrade',
                existingPlan: existingSubscription?.plan || 'free'
            }
        });

        // Log payment initiation
        PaymentLogger.logPaymentInitiated(userId.toString(), razorpayOrder.id, plan, planDetails.price);
        MetricsCollector.recordPaymentAttempt();

        res.status(200).json(
            new ApiResponse(200, {
                razorpayOrderId: razorpayOrder.id,
                razorpayKeyId: process.env.RAZORPAY_KEY_ID,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                plan: plan,
                planName: planDetails.name,
                planPrice: planDetails.price
            }, 'Razorpay order created for subscription')
        );
    } catch (razorpayError) {
        console.error('❌ Razorpay order creation failed:', razorpayError);
        console.error('Error details:', razorpayError.error || razorpayError.message);

        // Log error
        ErrorLogger.logRazorpayError(userId.toString(), null, razorpayError);

        throw new ApiError(500, `Payment gateway error: ${razorpayError.error?.description || razorpayError.message}`);
    }
});

/**
 * Verify Razorpay payment and activate subscription
 * Called after successful payment on frontend
 */
export const verifySubscriptionPayment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    // Validate required fields
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !plan) {
        throw new ApiError(400, 'Missing required payment verification fields');
    }

    // Verify Razorpay signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    // Log verification attempt
    PaymentLogger.logPaymentVerification(userId.toString(), razorpay_payment_id, razorpay_order_id, isValid);

    if (!isValid) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, "Invalid payment signature");
    }

    // Validate plan
    const validPaidPlans = ['small_business', 'corporate'];
    if (!validPaidPlans.includes(plan)) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // Map subscription plan names to business plan names
    const planMapping = {
        'small_business': 'plan2',
        'corporate': 'plan3'
    };

    // Calculate subscription dates
    const now = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // 1 month from now

    // Find existing subscription or create new one
    let subscription = await Subscription.findOne({ userId });

    if (subscription) {
        // Update existing subscription
        subscription.plan = plan;
        subscription.status = 'active';
        subscription.startDate = now;
        subscription.endDate = endDate;
        subscription.paymentId = razorpay_payment_id;
        await subscription.save();
    } else {
        // Create new subscription
        subscription = await Subscription.create({
            userId: userId,
            plan: plan,
            status: 'active',
            startDate: now,
            endDate: endDate,
            paymentId: razorpay_payment_id
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

    // Invalidate all feed caches when subscription changes
    try {
        const { FeedCacheManager } = await import('../utlis/cache.utils.js');

        await Promise.allSettled([
            FeedCacheManager.invalidateUserFeed(userId),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed()
        ]);

        const { redisClient } = await import('../config/redis.config.js');
        const feedKeys = await redisClient.keys('fn:user:*:feed:*');
        if (feedKeys.length > 0) {
            await redisClient.del(...feedKeys);
        }

        console.log(`✅ Cache invalidated for user ${userId} after subscription upgrade`);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    // Get subscription status with features
    const hasCallingAccess = ['small_business', 'corporate'].includes(plan);

    // Log successful payment and subscription creation
    PaymentLogger.logPaymentSuccess(userId.toString(), razorpay_payment_id, razorpay_order_id, plan, SUBSCRIPTION_PLANS[plan].price);
    SubscriptionLogger.logSubscriptionCreated(userId.toString(), plan, subscription.startDate, subscription.endDate);
    MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[plan].price, plan);

    res.status(200).json(
        new ApiResponse(200, {
            subscription: subscription,
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
            paymentId: razorpay_payment_id
        }, 'Subscription activated successfully')
    );
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
