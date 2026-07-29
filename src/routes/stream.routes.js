import { Router } from 'express';
import { generateUserToken, createStreamCall } from '../controllers/stream.controllers.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { verifyCallingAccess } from '../middlewares/subscription.middleware.js';

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
 *
 * Deliberately NOT behind verifyCallingAccess: a free user still has to be
 * able to ANSWER a call placed by a paid business account, and joining the
 * Stream room needs this token. Placing a call is what costs money, and that
 * is gated below.
 */
router.post('/token', generateUserToken);

/**
 * Stream.io Call Creation
 *
 * POST /api/v1/stream/call/create
 * - Creates a Stream.io call with proper audio/video settings
 * - For voice calls: uses 'audio_room' type (no video required)
 * - For video calls: uses 'default' type with video
 *
 * Paid business plans only (small_business, corporate).
 *
 * /calls/initiate already carried verifyCallingAccess, but the app calls BOTH
 * endpoints when starting a call and this one had no subscription check at
 * all — so a free account could create the Stream room directly and place a
 * call without ever passing the gate. The restriction is only as strong as
 * its least-guarded entry point.
 */
router.post('/call/create', verifyCallingAccess, createStreamCall);

export default router;
