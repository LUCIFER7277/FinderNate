import { Router } from 'express';
import { handleStreamWebhook } from '../controllers/streamWebhook.controllers.js';

const router = Router();

/**
 * Third-party webhook routes.
 *
 * IMPORTANT: Webhooks must NOT carry authentication middleware — the caller is
 * another company's server and sends no JWT. Security comes from per-provider
 * signature verification inside the handler.
 *
 * PAYMENT webhooks do NOT live here. Cashfree is the only payment gateway, and
 * its two endpoints are mounted under /api/v1/payments (see payment.routes.js):
 *   POST /api/v1/payments/webhook           — chat/escrow orders
 *   POST /api/v1/payments/cashfree/webhook  — online-store orders
 * Both verify the Cashfree signature via requireCashfreeWebhookSignature.
 *
 * A POST /api/v1/webhooks/razorpay handler used to sit here. It was removed:
 * nothing on this server ever created a Razorpay order, so it was receive-only,
 * and it could activate/extend a paid Subscription and mirror the plan onto
 * Business from a payment taken entirely outside Cashfree. See the removal
 * notes in docs/ for the reasoning.
 */

// Bunny Stream encoding-status webhook — clears media.processing once the
// renditions exist. Unauthenticated by design (Bunny sends no token); the
// controller only acts on a GUID already stored against a post.
// POST /api/v1/webhooks/bunny-stream
router.post('/bunny-stream', handleStreamWebhook);

export default router;
