import { Router } from 'express';
import {
    handleRazorpayWebhook,
    testWebhook,
    getWebhookLogs
} from '../controllers/webhook.controllers.js';

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

// Test endpoint to verify webhook is configured correctly
// GET /api/v1/webhooks/test
router.get('/test', testWebhook);

// Get webhook logs (for debugging)
// GET /api/v1/webhooks/logs
router.get('/logs', getWebhookLogs);

export default router;
