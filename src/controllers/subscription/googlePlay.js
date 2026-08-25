import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';
import {
    getSubscriptionPurchase,
    acknowledgeSubscription,
    isGooglePlayConfigured,
    PLAY_PACKAGE_NAME
} from '../../config/googlePlay.config.js';
import {
    findRedemption,
    persistActivation,
    persistDeactivation
} from './activation.js';
import {
    PaymentLogger,
    SubscriptionLogger,
    ErrorLogger,
    MetricsCollector,
    fingerprintToken
} from '../../utils/monitoring.utils.js';
import { SUBSCRIPTION_PLANS, PLAY_PRODUCT_TO_PLAN } from './plans.js';

// ─────────────────────────────────────────────────────────────────────────────
// Google Play Billing activation.
//
// Mirrors the Cashfree path in payment.js and obeys the same rule: the client
// only gets to say "please look at this purchase token". Which product it was,
// whether it is paid, when it expires and whose account it belongs to all come
// from a purchases.subscriptionsv2.get we make ourselves.
//
// What differs from Cashfree, and why:
//
//  · Expiry is Google's, not ours. Cashfree pays for one month and we compute
//    the end date with addOneMonth. Play has already applied free trials,
//    introductory offers, proration on tier changes, pauses and grace periods
//    by the time it answers, so we take lineItems[].expiryTime verbatim.
//    Recomputing locally would fight the store and drift on every edge case.
//
//  · Renewals arrive without the user. Play charges the card by itself and
//    tells us afterwards through a Real-time Developer Notification, so the
//    RTDN handler below is not an optimisation — without it a subscriber's
//    endDate would lapse a month after purchase and the nightly expiry job
//    would revoke a subscription they are still paying for.
//
//  · Acknowledgement is load-bearing. Google auto-refunds any purchase left
//    unacknowledged for three days.
// ─────────────────────────────────────────────────────────────────────────────

/** Subscription states in which the user is entitled to the paid features. */
const ENTITLED_STATES = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
]);

/**
 * States that mean the subscription is over for good. CANCELED is deliberately
 * absent: a cancelled subscription keeps working until the period the user
 * already paid for runs out, and Play keeps reporting it as CANCELED with a
 * future expiryTime the whole time.
 */
const ENDED_STATES = new Set([
    'SUBSCRIPTION_STATE_EXPIRED',
    'SUBSCRIPTION_STATE_ON_HOLD',
    'SUBSCRIPTION_STATE_PAUSED'
]);

const firstLineItem = (purchase) =>
    Array.isArray(purchase?.lineItems) && purchase.lineItems.length > 0
        ? purchase.lineItems[0]
        : null;

/**
 * Everything we are willing to believe about a purchase, pulled out of the
 * Play response and validated. Throws ApiError on anything unusable.
 */
const readPurchase = (purchase) => {
    const lineItem = firstLineItem(purchase);
    if (!lineItem) {
        throw new ApiError(400, 'Google Play returned a purchase with no line items');
    }

    const productId = lineItem.productId;
    const plan = PLAY_PRODUCT_TO_PLAN[productId];
    if (!plan) {
        throw new ApiError(400, `Unrecognised Google Play product: ${productId}`);
    }

    const expiryTime = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
    if (!expiryTime || Number.isNaN(expiryTime.getTime())) {
        throw new ApiError(400, 'Google Play returned a purchase with no usable expiry time');
    }

    // The receipt id, and our replay key. It changes on every renewal, so each
    // renewal is redeemable exactly once while an old one stays spent.
    const orderId = purchase?.latestOrderId;
    if (!orderId) {
        throw new ApiError(400, 'Google Play returned a purchase with no order id');
    }

    return {
        plan,
        productId,
        expiryTime,
        orderId,
        state: purchase?.subscriptionState,
        startTime: purchase?.startTime ? new Date(purchase.startTime) : new Date(),
        autoRenewing: Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled),
        acknowledged: purchase?.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        obfuscatedAccountId:
            purchase?.externalAccountIdentifiers?.obfuscatedExternalAccountId || null
    };
};

/**
 * Grants [details] to [user] and tells Play we have done so.
 *
 * Shared by the client-driven verify call and the RTDN handler, so whichever
 * arrives first wins and the second is a no-op — the redemption guard keys on
 * the order id, exactly as the Cashfree path does.
 */
