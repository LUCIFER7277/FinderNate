import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
    verifyCashfreeWebhook,
} from "../config/cashfree.config.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Order from "../models/order.models.js";
import PaymentLink from "../models/paymentLink.models.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";

const getFrontendUrl = () => process.env.FRONTEND_URL || 'https://findernate.com';
const getBackendUrl  = () => process.env.BACKEND_URL  || 'https://apis.findernate.com';

const generateOrderNumber = () => {
    const ts     = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CF-${ts}-${random}`;
};

const generateLinkId = () =>
    `fnpay_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/store/create-order
//
// Body: { postId, shippingAddress, buyerDetails? }
//   Amount is derived from the Post document — never trusted from the client.
//   shippingAddress: { fullName, phoneNumber, addressLine1, addressLine2?,
//                      city, state, postalCode, country? }
//   buyerDetails (guest only): { fullName, email?, phoneNumber }
//
// Returns: { checkoutUrl, paymentSessionId, cashfreeMode, cashfreeOrderId,
//            orderId, orderNumber, amount }
// ─────────────────────────────────────────────────────────────────────────────
export const createOnlineStoreOrder = asyncHandler(async (req, res) => {
    const { postId, shippingAddress, buyerDetails } = req.body;
    console.log(postId +" "+shippingAddress+" "+buyerDetails)
    const buyerId = req.user?._id;

    if (!postId) {
        throw new ApiError(400, "postId is required");
    }

    if (
        !shippingAddress?.fullName      ||
        !shippingAddress?.phoneNumber   ||
        !shippingAddress?.addressLine1  ||
        !shippingAddress?.city          ||
        !shippingAddress?.state         ||
        !shippingAddress?.postalCode
    ) {
        throw new ApiError(400, "Complete shipping address is required");
    }

    // ── Load post and seller ───────────────────────────────────────────────────
    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Product not found");

    const seller = await User.findById(post.userId);
    if (!seller) throw new ApiError(404, "Seller not found");

    // ── Derive price from the Post — client never supplies the amount ──────────
    let basePrice      = 0;
    let shippingCharge = 0;
    let gstPercent     = 0;
    let productDetails = {
        name:   post.caption || "Product",
        description: post.description || "",
        price:  0,
        images: post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || []
    };

    if (post.customization?.product) {
        const p    = post.customization.product;
        basePrice      = Number(p.price)           || 0;
        shippingCharge = Number(p.shippingCharges) || 0;
        gstPercent     = Number(p.gstPercent)      || 0;
        productDetails = {
            name:        p.name        || productDetails.name,
            description: p.description || productDetails.description,
            price:       basePrice,
            images:      p.images?.length ? p.images : productDetails.images,
            category:    p.category
        };
    } else if (post.customization?.service) {
        const s    = post.customization.service;
        basePrice      = Number(s.price)           || 0;
        shippingCharge = Number(s.shippingCharges) || 0;
        gstPercent     = Number(s.gstPercent)      || 0;
        productDetails = {
            name:        s.name        || productDetails.name,
            description: s.description || productDetails.description,
            price:       basePrice,
            images:      productDetails.images,
            category:    s.category
        };
    }

    if (basePrice <= 0) {
        throw new ApiError(400, "This product does not have a valid price set");
    }

    const gstAmount        = Math.round((basePrice * gstPercent) / 100);
    const effectiveShipping = basePrice >= 499 ? 0 : shippingCharge; // free shipping on orders ≥ ₹499
    const numericAmount    = basePrice + effectiveShipping + gstAmount; // server-authoritative total

    // ── Prevent duplicate concurrent sessions (NOT duplicate purchases) ────────
    // A buyer can buy the same product multiple times (separate orders).
    // We only clean up stale PENDING orders from previously abandoned checkouts
    // so the buyer always gets a fresh Cashfree session on each attempt.
    if (buyerId) {
        await Order.deleteMany({
            postId,
            buyerId,
            paymentStatus: 'pending'
        });
    }

    // ── Find or create a shared PaymentLink for this product ──────────────────
    let paymentLink = await PaymentLink.findOne({
        postId,
        amount: numericAmount,
        status: 'active',
        isShareableLink: true
    });

    if (!paymentLink) {
        const linkId      = generateLinkId();
        const frontendUrl = getFrontendUrl();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId: seller._id,
            postId,
            productDetails,
            amount: numericAmount,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${numericAmount}`,
            shortUrl:   `${frontendUrl}/p/${linkId}`,
            isShareableLink: true
        });
    }

    // ── Create order document ──────────────────────────────────────────────────
    const order = await Order.create({
        orderNumber:   generateOrderNumber(),
        buyerId:       buyerId || null,
        buyerDetails:  !buyerId ? buyerDetails : undefined,
        sellerId:      seller._id,
        postId,
        paymentLinkId: paymentLink._id,
        productDetails,
        amount:        numericAmount,
        platformFee:   0,
        sellerAmount:  numericAmount,
        shippingAddress,
        orderStatus:   'payment_pending',
        paymentStatus: 'pending',
        isShareableOrder: true
    });

    // ── Create Cashfree payment order ──────────────────────────────────────────
    const cashfreeOrderId = generateCashfreeOrderId();
    const frontendUrl     = getFrontendUrl();
    const backendUrl      = getBackendUrl();

    const customerName  = shippingAddress.fullName;
    const customerPhone = shippingAddress.phoneNumber;
    const customerEmail = buyerDetails?.email || 'noreply@findernate.com';
    const customerId    = buyerId ? buyerId.toString() : `guest_${order._id}`;

    let cfOrder;
    try {
        cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        numericAmount,
            customerId,
            customerName,
            customerEmail,
            customerPhone,
            orderNote:     `Payment for ${productDetails.name}`,
            returnUrl:     `${frontendUrl}/payment/success?txnId=${cashfreeOrderId}&orderId=${order._id}&source=store`,
            notifyUrl:     `${backendUrl}/api/v1/payments/cashfree/webhook`,
            expiryMinutes: 20
        });
    } catch (cfError) {
        await Order.findByIdAndDelete(order._id);
        const msg =
            cfError?.response?.data?.message ||
            cfError?.message ||
            "Failed to initiate payment with Cashfree";
        throw new ApiError(400, msg);
    }

    const paymentSessionId = cfOrder?.payment_session_id;
    if (!paymentSessionId) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment session from Cashfree");
    }

    order.cashfreeOrderId = cashfreeOrderId;
    await order.save();

    const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);

    return res.status(200).json(
        new ApiResponse(200, {
            checkoutUrl,
            paymentSessionId,
            cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
            cashfreeOrderId,
            orderId:     order._id,
            orderNumber: order.orderNumber,
            amount:      numericAmount  // server-resolved; frontend can display this
        }, "Payment session created")
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/store/verify
// Public — no auth. Verifies a Cashfree payment after the buyer returns.
// Atomic: safe to call concurrently with the S2S webhook.
//
// Body: { txnId, orderId }  (txnId = cashfreeOrderId from the return URL)
// ─────────────────────────────────────────────────────────────────────────────
export const verifyOnlineStorePayment = asyncHandler(async (req, res) => {
    const { txnId, cashfreeOrderId: cfIdBody, orderId } = req.body;
    const cashfreeOrderId = cfIdBody || txnId;

    if (!cashfreeOrderId || !orderId) {
        throw new ApiError(400, "txnId (cashfreeOrderId) and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");

    // Idempotency — already confirmed
    if (['paid', 'held', 'released'].includes(order.paymentStatus)) {
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id:           order._id,
                    orderNumber:   order.orderNumber,
                    orderStatus:   order.orderStatus,
                    paymentStatus: order.paymentStatus,
                    amount:        order.amount,
                    productDetails: order.productDetails
                }
            }, "Payment already verified")
        );
    }

    // Check Cashfree
    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, "Failed to fetch order status from Cashfree");
    }

    if (cfOrder?.order_status !== 'PAID') {
        order.paymentStatus = 'failed';
        order.orderStatus   = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    // Fetch Cashfree payment ID (non-critical)
    let cfPaymentId = null;
    try {
        const payments = await getCashfreePayments(cashfreeOrderId);
        const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
        cfPaymentId = paid?.cf_payment_id?.toString() || null;
    } catch { /* non-critical */ }

    // Atomic update — races safely with the webhook
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreeOrderId,
            cashfreePaymentId: cfPaymentId,
            paymentStatus: 'paid',
            orderStatus:   'payment_received'
        },
        { new: true }
    );

    if (!updated) {
        // Webhook already processed it
        const refreshed = await Order.findById(order._id);
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id:           refreshed._id,
                    orderNumber:   refreshed.orderNumber,
                    orderStatus:   refreshed.orderStatus,
                    paymentStatus: refreshed.paymentStatus,
                    amount:        refreshed.amount,
                    productDetails: refreshed.productDetails
                }
            }, "Payment verified")
        );
    }

    await PaymentLink.findByIdAndUpdate(
        order.paymentLinkId,
        { status: 'paid', paidAt: new Date() }
    );

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id:           updated._id,
                orderNumber:   updated.orderNumber,
                orderStatus:   updated.orderStatus,
                paymentStatus: updated.paymentStatus,
                amount:        updated.amount,
                productDetails: updated.productDetails
            }
        }, "Payment verified successfully")
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/cashfree/webhook
// Cashfree S2S webhook — no auth, called by Cashfree servers.
// ─────────────────────────────────────────────────────────────────────────────
export const cashfreeWebhook = asyncHandler(async (req, res) => {
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    const signature = req.headers['x-webhook-signature'] || '';
    const rawBody   = req.rawBody || JSON.stringify(req.body);

    if (timestamp && signature) {
        const isValid = verifyCashfreeWebhook(timestamp, signature, rawBody);
        if (!isValid) {
            console.error('[Cashfree webhook] Invalid signature');
            return res.status(200).json({ status: 'ok' });
        }
    }

    const payload       = req.body;
    const cfOrderId     = payload?.data?.order?.order_id;
    const orderStatus   = payload?.data?.order?.order_status;
    const cfPaymentId   = payload?.data?.payment?.cf_payment_id?.toString();
    const paymentStatus = payload?.data?.payment?.payment_status;

    if (orderStatus !== 'PAID' || paymentStatus !== 'SUCCESS' || !cfOrderId) {
        return res.status(200).json({ status: 'ok' });
    }

    const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
    if (!order || order.paymentStatus !== 'pending') {
        return res.status(200).json({ status: 'ok' });
    }

    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId || null,
            paymentStatus: 'paid',
            orderStatus:   'payment_received'
        },
        { new: true }
    );

    if (updated) {
        await PaymentLink.findByIdAndUpdate(
            order.paymentLinkId,
            { status: 'paid', paidAt: new Date() }
        );
    }

    return res.status(200).json({ status: 'ok' });
});
