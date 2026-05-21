import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';
import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
    verifyCashfreeWebhook,
} from '../../config/cashfree.config.js';
import {
    PaymentLogger,
    SubscriptionLogger,
    ErrorLogger,
    MetricsCollector
} from '../../utils/monitoring.utils.js';
import { SUBSCRIPTION_PLANS } from './plans.js';

const PLAN_TO_BUSINESS_PLAN = {
    small_business: 'plan2',
    corporate: 'plan3'
};

const invalidateCaches = async (userId) => {
    const { FeedCacheManager, UserCacheManager } = await import('../../utils/cache.utils.js');
    await Promise.allSettled([
        UserCacheManager.invalidateUserProfile(userId.toString()),
        FeedCacheManager.invalidateUserFeed(userId),
        FeedCacheManager.invalidateExploreFeed(),
        FeedCacheManager.invalidateTrendingFeed()
    ]);
    const { redisClient } = await import('../../config/redis.config.js');
    const feedKeys = await redisClient.keys('fn:user:*:feed:*');
    if (feedKeys.length > 0) await redisClient.del(...feedKeys);
};

export const createSubscriptionOrder = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    const validPaidPlans = ['small_business', 'corporate'];
    if (!plan || !validPaidPlans.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${validPaidPlans.join(', ')}`);
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    if (!user.isBusinessProfile) {
        throw new ApiError(403, 'Only business accounts can purchase a subscription. Please create a business profile first.');
    }

    const Business = (await import('../../models/business.models.js')).default;
    const businessProfile = await Business.findOne({ userId });
    if (!businessProfile) {
        throw new ApiError(403, 'Business profile not found. Please complete your business profile setup before subscribing.');
    }

    const planDetails = SUBSCRIPTION_PLANS[plan];
    if (!planDetails) throw new ApiError(400, 'Invalid subscription plan');

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
        const cashfreeMode = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';

        PaymentLogger.logPaymentInitiated(userId.toString(), cashfreeOrderId, plan, planDetails.price);
        MetricsCollector.recordPaymentAttempt();

        res.status(200).json(
            new ApiResponse(200, {
                cashfreeOrderId,
                checkoutUrl,
                paymentSessionId,
                cashfreeMode,
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

export const verifySubscriptionPayment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { cashfreeOrderId, plan } = req.body;

    if (!cashfreeOrderId || !plan) {
        throw new ApiError(400, 'Missing required fields: cashfreeOrderId and plan');
    }

    const validPaidPlans = ['small_business', 'corporate'];
    if (!validPaidPlans.includes(plan)) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, 'Failed to verify payment status with Cashfree');
    }

    const isSuccess = cfOrder?.order_status === 'PAID';

    let cfPaymentId = cashfreeOrderId;
    if (isSuccess) {
        try {
            const payments = await getCashfreePayments(cashfreeOrderId);
            const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
            if (paid?.cf_payment_id) cfPaymentId = paid.cf_payment_id.toString();
        } catch { /* non-critical */ }
    }

    PaymentLogger.logPaymentVerification(userId.toString(), cfPaymentId, cashfreeOrderId, isSuccess);

    if (!isSuccess) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isBusinessProfile) throw new ApiError(403, 'Only business accounts can activate a subscription.');

    const now = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

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
            endDate,
            paymentId: cfPaymentId
        });
    }

    const Business = (await import('../../models/business.models.js')).default;
    const business = await Business.findOneAndUpdate(
        { userId },
        { $set: { plan: PLAN_TO_BUSINESS_PLAN[plan], subscriptionStatus: 'active', isVerified: true } },
        { upsert: true, new: true }
    );

    try {
        await invalidateCaches(userId);
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
            business: { plan: business.plan, subscriptionStatus: business.subscriptionStatus },
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

export const subscriptionWebhook = asyncHandler(async (req, res) => {
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    const signature = req.headers['x-webhook-signature'] || '';
    const rawBody   = req.rawBody || JSON.stringify(req.body);

    if (timestamp && signature) {
        const isValid = verifyCashfreeWebhook(timestamp, signature, rawBody);
        if (!isValid) {
            console.error('❌ Invalid Cashfree subscription webhook signature');
            return res.status(200).json({ success: true });
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
    PaymentLogger.logPaymentSuccess('webhook', cfPaymentId || '', cfOrderId, 'subscription', payload?.data?.order?.order_amount || 0);

    return res.status(200).json({ success: true });
});
