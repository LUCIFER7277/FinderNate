import razorpay from "../config/razorpay.config.js";
import crypto from "crypto";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Order from "../models/order.models.js";
import PaymentLink from "../models/paymentLink.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";

const generateOrderNumber = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `FN-${timestamp}-${random}`;
};

const generateLinkId = () => {
    return `fnpay_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
};

// Seller creates payment link to send in chat
export const createPaymentLink = asyncHandler(async (req, res) => {
    const { postId, chatId, buyerId, productName, productDescription, price, images } = req.body;
    const sellerId = req.user._id;

    if (!productName || !price) {
        throw new ApiError(400, "Product name and price are required");
    }

    let productDetails = { name: productName, description: productDescription, price, images: images || [] };

    if (postId) {
        const post = await Post.findById(postId);
        if (post && post.customization?.product) {
            productDetails = {
                name: post.customization.product.name || productName,
                description: post.customization.product.description || productDescription,
                price: price || post.customization.product.price,
                images: post.customization.product.images || images || [],
                category: post.customization.product.category
            };
        }
    }

    const linkId = generateLinkId();
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        buyerId,
        chatId,
        postId,
        productDetails,
        amount: productDetails.price,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        paymentUrl: `${process.env.FRONTEND_URL}/pay/${linkId}`,
        shortUrl: `${process.env.FRONTEND_URL}/p/${linkId}`
    });

    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    return res.status(201).json(
        new ApiResponse(201, {
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                productDetails: paymentLink.productDetails,
                amount: paymentLink.amount,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: seller._id,
                    name: seller.fullName,
                    username: seller.username,
                    avatar: seller.profileImageUrl
                }
            }
        }, "Payment link created successfully")
    );
});

// Get payment link details (for buyer to view before payment)
export const getPaymentLinkDetails = asyncHandler(async (req, res) => {
    const { linkId } = req.params;

    const paymentLink = await PaymentLink.findOne({ linkId })
        .populate('sellerId', 'fullName username profileImageUrl isBlueTickVerified')
        .populate('postId', 'media caption');

    if (!paymentLink) {
        throw new ApiError(404, "Payment link not found");
    }

    if (paymentLink.status === 'expired' || (paymentLink.expiresAt && new Date() > paymentLink.expiresAt)) {
        paymentLink.status = 'expired';
        await paymentLink.save();
        throw new ApiError(400, "Payment link has expired");
    }

    if (paymentLink.status === 'paid') {
        throw new ApiError(400, "Payment already completed");
    }

    return res.status(200).json(
        new ApiResponse(200, { paymentLink }, "Payment link details fetched")
    );
});

// Create Razorpay order for payment
export const createRazorpayOrder = asyncHandler(async (req, res) => {
    const { linkId, shippingAddress } = req.body;
    const buyerId = req.user._id;

    const paymentLink = await PaymentLink.findOne({ linkId, status: 'active' });
    if (!paymentLink) {
        throw new ApiError(404, "Payment link not found or expired");
    }

    const orderNumber = generateOrderNumber();
    const platformFee = Math.round(paymentLink.amount * 0.02);
    const sellerAmount = paymentLink.amount - platformFee;

    const order = await Order.create({
        orderNumber,
        buyerId,
        sellerId: paymentLink.sellerId,
        postId: paymentLink.postId,
        chatId: paymentLink.chatId,
        paymentLinkId: paymentLink._id,
        productDetails: paymentLink.productDetails,
        amount: paymentLink.amount,
        platformFee,
        sellerAmount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });

    const razorpayOrder = await razorpay.orders.create({
        amount: paymentLink.amount * 100,
        currency: 'INR',
        receipt: order.orderNumber,
        notes: {
            orderId: order._id.toString(),
            buyerId: buyerId.toString(),
            sellerId: paymentLink.sellerId.toString()
        }
    });

    order.razorpayOrderId = razorpayOrder.id;
    await order.save();

    paymentLink.orderId = order._id;
    await paymentLink.save();

    return res.status(200).json(
        new ApiResponse(200, {
            razorpayOrderId: razorpayOrder.id,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            orderId: order._id,
            orderNumber: order.orderNumber
        }, "Razorpay order created")
    );
});

// Verify payment and hold in escrow
export const verifyPayment = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest("hex");

    if (expectedSignature !== razorpay_signature) {
        throw new ApiError(400, "Invalid payment signature");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    order.paymentStatus = 'held';
    order.orderStatus = 'payment_received';
    await order.save();

    await PaymentLink.findByIdAndUpdate(order.paymentLinkId, {
        status: 'paid',
        paidAt: new Date()
    });

    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.holdFunds(order, order.amount, `Payment for order ${order.orderNumber}`);

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: order._id,
                orderNumber: order.orderNumber,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus
            }
        }, "Payment verified and held in escrow")
    );
});

// Razorpay webhook handler
export const razorpayWebhook = asyncHandler(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

    if (signature !== expectedSignature) {
        throw new ApiError(400, "Invalid webhook signature");
    }

    const event = req.body.event;
    const payload = req.body.payload;

    if (event === 'payment.captured') {
        const razorpayOrderId = payload.payment.entity.order_id;
        const order = await Order.findOne({ razorpayOrderId });

        if (order && order.paymentStatus === 'pending') {
            order.razorpayPaymentId = payload.payment.entity.id;
            order.paymentStatus = 'held';
            order.orderStatus = 'payment_received';
            await order.save();

            await PaymentLink.findByIdAndUpdate(order.paymentLinkId, {
                status: 'paid',
                paidAt: new Date()
            });

            const escrowWallet = await EscrowWallet.getWallet();
            await escrowWallet.holdFunds(order, order.amount, `Payment for order ${order.orderNumber}`);
        }
    }

    return res.status(200).json({ status: 'ok' });
});
