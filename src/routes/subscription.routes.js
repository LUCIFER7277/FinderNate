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
} from '../controllers/subscription/index.js';
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
// MONITORING & ADMIN ROUTES — MOVED
// ===============================
// /monitoring/* used to be registered here, below `router.use(verifyJWT)`, which
// is the ORDINARY user middleware: any signed-in account could read the platform
// payment log, internal error stack traces and whole-business revenue metrics,
// and could trigger the expiry job. The controllers already documented
// themselves as /api/v1/admin/monitoring/*, and that is where they now live —
// see routes/admin.routes.js, behind verifyAdminJWT + requirePermission.
// Nothing in the app or the website called the subscription-router paths.

export default router;
