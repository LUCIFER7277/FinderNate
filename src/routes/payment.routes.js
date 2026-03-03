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
    createShareableRazorpayOrder,
    getCheckoutByLinkId,
    showProductInterest,
    sendCheckoutMessage,
    getCheckoutDetails,
    initiateCheckoutPayment,
    verifyCheckoutPayment,
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

// Public route - get checkout details by linkId (for shareable checkout links)
// Used when someone accesses /checkout/:linkId
router.get("/checkout/link/:linkId", getCheckoutByLinkId);

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

// Buyer shows interest - sends checkout message in chat with full product details & price breakdown
router.post("/checkout", sendCheckoutMessage);

// E-commerce checkout flow (Flipkart/Myntra style)
// Step 2: Buyer clicks "Proceed to Pay" → fills address → creates Razorpay order
router.post("/checkout/initiate", initiateCheckoutPayment);

// Step 3: Buyer completes Razorpay payment → verify & confirm order
router.post("/checkout/verify", verifyCheckoutPayment);

// Step 1: Buyer views checkout details from a checkout message (param route last)
router.get("/checkout/:messageId", getCheckoutDetails);

// Legacy: Buyer shows interest - auto-creates payment link & sends message in chat
// router.post("/interest", showProductInterest);

export default router;
