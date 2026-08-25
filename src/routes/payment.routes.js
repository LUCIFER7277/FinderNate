import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import {
    guestCheckoutIpRateLimit,
} from "../middlewares/rateLimiter.middleware.js";
import {
    createPaymentLink,
    getPaymentLinkDetails,
    createChatCashfreeOrder,
    verifyPayment,
    chatCashfreeWebhook,
    createShareablePaymentLink,
    getShareablePaymentLinkDetails,
    createShareableCashfreeOrder,
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
router.post("/webhook", chatCashfreeWebhook);

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
//
// Auth is OPTIONAL: the website supports guest checkout here. A guest supplies
// buyerDetails (name, email, phone, an explicit "I am 13 or older" attestation
// and terms acceptance) instead of a token, and the order is created with
// buyerId:null.
//
// The account is created only once the payment is CONFIRMED — see
// settleGuestOrder in utils/guestCheckout.utils.js — and buyerId is back-filled
// there, so a paid guest order does land in an order history and in the
// seller's stats, while an abandoned checkout leaves no orphan identity behind.
//
// An email that ALREADY belongs to a user is a hard stop: the endpoint answers
// 409, creates no order, attaches nothing and issues no token, and the website
// diverts the buyer to sign in. No session token is ever minted on this path;
// the buyer reaches the new account through the public reset-OTP pair.
//
// If the address stops being free while the payment is in flight, the settled
// order is REFUNDED automatically. It is never parked for someone to claim —
// see refundOrphanedGuestOrder in utils/guestCheckout.utils.js.
//
// Rate-limited PER IP ONLY. The per-email limiter that used to sit here was
// removed: its key was attacker-supplied, so it could be used to lock a chosen
// address out of guest checkout, and the account creation it was sized to bound
// no longer happens here. See rateLimiter.middleware.js for the full reasoning.
router.post(
    "/post/create-order",
    guestCheckoutIpRateLimit,
    optionalVerifyJWT,
    createShareableCashfreeOrder
);

// Public route - get checkout details by linkId (for shareable checkout links)
// Used when someone accesses /checkout/:linkId
router.get("/checkout/link/:linkId", getCheckoutByLinkId);

// ============================================
// ONLINE STORE CHECKOUT — Cashfree (public, supports guest checkout)
// ============================================

// Cashfree S2S webhook (no auth, called by Cashfree servers)
router.post("/cashfree/webhook", cashfreeWebhook);

// Step 1: Buyer fills shipping address → creates Cashfree order, returns checkoutUrl
//
// Auth is OPTIONAL — this checkout supports guests on exactly the terms the
// shareable one does (see /post/create-order above): buyerDetails with a 13+
// attestation and terms acceptance instead of a token, an existing email is a
// 409 before any order exists, the account is created only once the payment is
// confirmed, and an order that cannot be given a buyer is refunded
// automatically.
//
// SAME PER-IP LIMITER, for the same reason. This route was mounted with nothing
// but optionalVerifyJWT: anonymous callers could create unbounded pending
// orders and Cashfree sessions, and each request also minted a PaymentLink. The
// key is the IP and never anything the caller supplies, so spending the bucket
// costs the attacker their own address rather than locking a victim out.
router.post(
    "/store/create-order",
    guestCheckoutIpRateLimit,
    optionalVerifyJWT,
    createOnlineStoreOrder
);

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
router.post("/create-order", createChatCashfreeOrder);


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
