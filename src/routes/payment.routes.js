import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import {
    createPaymentLink,
    getPaymentLinkDetails,
    createRazorpayOrder,
    verifyPayment,
    razorpayWebhook,
    createShareablePaymentLink,
    getShareablePaymentLinkDetails,
    createShareableRazorpayOrder
} from "../controllers/payments.controllers.js";

const router = Router();

// Webhook (no auth - called by Razorpay)
router.post("/webhook", razorpayWebhook);

// Public route - get payment link details
router.get("/link/:linkId", getPaymentLinkDetails);

// ============================================
// SHAREABLE PAYMENT LINKS (public routes)
// URL format: /post/:postId/pay/:amount
// ============================================

// Public route - get shareable payment link details
// Used when someone accesses /post/:postId/pay/:amount
router.get("/post/:postId/pay/:amount", getShareablePaymentLinkDetails);

// Create Razorpay order for shareable payment link (optional auth - can be used by guests)
router.post("/post/create-order", optionalVerifyJWT, createShareableRazorpayOrder);

// Protected routes
router.use(verifyJWT);

// Seller creates payment link (for chat)
router.post("/create-link", createPaymentLink);

// Business account creates shareable payment link for a post
router.post("/create-shareable-link", createShareablePaymentLink);

// Buyer creates Razorpay order
router.post("/create-order", createRazorpayOrder);

// Verify payment after completion
router.post("/verify", verifyPayment);

export default router;
