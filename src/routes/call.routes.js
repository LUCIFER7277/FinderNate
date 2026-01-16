import { Router } from 'express';
import {
    initiateCall,
    acceptCall,
    declineCall,
    endCall,
    updateCallStatus,
    getCallHistory,
    getActiveCall,
    getCallStats,
    forceEndActiveCalls
} from '../controllers/call.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Call management routes
router.post('/initiate', initiateCall); // POST /api/v1/calls/initiate
router.patch('/:callId/accept', acceptCall); // PATCH /api/v1/calls/:callId/accept
router.patch('/:callId/decline', declineCall); // PATCH /api/v1/calls/:callId/decline
router.patch('/:callId/end', endCall);     // PATCH /api/v1/calls/:callId/end
router.patch('/:callId/status', updateCallStatus); // PATCH /api/v1/calls/:callId/status
router.post('/force-end-active', forceEndActiveCalls); // POST /api/v1/calls/force-end-active (cleanup stuck calls)

// Call data routes
router.get('/history', getCallHistory);                    // GET /api/v1/calls/history
router.get('/active', getActiveCall);                      // GET /api/v1/calls/active
router.get('/stats', getCallStats);                        // GET /api/v1/calls/stats

export default router;