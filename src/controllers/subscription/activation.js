// ─────────────────────────────────────────────────────────────────────────────
// Everything an activation path shares, whichever gateway paid for it.
//
// This module exists because of the Razorpay lesson recorded in payment.js: a
// second activation path once held a verbatim copy of the renewal arithmetic,
// the two copies drifted, and only one of them ever got the month-overflow fix.
// Google Play Billing is that second path arriving again, so the shared parts
// live here and both callers import them rather than copying them.
//
// What is NOT here: deciding which plan was bought, checking that the money
// actually arrived, and attributing the payment to an account. Those are
// gateway-specific — Cashfree answers them from an order we fetch, Google Play
// from a purchase we fetch — and each caller does its own before calling in.
// ─────────────────────────────────────────────────────────────────────────────

import Subscription from '../../models/subscription.models.js';

/** Which Business.plan tier a subscription maps to. */
export const PLAN_TO_BUSINESS_PLAN = {
    small_business: 'plan2',
    corporate: 'plan3'
};

// Adds one calendar month without the Date.setMonth() overflow that turned a
// 31-January renewal into 3 March and handed out free days.
export const addOneMonth = (from) => {
    const next = new Date(from);
    const day  = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDayOfTargetMonth));
    return next;
};

export const invalidateCaches = async (userId) => {
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

/**
 * Has [paymentIds] already bought somebody a subscription?
 *
 * Looks at `redeemedPaymentIds` — the full redemption history — and not at the
 * scalar `paymentId`, which renewal overwrites. A gateway receipt stays valid
 * forever at the gateway, so a guard that can only see the most recent payment
 * lets an older one be replayed for a free month once a renewal has happened.
 *
 * Returns the Subscription that already redeemed one of these ids, or null.
 */
export const findRedemption = async (paymentIds) => {
    const keys = paymentIds.filter(Boolean).map(String);
    if (keys.length === 0) return null;
    return Subscription.findOne({
        $or: [
            { redeemedPaymentIds: { $in: keys } },
            { paymentId: { $in: keys } }
        ]
    });
};

/**
 * Writes an activation that the caller has already validated.
 *
 * [endDate] is the caller's to compute, because the two gateways disagree about
 * who owns that date: for Cashfree we derive it ourselves with addOneMonth,
 * whereas Google Play tells us the expiry outright and is authoritative — it
 * has already applied any proration, pause, grace period or free trial, so
 * recomputing it locally would fight the store and drift.
 */
export const persistActivation = async ({
    user,
    plan,
    startDate,
    endDate,
    paymentId,
    source,
    autoRenew = true,
    playPurchaseToken = null,
    playProductId = null
}) => {
    let subscription = await Subscription.findOne({ userId: user._id });

    if (subscription) {
        subscription.plan      = plan;
        subscription.status    = 'active';
        subscription.startDate = startDate;
        subscription.endDate   = endDate;
        subscription.paymentId = paymentId;
        subscription.autoRenew = autoRenew;
        if (source)            subscription.source = source;
        if (playPurchaseToken) subscription.playPurchaseToken = playPurchaseToken;
        if (playProductId)     subscription.playProductId = playProductId;
        await subscription.save();
    } else {
        subscription = await Subscription.create({
            userId: user._id,
            plan,
            status: 'active',
            startDate,
            endDate,
            paymentId,
            autoRenew,
            source: source || undefined,
            playPurchaseToken: playPurchaseToken || undefined,
            playProductId: playProductId || undefined
        });
    }

    const Business = (await import('../../models/business.models.js')).default;
    const business = await Business.findOneAndUpdate(
        { userId: user._id },
        { $set: { plan: PLAN_TO_BUSINESS_PLAN[plan], subscriptionStatus: 'active', isVerified: true } },
        { upsert: true, new: true }
    );

    try {
        await invalidateCaches(user._id);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    return { subscription, business };
};

/**
 * Ends a subscription that the store says is over (expired, revoked, refunded,
 * or cancelled past its paid-through date). Downgrades the Business doc back to
 * the free tier so paid features stop working.
 *
 * The Business downgrade is deliberately identical to the one in
 * jobs/subscriptionExpiry.job.js — plan1 + subscriptionStatus 'pending'. Note
 * that 'pending' rather than the Subscription's own 'expired'/'cancelled' is
 * not a slip: Business.subscriptionStatus only permits active|inactive|pending,
 * and $set in findOneAndUpdate skips validators, so writing the Subscription
 * status through would silently store a value outside the enum.
 *
 * Deliberately does not delete the Subscription: `redeemedPaymentIds` is the
 * replay guard and must survive, and the row is the only record of what the
 * user used to have.
 */
export const persistDeactivation = async ({ subscription, status = 'expired' }) => {
    subscription.status = status;
    subscription.autoRenew = false;
    await subscription.save();

    const Business = (await import('../../models/business.models.js')).default;
    await Business.findOneAndUpdate(
        { userId: subscription.userId },
        { $set: { plan: 'plan1', subscriptionStatus: 'pending' } }
    );

    try {
        await invalidateCaches(subscription.userId);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    return subscription;
};
