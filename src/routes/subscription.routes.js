import { Router } from 'express';
import {
    getSubscriptionStatus,
    getUpgradePrompt,
    checkFeatureAccess,
    getAvailablePlans,
    testUpgradeSubscription
} from '../controllers/subscription.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Subscription routes
router.get('/status', getSubscriptionStatus);                    // GET /api/v1/subscription/status
router.get('/upgrade-prompt', getUpgradePrompt);                 // GET /api/v1/subscription/upgrade-prompt?feature=calling
router.get('/feature/:feature/access', checkFeatureAccess);      // GET /api/v1/subscription/feature/calling/access
router.get('/plans', getAvailablePlans);                         // GET /api/v1/subscription/plans

//delete after payment integration
// TEST ONLY: Upgrade subscription without payment (for testing business features)
router.post('/test-upgrade', testUpgradeSubscription);           // POST /api/v1/subscription/test-upgrade

export default router;