const activateForPlayPurchase = async ({ user, details, purchaseToken }) => {
    const existing = await findRedemption([details.orderId]);
    if (existing && existing.userId.toString() !== user._id.toString()) {
        throw new ApiError(400, 'This purchase has already been used to activate a subscription');
    }

    let subscription;
    let alreadyApplied = false;

    if (existing) {
        // Same user, same receipt — already granted. Fall through to the
        // acknowledgement below anyway: the grant may have been written on a
        // previous attempt that died before it could acknowledge, and an
        // unacknowledged purchase is auto-refunded after three days.
        subscription = existing;
        alreadyApplied = true;
    } else {
        ({ subscription } = await persistActivation({
            user,
            plan: details.plan,
            startDate: details.startTime,
            endDate: details.expiryTime,
            paymentId: details.orderId,
            source: 'google_play',
            autoRenew: details.autoRenewing,
            playPurchaseToken: purchaseToken,
            playProductId: details.productId
        }));
    }

    if (!details.acknowledged) {
        try {
            await acknowledgeSubscription({
                subscriptionId: details.productId,
                purchaseToken
            });
        } catch (ackError) {
            // Loud, because the consequence is silent and delayed: Play will
            // refund the user in three days and we will look like we took their
            // money for nothing.
            ErrorLogger.logPaymentGatewayError(
                user._id.toString(),
                details.orderId,
                new Error(`Play acknowledgement FAILED (auto-refund in 3 days): ${ackError?.message || ackError}`)
            );
        }
    }

    return { subscription, alreadyApplied };
};

/**
 * POST /api/v1/subscription/google-play/verify   { purchaseToken }
 *
 * Called by the app after Play reports a completed purchase, and again on every
 * app start for any purchase the client still holds unfinished. Idempotent.
 */
