import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    createPaymentLink,
    getPaymentLinkDetails,
    createRazorpayOrder,
    verifyPayment,
    razorpayWebhook
} from "../controllers/payments.controllers.js";

const router = Router();

// Webhook (no auth - called by Razorpay)
router.post("/webhook", razorpayWebhook);

// Public route - get payment link details
router.get("/link/:linkId", getPaymentLinkDetails);

// Protected routes
router.use(verifyJWT);

// Seller creates payment link
router.post("/create-link", createPaymentLink);

// Buyer creates Razorpay order
router.post("/create-order", createRazorpayOrder);

// Verify payment after completion
router.post("/verify", verifyPayment);

export default router;
