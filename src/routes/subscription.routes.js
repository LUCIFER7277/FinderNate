import { Router } from 'express';
import {
    getSubscriptionStatus,
    getUpgradePrompt,
    checkFeatureAccess,
    getAvailablePlans,
    createSubscriptionOrder,
    verifySubscriptionPayment,
    subscriptionWebhook,
    testUpgradeSubscription
} from '../controllers/subscription.controllers.js';
import {
    getPaymentLogs,
    getSubscriptionLogs,
    getErrorLogs,
    getMetrics,
    testExpiryJob,
    getDashboard
} from '../controllers/monitoring.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

// Public route — Cashfree webhook (no JWT)
router.post('/webhook', subscriptionWebhook);                    // POST /api/v1/subscription/webhook

// Apply authentication middleware to all routes below
router.use(verifyJWT);

// Subscription information routes
router.get('/status', getSubscriptionStatus);                    // GET /api/v1/subscription/status
router.get('/upgrade-prompt', getUpgradePrompt);                 // GET /api/v1/subscription/upgrade-prompt?feature=calling
router.get('/feature/:feature/access', checkFeatureAccess);      // GET /api/v1/subscription/feature/calling/access
router.get('/plans', getAvailablePlans);                         // GET /api/v1/subscription/plans

// Cashfree payment routes for subscription upgrade
router.post('/create-order', createSubscriptionOrder);           // POST /api/v1/subscription/create-order
router.post('/verify-payment', verifySubscriptionPayment);       // POST /api/v1/subscription/verify-payment

// @deprecated - TEST ONLY: Upgrade subscription without payment (for testing business features)
// This endpoint should not be used in production. Use /create-order and /verify-payment instead
if (process.env.NODE_ENV !== 'production') {
    router.post('/test-upgrade', testUpgradeSubscription);       // POST /api/v1/subscription/test-upgrade
}

// ===============================
// MONITORING & ADMIN ROUTES
// ===============================
// These routes help monitor subscription system health
router.get('/monitoring/dashboard', getDashboard);               // GET /api/v1/subscription/monitoring/dashboard
router.get('/monitoring/payment-logs', getPaymentLogs);          // GET /api/v1/subscription/monitoring/payment-logs
router.get('/monitoring/subscription-logs', getSubscriptionLogs); // GET /api/v1/subscription/monitoring/subscription-logs
router.get('/monitoring/error-logs', getErrorLogs);              // GET /api/v1/subscription/monitoring/error-logs
router.get('/monitoring/metrics', getMetrics);                   // GET /api/v1/subscription/monitoring/metrics
router.post('/monitoring/test-expiry-job', testExpiryJob);       // POST /api/v1/subscription/monitoring/test-expiry-job

export default router;
