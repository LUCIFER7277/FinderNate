import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import {
    createPaymentLink,
    getPaymentLinkDetails,
    createPhonePeOrder,
    verifyPayment,
    phonePeWebhook,
    createShareablePaymentLink,
    getShareablePaymentLinkDetails,
    createShareablePhonePeOrder,
    getCheckoutByLinkId,
    showProductInterest,
    sendCheckoutMessage,
    getCheckoutDetails,
    initiateCheckoutPayment,
    verifyCheckoutPayment,
} from "../controllers/payments.controllers.js";
import {
    createOnlineStoreOrder,
    verifyOnlineStorePayment,
    cashfreeWebhook,
} from "../controllers/cashfree.payment.controller.js";

const router = Router();

// Cashfree S2S webhook — chat/escrow orders (no auth, sets paymentStatus: 'held' + escrow)
router.post("/webhook", phonePeWebhook);

// Public route - get payment link details
router.get("/link/:linkId", getPaymentLinkDetails);

// ============================================
// SHAREABLE PAYMENT LINKS (public routes)
// URL format: /post/:postId/pay/:amount
// ============================================

// Public route - get shareable payment link details
// Used when someone accesses /post/:postId/pay/:amount
router.get("/post/:postId/pay/:amount", getShareablePaymentLinkDetails);

// Create Cashfree payment for shareable link.
// Auth is REQUIRED: a guest order has no buyer account, so it never shows up in
// anyone's order history and never rolls into the seller's sales stats. The web
// checkout gates on this too, but the gate has to hold at the API as well.
router.post("/post/create-order", verifyJWT, createShareablePhonePeOrder);

// Public route - get checkout details by linkId (for shareable checkout links)
// Used when someone accesses /checkout/:linkId
router.get("/checkout/link/:linkId", getCheckoutByLinkId);

// ============================================
// ONLINE STORE CHECKOUT — Cashfree (public, supports guest checkout)
// ============================================

// Cashfree S2S webhook (no auth, called by Cashfree servers)
router.post("/cashfree/webhook", cashfreeWebhook);

// Step 1: Buyer fills shipping address → creates Cashfree order, returns checkoutUrl
router.post("/store/create-order", optionalVerifyJWT, createOnlineStoreOrder);

// Step 2: After Cashfree redirect back → verify payment status
// Public (no auth) so guest buyers can also complete verification
router.post("/store/verify", verifyOnlineStorePayment);

// Verify Cashfree payment after the return redirect.
// Public, for the same reason as /store/verify above. This runs AFTER the money
// has moved, and the buyer may come back on an expired token — a UPI hop can
// take minutes. Requiring auth here meant a charged buyer saw "Payment Failed"
// while the webhook quietly marked the order paid. It gives up no security:
// verifyPayment never reads req.user, so the JWT authorised nothing; the order
// status comes from Cashfree server-side, which is the real source of truth.
router.post("/verify", verifyPayment);

// Protected routes
router.use(verifyJWT);

// Seller creates payment link (for chat)
router.post("/create-link", createPaymentLink);

// Business account creates shareable payment link for a post
router.post("/create-shareable-link", createShareablePaymentLink);

// Buyer initiates Cashfree payment (chat payment link)
router.post("/create-order", createPhonePeOrder);


// Buyer shows interest - sends checkout message in chat with full product details & price breakdown
router.post("/checkout", sendCheckoutMessage);

// E-commerce checkout flow (Flipkart/Myntra style)
// Step 2: Buyer clicks "Proceed to Pay" → fills address → initiates Cashfree payment
router.post("/checkout/initiate", initiateCheckoutPayment);

// Step 3: After Cashfree redirect → verify & confirm order (escrow)
router.post("/checkout/verify", verifyCheckoutPayment);

// Step 1: Buyer views checkout details from a checkout message (param route last)
router.get("/checkout/:messageId", getCheckoutDetails);

// Legacy: Buyer shows interest - auto-creates payment link & sends message in chat
// router.post("/interest", showProductInterest);

export default router;