export const verifyGooglePlayPurchase = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { purchaseToken } = req.body;

    if (!purchaseToken || typeof purchaseToken !== 'string') {
        throw new ApiError(400, 'Missing required field: purchaseToken');
    }
    if (!isGooglePlayConfigured()) {
        throw new ApiError(503, 'Google Play billing is not configured on this server');
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isBusinessProfile) {
        throw new ApiError(403, 'Only business accounts can activate a subscription.');
    }

    let purchase;
    try {
        purchase = await getSubscriptionPurchase(purchaseToken);
    } catch (error) {
        ErrorLogger.logPaymentGatewayError(userId.toString(), null, error);
        // A 404 from Play means the token is not a purchase it knows about.
        if (error?.response?.status === 404) {
            throw new ApiError(400, 'Google Play does not recognise this purchase');
        }
        throw new ApiError(502, 'Could not verify the purchase with Google Play');
    }

    const details = readPurchase(purchase);

    // ── Did the account being upgraded pay for it? ────────────────────────────
    // The app sets this to the buyer's userId at purchase time; it is the Play
    // equivalent of Cashfree's customer_id. Missing means the purchase was made
    // by something that is not our app, so refuse rather than fall back to a
    // weaker check — otherwise one purchase token could be passed around and
    // redeemed by any number of accounts.
    if (!details.obfuscatedAccountId) {
        throw new ApiError(400, 'This purchase is not linked to a Findernate account');
    }
    if (details.obfuscatedAccountId !== userId.toString()) {
        throw new ApiError(403, 'This purchase belongs to a different account');
    }

    // The purchase token is a payment credential and these loggers append to a
    // file on a persistent disk, so only its fingerprint goes to the log.
    PaymentLogger.logPaymentVerification(
        userId.toString(),
        details.orderId,
        fingerprintToken(purchaseToken),
        ENTITLED_STATES.has(details.state)
    );

    if (!ENTITLED_STATES.has(details.state)) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Purchase is not active. Google Play reports: ${details.state || 'unknown'}`);
    }

    const { subscription, alreadyApplied } =
        await activateForPlayPurchase({ user, details, purchaseToken });

    const Business = (await import('../../models/business.models.js')).default;
    const businessDoc = await Business.findOne({ userId });

    const hasCallingAccess = ['small_business', 'corporate'].includes(details.plan);
    const planName = SUBSCRIPTION_PLANS[details.plan]?.name || details.plan;

    if (!alreadyApplied) {
        PaymentLogger.logPaymentSuccess(
            userId.toString(), details.orderId, fingerprintToken(purchaseToken),
            details.plan, SUBSCRIPTION_PLANS[details.plan]?.price ?? 0
        );
        SubscriptionLogger.logSubscriptionCreated(
            userId.toString(), details.plan, subscription.startDate, subscription.endDate
        );
        MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[details.plan]?.price ?? 0, details.plan);
    }

    res.status(200).json(
        new ApiResponse(200, {
            subscription,
            business: { plan: businessDoc?.plan, subscriptionStatus: businessDoc?.subscriptionStatus },
            tier: details.plan,
            features: {
                calling: {
                    hasAccess: hasCallingAccess,
                    audioCall: hasCallingAccess,
                    videoCall: hasCallingAccess,
                    unlimited: hasCallingAccess
                }
            },
            message: alreadyApplied
                ? `Your ${planName} plan is already active.`
                : `Successfully upgraded to ${planName} plan!`,
            paymentId: details.orderId
        }, 'Subscription activated successfully')
    );
});

/**
 * POST /api/v1/subscription/google-play/notification
 *
 * Google Cloud Pub/Sub push endpoint for Real-time Developer Notifications.
 * Set the RTDN topic in Play Console > Monetise with Play > Monetisation setup,
 * then create a PUSH subscription on that topic pointing here.
 *
 * Authentication is a shared secret carried in the push URL's query string
 * (?token=…, matched against GOOGLE_PLAY_RTDN_SECRET), which is the mechanism
 * Google documents for push endpoints that are not behind IAP. It is the only
 * authentication this route has — the route is deliberately mounted before the
 * JWT middleware, because Pub/Sub has no user session.
 *
 * The notification type is deliberately ignored for deciding entitlement. Play
 * ships nearly twenty of them and treating each as an instruction is how these
 * integrations rot; instead any notification is treated purely as a nudge to
 * re-read the subscription and reconcile to whatever Play now says.
 *
 * Always answers 200. A non-2xx makes Pub/Sub redeliver, and a payload we
 * cannot use will not become usable on the fourth attempt.
 */
export const googlePlayNotification = asyncHandler(async (req, res) => {
    const expected = process.env.GOOGLE_PLAY_RTDN_SECRET;
    if (!expected || req.query?.token !== expected) {
        // 403 rather than 200: this one is not a bad payload, it is an
        // unauthenticated caller, and Pub/Sub is not the one being turned away.
        return res.status(403).json({ success: false });
    }

    const encoded = req.body?.message?.data;
    if (!encoded) return res.status(200).json({ success: true });

    let notification;
    try {
        notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
        console.error('[Play RTDN] Could not decode message data');
        return res.status(200).json({ success: true });
    }

    // Test notifications are sent from Play Console's "Send test notification"
    // button and carry no purchase.
    if (notification?.testNotification) {
        console.log('[Play RTDN] Test notification received');
        return res.status(200).json({ success: true });
    }

    if (notification?.packageName && notification.packageName !== PLAY_PACKAGE_NAME) {
        console.warn(`[Play RTDN] Ignoring notification for ${notification.packageName}`);
        return res.status(200).json({ success: true });
    }

    const sub = notification?.subscriptionNotification;
    const purchaseToken = sub?.purchaseToken;
    if (!purchaseToken) return res.status(200).json({ success: true });

    try {
        await reconcilePlaySubscription(purchaseToken);
    } catch (error) {
        // Swallowed on purpose — see the 200 note above. Surfaced for
        // reconciliation instead of being retried into a loop.
        ErrorLogger.logPaymentGatewayError('play-rtdn', fingerprintToken(purchaseToken), error);
        console.error('[Play RTDN] Reconciliation failed:', error?.message || error);
    }

    return res.status(200).json({ success: true });
});

/**
 * Re-reads one subscription from Play and makes our records match it.
 *
 * Used by the RTDN handler, and safe to call from a reconciliation script.
 */
export const reconcilePlaySubscription = async (purchaseToken) => {
    const purchase = await getSubscriptionPurchase(purchaseToken);
    const details = readPurchase(purchase);

    // Who owns this token? Prefer the record we already wrote; fall back to the
    // account identifier Play carries, which covers a renewal that arrives
    // before the client has ever verified.
    let subscription = await Subscription.findOne({ playPurchaseToken: purchaseToken });
    let user = null;

    if (subscription) {
        user = await User.findById(subscription.userId);
    } else if (details.obfuscatedAccountId) {
        user = await User.findById(details.obfuscatedAccountId).catch(() => null);
    }

    if (!user) {
        // Nothing to attribute it to yet. The client's own verify call will
        // pick it up the next time the app opens.
        console.warn(`[Play RTDN] No account for purchase token (state ${details.state})`);
        return { reconciled: false };
    }

    if (ENTITLED_STATES.has(details.state)) {
        await activateForPlayPurchase({ user, details, purchaseToken });
        SubscriptionLogger.logSubscriptionCreated(
            user._id.toString(), details.plan, details.startTime, details.expiryTime
        );
        return { reconciled: true, state: details.state, active: true };
    }

    if (ENDED_STATES.has(details.state)) {
        if (subscription && subscription.status === 'active') {
            await persistDeactivation({ subscription, status: 'expired' });
        }
        return { reconciled: true, state: details.state, active: false };
    }

    // CANCELED with a future expiry, PENDING, and anything Play adds later:
    // the user keeps what they paid for until it runs out. Record that it will
    // not renew so the UI can say so, but do not revoke anything.
    if (subscription && subscription.status === 'active') {
        subscription.autoRenew = details.autoRenewing;
        subscription.endDate = details.expiryTime;
        await subscription.save();
    }
    return { reconciled: true, state: details.state, active: true };
};
