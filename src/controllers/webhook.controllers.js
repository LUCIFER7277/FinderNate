import crypto from 'crypto';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import Subscription from '../models/subscription.models.js';
import Business from '../models/business.models.js';
import { User } from '../models/user.models.js';
import { FeedCacheManager } from '../utils/cache.utils.js';
import { redisClient } from '../config/redis.config.js';

/**
 * Razorpay Webhook Handler
 * Handles payment events from Razorpay asynchronously
 *
 * Supported Events:
 * - payment.captured - Payment successful
 * - payment.failed - Payment failed
 * - order.paid - Order marked as paid
 * - subscription.cancelled - Subscription cancelled
 * - subscription.charged - Subscription charged successfully
 *
 * Webhook URL: https://yourdomain.com/api/v1/webhooks/razorpay
 */

// Verify Razorpay webhook signature
const verifyWebhookSignature = (webhookBody, signature, secret) => {
    try {
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(webhookBody))
            .digest('hex');

        return expectedSignature === signature;
    } catch (error) {
        console.error('❌ Webhook signature verification failed:', error);
        return false;
    }
};

/**
 * Main Razorpay Webhook Handler
 * POST /api/v1/webhooks/razorpay
 */
export const handleRazorpayWebhook = asyncHandler(async (req, res) => {
    try {
        // Get webhook signature from headers
        const webhookSignature = req.headers['x-razorpay-signature'];

        if (!webhookSignature) {
            console.error('❌ Webhook signature missing');
            // Return 200 to acknowledge receipt even if signature is missing
            // This prevents Razorpay from retrying
            return res.status(200).json({ received: true, error: 'Missing signature' });
        }

        // Verify webhook signature
        const isValid = verifyWebhookSignature(
            req.body,
            webhookSignature,
            process.env.RAZORPAY_WEBHOOK_SECRET
        );

        if (!isValid) {
            console.error('❌ Invalid webhook signature');
            // Log the attempt for security monitoring
            console.error('Invalid webhook attempt from IP:', req.ip);
            return res.status(200).json({ received: true, error: 'Invalid signature' });
        }

        const event = req.body.event;
        const payload = req.body.payload;


        // Route to appropriate handler based on event type
        switch (event) {
            case 'payment.captured':
                await handlePaymentCaptured(payload);
                break;

            case 'payment.failed':
                await handlePaymentFailed(payload);
                break;

            case 'order.paid':
                await handleOrderPaid(payload);
                break;

            case 'payment.authorized':
                await handlePaymentAuthorized(payload);
                break;

            case 'subscription.cancelled':
                await handleSubscriptionCancelled(payload);
                break;

            default:
        }

        // Always return 200 to acknowledge receipt
        res.status(200).json(
            new ApiResponse(200, { received: true }, 'Webhook processed successfully')
        );

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        // Still return 200 to prevent Razorpay retries for server errors
        res.status(200).json({ received: true, error: error.message });
    }
});

/**
 * Handle payment.captured event
 * This event is triggered when a payment is successfully captured
 */
const handlePaymentCaptured = async (payload) => {
    try {
        const payment = payload.payment.entity;
        const orderId = payment.order_id;
        const paymentId = payment.id;
        const amount = payment.amount; // Amount in paise
        const notes = payment.notes || {};


        // Extract user and plan information from notes
        const userId = notes.userId;
        const plan = notes.plan;

        if (!userId || !plan) {
            console.error('❌ Missing userId or plan in payment notes');
            return;
        }

        // Check if this payment has already been processed
        const existingSubscription = await Subscription.findOne({ paymentId });
        if (existingSubscription) {
            return;
        }

        // Calculate subscription dates
        const now = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1); // 1 month from now

        // Create or update subscription
        let subscription = await Subscription.findOne({ userId });

        if (subscription) {
            subscription.plan = plan;
            subscription.status = 'active';
            subscription.startDate = now;
            subscription.endDate = endDate;
            subscription.paymentId = paymentId;
            await subscription.save();
        } else {
            subscription = await Subscription.create({
                userId,
                plan,
                status: 'active',
                startDate: now,
                endDate,
                paymentId
            });
        }

        // Update Business model
        const planMapping = {
            'small_business': 'plan2',
            'corporate': 'plan3'
        };

        const business = await Business.findOne({ userId });
        if (business) {
            business.plan = planMapping[plan];
            business.subscriptionStatus = 'active';
            await business.save();
        }

        // Invalidate cache
        await invalidateUserCache(userId);


    } catch (error) {
        console.error('❌ Error handling payment.captured:', error);
    }
};

