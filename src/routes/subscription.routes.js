import { Router } from 'express';
import {
    getSubscriptionStatus,
    getUpgradePrompt,
    checkFeatureAccess,
    getAvailablePlans
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

export default router;
