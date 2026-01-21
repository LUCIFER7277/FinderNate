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
    const platformFee = 0; // No platform fee
    const sellerAmount = paymentLink.amount;

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

// ============================================
// SHAREABLE PAYMENT LINKS (for business accounts)
// URL format: /post/:postId/pay/:amount
// ============================================

// Business account creates a shareable payment link for a post
export const createShareablePaymentLink = asyncHandler(async (req, res) => {
    const { postId, amount } = req.body;
    const sellerId = req.user._id;

    // Validate required fields
    if (!postId || !amount) {
        throw new ApiError(400, "Post ID and amount are required");
    }

    // Validate amount
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new ApiError(400, "Amount must be a positive number");
    }

    // Check if user is a business account
    const seller = await User.findById(sellerId);
    if (!seller) {
        throw new ApiError(404, "User not found");
    }

    if (!seller.isBusinessProfile) {
        throw new ApiError(403, "Only business accounts can create shareable payment links");
    }

    // Find the post and verify ownership
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    if (post.userId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "You can only create payment links for your own posts");
    }

    // Get product details from post
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: numericAmount,
        images: post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || []
    };

    // If post has product customization, use those details
    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: numericAmount, // Always use the custom amount
            images: post.customization.product.images || productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: numericAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Create a unique link ID
    const linkId = generateLinkId();

    // Create the payment link
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        postId,
        productDetails,
        amount: numericAmount,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days expiry
        paymentUrl: `${process.env.FRONTEND_URL}/post/${postId}/pay/${numericAmount}`,
        shortUrl: `${process.env.FRONTEND_URL}/p/${linkId}`,
        isShareableLink: true
    });

    return res.status(201).json(
        new ApiResponse(201, {
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                postId: postId,
                amount: numericAmount,
                productDetails: paymentLink.productDetails,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: seller._id,
                    name: seller.fullName,
                    username: seller.username,
                    avatar: seller.profileImageUrl,
                    isBusinessProfile: seller.isBusinessProfile,
                    isBlueTickVerified: seller.isBlueTickVerified
                }
            }
        }, "Shareable payment link created successfully")
    );
});

// Get shareable payment link details (public - no auth required)
// Used when someone accesses /post/:postId/pay/:amount
export const getShareablePaymentLinkDetails = asyncHandler(async (req, res) => {
    const { postId, amount } = req.params;

    // Validate amount
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new ApiError(400, "Invalid amount");
    }

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    // Get seller details
    const seller = await User.findById(post.userId)
        .select('fullName username profileImageUrl isBusinessProfile isBlueTickVerified');

    if (!seller) {
        throw new ApiError(404, "Seller not found");
    }

    if (!seller.isBusinessProfile) {
        throw new ApiError(400, "This post is not from a business account");
    }

    // Build product details
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: numericAmount,
        images: post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || []
    };

    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: numericAmount,
            images: post.customization.product.images?.length ? post.customization.product.images : productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: numericAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Find if there's an existing payment link for this post/amount combination
    let paymentLink = await PaymentLink.findOne({
        postId,
        amount: numericAmount,
        status: 'active',
        isShareableLink: true
    });

    // If no existing link, return the details without a link ID
    // The frontend can still initiate payment
    return res.status(200).json(
        new ApiResponse(200, {
            postId,
            amount: numericAmount,
            productDetails,
            post: {
                _id: post._id,
                postType: post.postType,
                contentType: post.contentType,
                caption: post.caption,
                media: post.media
            },
            seller: {
                _id: seller._id,
                fullName: seller.fullName,
                username: seller.username,
                profileImageUrl: seller.profileImageUrl,
                isBusinessProfile: seller.isBusinessProfile,
                isBlueTickVerified: seller.isBlueTickVerified
            },
            paymentLinkId: paymentLink?.linkId || null
        }, "Payment details fetched successfully")
    );
});

// Create Razorpay order for shareable payment link (can be used by guests too)
export const createShareableRazorpayOrder = asyncHandler(async (req, res) => {
    const { postId, amount, buyerDetails, shippingAddress } = req.body;
    const buyerId = req.user?._id; // May be null for guest checkout

    // Validate required fields
    if (!postId || !amount) {
        throw new ApiError(400, "Post ID and amount are required");
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new ApiError(400, "Invalid amount");
    }

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    // Get seller
    const seller = await User.findById(post.userId);
    if (!seller || !seller.isBusinessProfile) {
        throw new ApiError(400, "Invalid seller or not a business account");
    }

    // Build product details
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: numericAmount,
        images: post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || []
    };

    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: numericAmount,
            images: post.customization.product.images?.length ? post.customization.product.images : productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: numericAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Find or create payment link
    let paymentLink = await PaymentLink.findOne({
        postId,
        amount: numericAmount,
        status: 'active',
        isShareableLink: true
    });

    if (!paymentLink) {
        const linkId = generateLinkId();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId: seller._id,
            postId,
            productDetails,
            amount: numericAmount,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            paymentUrl: `${process.env.FRONTEND_URL}/post/${postId}/pay/${numericAmount}`,
            shortUrl: `${process.env.FRONTEND_URL}/p/${linkId}`,
            isShareableLink: true
        });
    }

    // Check if link is expired
    if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
        paymentLink.status = 'expired';
        await paymentLink.save();
        throw new ApiError(400, "Payment link has expired");
    }

    const orderNumber = generateOrderNumber();
    const platformFee = 0;
    const sellerAmount = numericAmount;

    // Create order
    const order = await Order.create({
        orderNumber,
        buyerId: buyerId || null,
        buyerDetails: !buyerId ? buyerDetails : undefined, // Store guest buyer details
        sellerId: seller._id,
        postId,
        paymentLinkId: paymentLink._id,
        productDetails,
        amount: numericAmount,
        platformFee,
        sellerAmount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending',
        isShareableOrder: true
    });

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
        amount: numericAmount * 100, // Razorpay expects amount in paise
        currency: 'INR',
        receipt: order.orderNumber,
        notes: {
            orderId: order._id.toString(),
            buyerId: buyerId?.toString() || 'guest',
            sellerId: seller._id.toString(),
            postId: postId,
            isShareable: 'true'
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
            orderNumber: order.orderNumber,
            seller: {
                name: seller.fullName,
                username: seller.username
            }
        }, "Razorpay order created for shareable payment")
    );
});