/**
 * Handle payment.failed event
 */
const handlePaymentFailed = async (payload) => {
    try {
        const payment = payload.payment.entity;
        const orderId = payment.order_id;
        const paymentId = payment.id;
        const errorCode = payment.error_code;
        const errorDescription = payment.error_description;


        // Log failed payment for monitoring
        // TODO: Send notification to user about payment failure
        // TODO: Store failed payment attempts for analytics

    } catch (error) {
        console.error('❌ Error handling payment.failed:', error);
    }
};

/**
 * Handle order.paid event
 */
const handleOrderPaid = async (payload) => {
    try {
        const order = payload.order.entity;
        const orderId = order.id;
        const notes = order.notes || {};


        // This event is similar to payment.captured
        // You can add additional order-level logic here if needed

    } catch (error) {
        console.error('❌ Error handling order.paid:', error);
    }
};

/**
 * Handle payment.authorized event
 * This event is triggered before payment is captured
 */
const handlePaymentAuthorized = async (payload) => {
    try {
        const payment = payload.payment.entity;
        const paymentId = payment.id;


        // Payment is authorized but not yet captured
        // No action needed, wait for payment.captured event

    } catch (error) {
        console.error('❌ Error handling payment.authorized:', error);
    }
};

/**
 * Handle subscription.cancelled event
 * This event is triggered when a subscription is cancelled
 */
const handleSubscriptionCancelled = async (payload) => {
    try {
        const subscription = payload.subscription.entity;
        const subscriptionId = subscription.id;
        const notes = subscription.notes || {};


        const userId = notes.userId;
        if (!userId) {
            console.error('❌ Missing userId in subscription notes');
            return;
        }

        // Update subscription status
        const userSubscription = await Subscription.findOne({ userId });
        if (userSubscription) {
            userSubscription.status = 'cancelled';
            userSubscription.autoRenew = false;
            await userSubscription.save();

        }

        // Downgrade business profile
        const business = await Business.findOne({ userId });
        if (business) {
            business.plan = 'plan1';
            business.subscriptionStatus = 'pending';
            await business.save();
        }

        // Invalidate cache
        await invalidateUserCache(userId);

    } catch (error) {
        console.error('❌ Error handling subscription.cancelled:', error);
    }
};

/**
 * Helper function to invalidate user cache
 */
const invalidateUserCache = async (userId) => {
    try {
        await Promise.allSettled([
            FeedCacheManager.invalidateUserFeed(userId),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed()
        ]);

        const feedKeys = await redisClient.keys(`fn:user:${userId}:feed:*`);
        if (feedKeys.length > 0) {
            await redisClient.del(...feedKeys);
        }

    } catch (error) {
        console.error('⚠️ Cache invalidation failed:', error.message);
    }
};

/**
 * Test endpoint to verify webhook configuration
 * GET /api/v1/webhooks/test
 */
export const testWebhook = asyncHandler(async (req, res) => {
    res.status(200).json(
        new ApiResponse(200, {
            message: 'Webhook endpoint is active',
            webhookUrl: `${req.protocol}://${req.get('host')}/api/v1/webhooks/razorpay`,
            supportedEvents: [
                'payment.captured',
                'payment.failed',
                'order.paid',
                'payment.authorized',
                'subscription.cancelled'
            ]
        }, 'Webhook test successful')
    );
});

/**
 * Get webhook logs (for admin/debugging)
 * This is a placeholder - implement actual logging as needed
 * GET /api/v1/webhooks/logs
 */
export const getWebhookLogs = asyncHandler(async (req, res) => {
    // TODO: Implement actual webhook logging system
    res.status(200).json(
        new ApiResponse(200, {
            message: 'Webhook logging not yet implemented',
            note: 'Check server logs for webhook events'
        }, 'Webhook logs endpoint')
    );
});
