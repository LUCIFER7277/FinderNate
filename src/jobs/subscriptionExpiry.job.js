import cron from 'node-cron';
import Subscription from '../models/subscription.models.js';
import Business from '../models/business.models.js';
import { User } from '../models/user.models.js';
import { FeedCacheManager } from '../utils/cache.utils.js';
import { redisClient } from '../config/redis.config.js';

/**
 * Subscription Expiry Cron Job
 * Runs every day at 2:00 AM to check and handle expired subscriptions
 *
 * Tasks:
 * 1. Find expired subscriptions
 * 2. Update subscription status to 'expired'
 * 3. Downgrade business profiles to plan1 (free)
 * 4. Update business subscriptionStatus to 'pending'
 * 5. Invalidate cache for affected users
 * 6. Send notifications (optional - can be added later)
 */

// Helper function to handle subscription expiry
export const handleExpiredSubscriptions = async () => {
    try {

        const now = new Date();

        // Find all expired subscriptions that are still marked as 'active'
        const expiredSubscriptions = await Subscription.find({
            status: 'active',
            endDate: { $lt: now }
        });

        if (expiredSubscriptions.length === 0) {
            return {
                success: true,
                expiredCount: 0,
                message: 'No expired subscriptions found'
            };
        }


        let successCount = 0;
        let failureCount = 0;

        // Process each expired subscription
        for (const subscription of expiredSubscriptions) {
            try {
                const userId = subscription.userId;

                // 1. Update subscription status to expired
                subscription.status = 'expired';
                await subscription.save();

                // 2. Downgrade business profile to free plan (no-op if no Business doc)
                await Business.updateOne(
                    { userId },
                    { $set: { plan: 'plan1', subscriptionStatus: 'pending' } }
                );

                // 3. Invalidate feed and profile caches (subscription badge changed on expiry)
                try {
                    const { UserCacheManager } = await import('../utils/cache.utils.js');
                    await Promise.allSettled([
                        UserCacheManager.invalidateUserProfile(userId.toString()),
                        FeedCacheManager.invalidateUserFeed(userId),
                        FeedCacheManager.invalidateExploreFeed(),
                        FeedCacheManager.invalidateTrendingFeed()
                    ]);

                    // Clear Redis feed cache
                    const feedKeys = await redisClient.keys(`fn:user:${userId}:feed:*`);
                    if (feedKeys.length > 0) {
                        await redisClient.del(...feedKeys);
                    }

                } catch (cacheError) {
                    console.error(`⚠️ Cache invalidation failed for user ${userId}:`, cacheError.message);
                    // Don't throw - cache invalidation failure shouldn't block the expiry process
                }

                // 4. TODO: Send notification to user about subscription expiry
                // You can implement email/push notification here

                successCount++;

            } catch (error) {
                failureCount++;
                console.error(`❌ Failed to process subscription for user ${subscription.userId}:`, error);
            }
        }

        const result = {
            success: true,
            expiredCount: expiredSubscriptions.length,
            successCount,
            failureCount,
            message: `Processed ${successCount} expired subscriptions successfully, ${failureCount} failures`
        };

        return result;

    } catch (error) {
        console.error('❌ Subscription expiry job failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Helper function to send subscription expiry reminders
 * Sends reminders 7 days, 3 days, and 1 day before expiry
 */
export const sendExpiryReminders = async () => {
    try {

        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        const threeDaysFromNow = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000));
        const oneDayFromNow = new Date(now.getTime() + (1 * 24 * 60 * 60 * 1000));

        // Find subscriptions expiring in 7, 3, or 1 day
        const upcomingExpiries = await Subscription.find({
            status: 'active',
            endDate: {
                $gte: now,
                $lte: sevenDaysFromNow
            }
        }).populate('userId', 'username email fullName');

        if (upcomingExpiries.length === 0) {
            return;
        }


        for (const subscription of upcomingExpiries) {
            const daysUntilExpiry = Math.ceil((subscription.endDate - now) / (1000 * 60 * 60 * 24));

            // Send reminder based on days remaining
            if (daysUntilExpiry === 7 || daysUntilExpiry === 3 || daysUntilExpiry === 1) {

                // TODO: Implement actual notification sending (email/push)
                // For now, just log it
            }
        }


    } catch (error) {
        console.error('❌ Failed to send expiry reminders:', error);
    }
};

/**
 * Start the cron job
 * Schedule: Every day at 2:00 AM
 */
export const startSubscriptionExpiryJob = () => {
    // Run every day at 2:00 AM (0 2 * * *)
    const expiryJob = cron.schedule('0 2 * * *', async () => {
        console.log('⏰ [Cron] Subscription expiry job triggered');
        await handleExpiredSubscriptions();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // Run reminder check every day at 10:00 AM (0 10 * * *)
    const reminderJob = cron.schedule('0 10 * * *', async () => {
        console.log('⏰ [Cron] Subscription reminder job triggered');
        await sendExpiryReminders();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('✅ [Cron] Subscription expiry job scheduled (daily at 2:00 AM IST)');
    console.log('✅ [Cron] Subscription reminder job scheduled (daily at 10:00 AM IST)');

    return { expiryJob, reminderJob };
};

// For testing purposes - run immediately
export const runExpiryCheckNow = async () => {
    return await handleExpiredSubscriptions();
};
