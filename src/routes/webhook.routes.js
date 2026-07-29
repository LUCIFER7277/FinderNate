import { Router } from 'express';
import {
    handleRazorpayWebhook,
    testWebhook,
    getWebhookLogs
} from '../controllers/webhook.controllers.js';
import { handleStreamWebhook } from '../controllers/streamWebhook.controllers.js';

const router = Router();

/**
 * Razorpay Webhook Routes
 *
 * IMPORTANT: Webhooks should NOT have authentication middleware
 * Razorpay sends requests without JWT tokens
 * Security is handled by webhook signature verification
 */

// Main webhook endpoint - receives Razorpay events
// POST /api/v1/webhooks/razorpay
router.post('/razorpay', handleRazorpayWebhook);

// Bunny Stream encoding-status webhook — clears media.processing once the
// renditions exist. Unauthenticated by design (Bunny sends no token); the
// controller only acts on a GUID already stored against a post.
// POST /api/v1/webhooks/bunny-stream
router.post('/bunny-stream', handleStreamWebhook);

// Test endpoint to verify webhook is configured correctly
// GET /api/v1/webhooks/test
router.get('/test', testWebhook);

// Get webhook logs (for debugging)
// GET /api/v1/webhooks/logs
router.get('/logs', getWebhookLogs);

export default router;
