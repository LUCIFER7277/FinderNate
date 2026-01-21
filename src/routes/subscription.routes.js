import { Router } from 'express';
import {
    getSubscriptionStatus,
    getUpgradePrompt,
    checkFeatureAccess,
    getAvailablePlans,
    createSubscriptionOrder,
    verifySubscriptionPayment,
    testUpgradeSubscription
} from '../controllers/subscription.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Subscription information routes
router.get('/status', getSubscriptionStatus);                    // GET /api/v1/subscription/status
router.get('/upgrade-prompt', getUpgradePrompt);                 // GET /api/v1/subscription/upgrade-prompt?feature=calling
router.get('/feature/:feature/access', checkFeatureAccess);      // GET /api/v1/subscription/feature/calling/access
router.get('/plans', getAvailablePlans);                         // GET /api/v1/subscription/plans

// Razorpay payment routes for subscription upgrade
router.post('/create-order', createSubscriptionOrder);           // POST /api/v1/subscription/create-order
router.post('/verify-payment', verifySubscriptionPayment);       // POST /api/v1/subscription/verify-payment

// @deprecated - TEST ONLY: Upgrade subscription without payment (for testing business features)
// This endpoint should not be used in production. Use /create-order and /verify-payment instead
router.post('/test-upgrade', testUpgradeSubscription);           // POST /api/v1/subscription/test-upgrade

export default router;
