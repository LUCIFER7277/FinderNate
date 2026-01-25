import { Router } from 'express';
import { generateUserToken, createStreamCall } from '../controllers/stream.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';

const router = Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

/**
 * Stream.io Token Generation
 *
 * POST /api/v1/stream/token
 * - Generates a Stream.io user token for video/audio calls
 * - Auto-registers user in Stream.io if not already registered
 * - Returns token, userId, apiKey, and expiration time
 */
router.post('/token', generateUserToken);

/**
 * Stream.io Call Creation
 *
 * POST /api/v1/stream/call/create
 * - Creates a Stream.io call with proper audio/video settings
 * - For voice calls: uses 'audio_room' type (no video required)
 * - For video calls: uses 'default' type with video
 */
router.post('/call/create', createStreamCall);

export default router;
