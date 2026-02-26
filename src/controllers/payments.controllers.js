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
import Chat from "../models/chat.models.js";
import Message from "../models/message.models.js";
import socketManager from "../config/socket.js";

// Always use configured FRONTEND_URL for payment links (never use request origin)
const getFrontendUrl = () => {
    return process.env.FRONTEND_URL || 'https://findernate.com';
};

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
    const frontendUrl = getFrontendUrl();
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        buyerId,
        chatId,
        postId,
        productDetails,
        amount: productDetails.price,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        paymentUrl: `${frontendUrl}/pay/${linkId}`,
        shortUrl: `${frontendUrl}/p/${linkId}`
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

    let razorpayOrder;
    try {
        razorpayOrder = await razorpay.orders.create({
            amount: paymentLink.amount * 100,
            currency: 'INR',
            receipt: order.orderNumber,
            notes: {
                orderId: order._id.toString(),
                buyerId: buyerId.toString(),
                sellerId: paymentLink.sellerId.toString()
            }
        });
    } catch (razorpayError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = razorpayError?.error?.description || razorpayError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

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
    const frontendUrl = getFrontendUrl();

    // Create the payment link
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        postId,
        productDetails,
        amount: numericAmount,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days expiry
        paymentUrl: `${frontendUrl}/post/${postId}/pay/${numericAmount}`,
        shortUrl: `${frontendUrl}/p/${linkId}`,
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
        const frontendUrl = getFrontendUrl();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId: seller._id,
            postId,
            productDetails,
            amount: numericAmount,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${numericAmount}`,
            shortUrl: `${frontendUrl}/p/${linkId}`,
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
    let razorpayOrder;
    try {
        razorpayOrder = await razorpay.orders.create({
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
    } catch (razorpayError) {
        // Clean up the order since Razorpay failed
        await Order.findByIdAndDelete(order._id);
        const errorMsg = razorpayError?.error?.description || razorpayError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

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

// ============================================
// BUYER INTEREST - Auto payment link in chat
// ============================================

// Helper to emit socket events safely
const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    }
};

const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    }
};

// Buyer shows interest in a product - auto-creates payment link & sends message in chat
export const showProductInterest = asyncHandler(async (req, res) => {
    const { postId, chatId } = req.body;
    const buyerId = req.user._id;

    if (!postId || !chatId) {
        throw new ApiError(400, "Post ID and Chat ID are required");
    }

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    const sellerId = post.userId;

    // Don't create payment link for own products
    if (sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot create payment link for your own product");
    }

    // Verify the chat exists and buyer is a participant
    const chat = await Chat.findOne({
        _id: chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(404, "Chat not found or access denied");
    }

    // Build product details from post
    let productName = "Product";
    let productDescription = post.caption || "";
    let productPrice = 0;
    let productImages = post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || [];
    let productCategory = "";
    let productType = post.contentType || "product";

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productPrice = p.price || 0;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || "";
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productPrice = s.price || 0;
        productCategory = s.category || "";
        productType = "service";
    }

    // If no price, return negotiation mode
    if (!productPrice || productPrice <= 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                purchaseMode: 'negotiation',
                productSummary: {
                    postId: post._id,
                    name: productName,
                    description: productDescription,
                    price: 0,
                    currency: 'INR',
                    category: productCategory,
                    images: productImages,
                    thumbnail: productImages[0] || '',
                    purchaseMode: 'negotiation',
                    seller: { _id: sellerId }
                },
                messageSent: false,
                message: "Product has no fixed price. Negotiate in chat."
            }, "Negotiation mode - no fixed price")
        );
    }

    // Check if payment link already exists for this post+chat combination
    let paymentLink = await PaymentLink.findOne({
        postId,
        chatId,
        buyerId,
        status: 'active'
    });

    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    const frontendUrl = getFrontendUrl();

    if (!paymentLink) {
        // Create new payment link
        const linkId = generateLinkId();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId,
            buyerId,
            chatId,
            postId,
            productDetails: {
                name: productName,
                description: productDescription,
                price: productPrice,
                images: productImages,
                category: productCategory
            },
            amount: productPrice,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${productPrice}`,
            shortUrl: `${frontendUrl}/p/${linkId}`
        });
    } else {
        // Always update payment link URL and product details to use current FRONTEND_URL and latest data
        let needsSave = false;

        const correctUrl = `${frontendUrl}/post/${postId}/pay/${paymentLink.amount}`;
        if (paymentLink.paymentUrl !== correctUrl) {
            paymentLink.paymentUrl = correctUrl;
            needsSave = true;
        }

        if (paymentLink.amount !== productPrice) {
            paymentLink.productDetails.name = productName;
            paymentLink.productDetails.description = productDescription;
            paymentLink.productDetails.price = productPrice;
            paymentLink.productDetails.images = productImages;
            paymentLink.productDetails.category = productCategory;
            paymentLink.amount = productPrice;
            paymentLink.paymentUrl = `${frontendUrl}/post/${postId}/pay/${productPrice}`;
            needsSave = true;
        }

        if (needsSave) await paymentLink.save();
    }

    // Always send payment link message in chat (every time buyer shows interest)
    const paymentMessage = `💰 Pay for "${productName}" - ₹${productPrice}\n\nClick below to pay securely. Your payment will be held safely in escrow until you confirm delivery.`;

    const recipients = chat.participants.filter(
        p => p.toString() !== sellerId.toString()
    );

    const autoMessage = await Message.create({
        chatId,
        sender: sellerId, // Message appears from seller (automated)
        message: paymentMessage,
        messageType: 'payment_link',
        timestamp: new Date(),
        readBy: [sellerId],
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        })),
        productReference: {
            postId: post._id,
            productName,
            productImage: productImages[0] || '',
            productPrice,
            productType,
            productDescription,
        },
        linkPreview: {
            url: paymentLink.paymentUrl,
            title: `Pay ₹${productPrice} for ${productName}`,
            description: productDescription,
            image: productImages[0] || '',
            siteName: 'Findernate Pay'
        }
    });

    // Update chat's last message
    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: sellerId,
        message: paymentMessage,
        timestamp: new Date()
    };
    chat.lastMessageId = autoMessage._id;
    await chat.save();

    // Populate and emit via socket
    const populatedMessage = await Message.findById(autoMessage._id)
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    // Emit to chat room (for users already in the room)
    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    // Also emit directly to buyer's user room to ensure they receive the payment link
    // message even if they haven't joined the chat socket room yet
    safeEmitToUser(buyerId.toString(), 'new_message', {
        chatId,
        message: populatedMessage
    });

    return res.status(200).json(
        new ApiResponse(200, {
            purchaseMode: 'direct',
            productSummary: {
                postId: post._id,
                name: productName,
                description: productDescription,
                price: productPrice,
                currency: 'INR',
                category: productCategory,
                images: productImages,
                thumbnail: productImages[0] || '',
                purchaseMode: 'direct',
                seller: {
                    _id: sellerId,
                    fullName: seller?.fullName,
                    username: seller?.username,
                    profileImageUrl: seller?.profileImageUrl
                }
            },
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                amount: paymentLink.amount,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: sellerId,
                    name: seller?.fullName,
                    username: seller?.username,
                    avatar: seller?.profileImageUrl
                }
            },
            autoMessage: populatedMessage,
            messageSent: true,
            message: "Payment link sent to buyer in chat"
        }, "Payment link created and sent")
    );
});

// ============================================
// CHECKOUT MESSAGE - Send rich checkout card in chat
// ============================================

export const sendCheckoutMessage = asyncHandler(async (req, res) => {
    const { postId, chatId } = req.body;
    const buyerId = req.user._id;

    if (!postId || !chatId) {
        throw new ApiError(400, "Post ID and Chat ID are required");
    }

    // Find the post with full details
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    const sellerId = post.userId;

    // Don't allow self-checkout
    if (sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot checkout your own product");
    }

    // Verify the chat exists and buyer is a participant
    const chat = await Chat.findOne({
        _id: chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(404, "Chat not found or access denied");
    }

    // Extract product details
    let productName = "Product";
    let productDescription = post.caption || "";
    let productPrice = 0;
    let productImages = post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || [];
    let productCategory = "";
    let productType = post.contentType || "product";
    let specifications = [];
    let variants = [];
    let deliveryOptions = "offline";
    let sellerLocation = "";
    let currency = "INR";
    let shippingCharges = 0;
    let gstPercent = 0;

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productPrice = p.price || 0;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || "";
        specifications = p.specifications || [];
        variants = p.variants || [];
        deliveryOptions = p.deliveryOptions || "offline";
        currency = p.currency || "INR";
        shippingCharges = p.shippingCharges || 0;
        gstPercent = p.gstPercent || 0;
        if (p.location) {
            sellerLocation = p.location.name || p.location.address || p.location.city || "";
        }
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productPrice = s.price || 0;
        productCategory = s.category || "";
        productType = "service";
        deliveryOptions = s.deliveryOptions || "offline";
        currency = s.currency || "INR";
        shippingCharges = s.shippingCharges || 0;
        gstPercent = s.gstPercent || 0;
        if (s.location) {
            sellerLocation = s.location.name || s.location.address || s.location.city || "";
        }
    }

    // If no price, return negotiation mode
    if (!productPrice || productPrice <= 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                purchaseMode: 'negotiation',
                message: "Product has no fixed price. Negotiate in chat."
            }, "Negotiation mode - no fixed price")
        );
    }

    // Calculate price breakdown using seller-provided GST & shipping
    const basePrice = productPrice;
    const gstAmount = Math.round((basePrice * gstPercent) / 100);
    const totalPrice = basePrice + shippingCharges + gstAmount;

    // Get seller info
    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    // Create or reuse payment link
    const frontendUrl = getFrontendUrl();

    let paymentLink = await PaymentLink.findOne({
        postId,
        chatId,
        buyerId,
        status: 'active'
    });

    if (!paymentLink) {
        const linkId = generateLinkId();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId,
            buyerId,
            chatId,
            postId,
            productDetails: {
                name: productName,
                description: productDescription,
                price: totalPrice,
                images: productImages,
                category: productCategory
            },
            amount: totalPrice,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${totalPrice}`,
            shortUrl: `${frontendUrl}/p/${linkId}`
        });
    } else {
        // Update if needed
        const correctUrl = `${frontendUrl}/post/${postId}/pay/${totalPrice}`;
        if (paymentLink.paymentUrl !== correctUrl || paymentLink.amount !== totalPrice) {
            paymentLink.amount = totalPrice;
            paymentLink.paymentUrl = correctUrl;
            paymentLink.productDetails = {
                name: productName,
                description: productDescription,
                price: totalPrice,
                images: productImages,
                category: productCategory
            };
            await paymentLink.save();
        }
    }

    // Build the checkout message
    const checkoutText = `🛒 Checkout for "${productName}"\n\nBase Price: ₹${basePrice.toLocaleString('en-IN')}\nShipping: ${shippingCharges > 0 ? '₹' + shippingCharges.toLocaleString('en-IN') : 'FREE'}\nGST (${gstPercent}%): ₹${gstAmount.toLocaleString('en-IN')}\n\n💰 Total: ₹${totalPrice.toLocaleString('en-IN')}`;

    const recipients = chat.participants.filter(
        p => p.toString() !== sellerId.toString()
    );

    const checkoutMessage = await Message.create({
        chatId,
        sender: sellerId, // Message appears from seller (automated)
        message: checkoutText,
        messageType: 'checkout',
        timestamp: new Date(),
        readBy: [sellerId],
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        })),
        productReference: {
            postId: post._id,
            productName,
            productImage: productImages[0] || '',
            productPrice: totalPrice,
            productType,
            productDescription,
        },
        checkoutDetails: {
            postId: post._id,
            productName,
            productDescription,
            productImages,
            productCategory,
            productType,
            specifications,
            variants,
            deliveryOptions,
            sellerLocation,
            basePrice,
            shippingCharges,
            gstPercent,
            gstAmount,
            totalPrice,
            currency,
            sellerId,
            sellerName: seller?.fullName || '',
            sellerUsername: seller?.username || '',
            sellerAvatar: seller?.profileImageUrl || '',
            paymentLinkId: paymentLink.linkId,
            paymentUrl: '', // Will be set after message creation with messageId
            checkoutStatus: 'pending',
            expiresAt: paymentLink.expiresAt
        }
    });

    // Update paymentUrl to point to the full checkout page using messageId
    const checkoutPageUrl = `${frontendUrl}/checkout/${checkoutMessage._id}`;
    checkoutMessage.checkoutDetails.paymentUrl = checkoutPageUrl;
    await checkoutMessage.save();

    // Update chat's last message
    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: sellerId,
        message: `🛒 Checkout: ${productName} - ₹${totalPrice.toLocaleString('en-IN')}`,
        timestamp: new Date()
    };
    chat.lastMessageId = checkoutMessage._id;
    await chat.save();

    // Populate and emit via socket
    const populatedMessage = await Message.findById(checkoutMessage._id)
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    // Emit to chat room
    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    // Also emit directly to buyer
    safeEmitToUser(buyerId.toString(), 'new_message', {
        chatId,
        message: populatedMessage
    });

    return res.status(200).json(
        new ApiResponse(200, {
            purchaseMode: 'direct',
            checkoutMessage: populatedMessage,
            messageSent: true,
            message: "Checkout sent to buyer in chat",
            actions: {
                canProceedToPay: true,
                addressRequired: true,
                checkoutMessageId: checkoutMessage._id,
                paymentLinkId: paymentLink.linkId,
                totalPrice,
                currency
            }
        }, "Checkout message sent successfully")
    );
});

// ============================================
// E-COMMERCE CHECKOUT FLOW (Flipkart/Myntra style)
// ============================================

// GET checkout details from a checkout message (buyer views before paying)
export const getCheckoutDetails = asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findOne({
        _id: messageId,
        messageType: 'checkout',
        isDeleted: false
    }).populate('sender', 'username fullName profileImageUrl isBlueTickVerified');

    if (!message) {
        throw new ApiError(404, "Checkout message not found");
    }

    // Verify user is a participant in this chat
    const chat = await Chat.findOne({
        _id: message.chatId,
        participants: userId
    });

    if (!chat) {
        throw new ApiError(403, "Access denied");
    }

    const checkout = message.checkoutDetails;

    // Check if expired
    if (checkout.expiresAt && new Date() > checkout.expiresAt) {
        checkout.checkoutStatus = 'expired';
        message.checkoutDetails.checkoutStatus = 'expired';
        await message.save();
    }

    // Determine user role in this checkout
    const isBuyer = checkout.sellerId.toString() !== userId.toString();
    const isSeller = checkout.sellerId.toString() === userId.toString();

    // Build checkout policies based on user role (fixed for all products)
    const checkoutPolicies = {
        shippingPolicy: {
            estimatedDeliveryDays: "5-10",
            maxShippingDays: 15,
            description: "Estimated delivery within 5-10 business days. Maximum shipping time is 15 days from order confirmation. If the seller does not ship within this period, you may cancel the order for a full refund."
        },
        returnPolicy: {
            maxReturnDays: 7,
            returnConditions: [
                "Product must be in original condition with tags and packaging intact",
                "Return request must be raised within 7 days of delivery",
                "Opening video or photographic proof of damage is mandatory for return claims",
                "Refund will be processed within 5-7 business days after return approval"
            ],
            description: "You can request a return within 7 days of delivery if the product is damaged, defective, or not as described."
        },
        ...(isBuyer ? {
            buyerNotices: [
                {
                    type: "instruction",
                    title: "Record Package Opening",
                    message: "Please record a video while opening your package or take clear photos of the product upon arrival. This proof is required if you need to file a return or dispute.",
                    priority: "high"
                },
                {
                    type: "instruction",
                    title: "Return Policy",
                    message: "Returns are accepted within 7 days of delivery for damaged, defective, or misrepresented items. The product must be in its original condition with all tags and packaging intact.",
                    priority: "medium"
                },
                {
                    type: "info",
                    title: "Escrow Protection",
                    message: "Your payment is held securely in escrow and will only be released to the seller after you confirm delivery. If there is an issue, you can raise a dispute.",
                    priority: "medium"
                },
                {
                    type: "legal_warning",
                    title: "Fraudulent Payment Warning",
                    message: "Any fraudulent, unauthorized, or deceptive payment activity will result in immediate account suspension and legal action under applicable laws including the Information Technology Act, 2000 and Indian Penal Code. Findernate reserves the right to report such activities to law enforcement authorities.",
                    priority: "critical",
                    displayStyle: "red"
                }
            ]
        } : {}),
        ...(isSeller ? {
            sellerNotices: [
                {
                    type: "responsibility",
                    title: "Product Condition Responsibility",
                    message: "As the seller, you take full responsibility for ensuring the product is in proper condition before shipping. You are liable for any damage caused due to improper packaging or handling.",
                    priority: "high"
                },
                {
                    type: "instruction",
                    title: "Packing Proof Required",
                    message: "Record a packing video or take photos of the product before shipping. This proof protects you in case of a false damage claim by the buyer.",
                    priority: "high"
                },
                {
                    type: "info",
                    title: "Return & Refund Policy",
                    message: "If the buyer reports a damaged or defective item within 7 days of delivery with valid proof, you may be required to accept a return and a full or partial refund will be issued from escrow.",
                    priority: "medium"
                },
                {
                    type: "instruction",
                    title: "Shipping Timeline",
                    message: "You must ship the order within 15 days of payment confirmation. Failure to ship within this period may result in automatic order cancellation and refund to the buyer.",
                    priority: "high"
                }
            ]
        } : {})
    };

    return res.status(200).json(
        new ApiResponse(200, {
            messageId: message._id,
            chatId: message.chatId,
            userRole: isBuyer ? "buyer" : "seller",
            checkoutDetails: {
                postId: checkout.postId,
                productName: checkout.productName,
                productDescription: checkout.productDescription,
                productImages: checkout.productImages,
                productCategory: checkout.productCategory,
                productType: checkout.productType,
                specifications: checkout.specifications,
                variants: checkout.variants,
                deliveryOptions: checkout.deliveryOptions,
                sellerLocation: checkout.sellerLocation,
                priceBreakdown: {
                    basePrice: checkout.basePrice,
                    shippingCharges: checkout.shippingCharges,
                    gstPercent: checkout.gstPercent,
                    gstAmount: checkout.gstAmount,
                    totalPrice: checkout.totalPrice,
                    currency: checkout.currency
                },
                seller: {
                    _id: checkout.sellerId,
                    fullName: checkout.sellerName,
                    username: checkout.sellerUsername,
                    profileImageUrl: checkout.sellerAvatar
                },
                checkoutStatus: checkout.checkoutStatus,
                expiresAt: checkout.expiresAt
            },
            checkoutPolicies,
            actions: {
                canProceedToPay: checkout.checkoutStatus === 'pending',
                addressRequired: true,
                paymentLinkId: checkout.paymentLinkId
            }
        }, "Checkout details fetched")
    );
});

// Buyer initiates payment from checkout message (like clicking "Proceed to Pay")
export const initiateCheckoutPayment = asyncHandler(async (req, res) => {
    const { messageId, shippingAddress } = req.body;
    const buyerId = req.user._id;

    if (!messageId) {
        throw new ApiError(400, "Checkout message ID is required");
    }

    // Find the checkout message
    const message = await Message.findOne({
        _id: messageId,
        messageType: 'checkout',
        isDeleted: false
    });

    if (!message) {
        throw new ApiError(404, "Checkout message not found");
    }

    const checkout = message.checkoutDetails;

    // Verify buyer is in the chat
    const chat = await Chat.findOne({
        _id: message.chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(403, "Access denied");
    }

    // Don't let seller pay themselves
    if (checkout.sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot pay for your own product");
    }

    // Check checkout status
    if (checkout.checkoutStatus === 'paid') {
        throw new ApiError(400, "This checkout has already been paid");
    }

    if (checkout.expiresAt && new Date() > checkout.expiresAt) {
        message.checkoutDetails.checkoutStatus = 'expired';
        await message.save();
        throw new ApiError(400, "This checkout has expired. Ask the seller to send a new one.");
    }

    // Always validate shipping address
    if (!shippingAddress) {
        throw new ApiError(400, "Shipping address is required");
    }

    if (!shippingAddress.fullName || !shippingAddress.phoneNumber || !shippingAddress.addressLine1 || !shippingAddress.city || !shippingAddress.state || !shippingAddress.postalCode) {
        throw new ApiError(400, "Please provide complete shipping address (name, phone, address, city, state, pincode)");
    }

    // Find or reuse payment link
    const paymentLink = await PaymentLink.findOne({
        linkId: checkout.paymentLinkId,
        status: 'active'
    });

    if (!paymentLink) {
        throw new ApiError(400, "Payment link expired or not found. Ask seller to resend checkout.");
    }

    // Create order
    const orderNumber = generateOrderNumber();
    const order = await Order.create({
        orderNumber,
        buyerId,
        sellerId: checkout.sellerId,
        postId: checkout.postId,
        chatId: message.chatId,
        paymentLinkId: paymentLink._id,
        productDetails: {
            name: checkout.productName,
            description: checkout.productDescription,
            price: checkout.totalPrice,
            images: checkout.productImages,
            category: checkout.productCategory
        },
        amount: checkout.totalPrice,
        platformFee: 0,
        sellerAmount: checkout.totalPrice,
        shippingAddress: shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });

    // Create Razorpay order
    let razorpayOrder;
    try {
        razorpayOrder = await razorpay.orders.create({
            amount: checkout.totalPrice * 100, // paise
            currency: checkout.currency || 'INR',
            receipt: order.orderNumber,
            notes: {
                orderId: order._id.toString(),
                buyerId: buyerId.toString(),
                sellerId: checkout.sellerId.toString(),
                checkoutMessageId: messageId,
                type: 'checkout'
            }
        });
    } catch (razorpayError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = razorpayError?.error?.description || razorpayError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

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
            checkoutMessageId: messageId,
            productDetails: {
                name: checkout.productName,
                image: checkout.productImages?.[0] || '',
                totalPrice: checkout.totalPrice
            },
            seller: {
                name: checkout.sellerName,
                username: checkout.sellerUsername
            }
        }, "Razorpay order created - proceed to payment")
    );
});

// Verify checkout payment & update message status
export const verifyCheckoutPayment = asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, checkoutMessageId } = req.body;

    // Verify signature
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

    // Update order
    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    order.paymentStatus = 'held';
    order.orderStatus = 'payment_received';
    await order.save();

    // Update payment link
    await PaymentLink.findByIdAndUpdate(order.paymentLinkId, {
        status: 'paid',
        paidAt: new Date()
    });

    // Hold funds in escrow
    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.holdFunds(order, order.amount, `Payment for order ${order.orderNumber}`);

    // Update checkout message status to 'paid'
    if (checkoutMessageId) {
        const checkoutMessage = await Message.findById(checkoutMessageId);
        if (checkoutMessage && checkoutMessage.checkoutDetails) {
            checkoutMessage.checkoutDetails.checkoutStatus = 'paid';
            await checkoutMessage.save();

            // Send payment confirmation message in chat
            const buyer = await User.findById(order.buyerId).select('fullName username');
            const confirmationText = `✅ Payment Confirmed!\n\nOrder: #${order.orderNumber}\nAmount: ₹${order.amount.toLocaleString('en-IN')}\nProduct: ${checkoutMessage.checkoutDetails.productName}\n\nPayment is held securely in escrow. Seller will be notified to ship your order.`;

            const recipients = [];
            const chat = await Chat.findById(checkoutMessage.chatId);
            if (chat) {
                chat.participants.forEach(p => {
                    if (p.toString() !== order.buyerId.toString()) {
                        recipients.push(p);
                    }
                });
            }

            const confirmMsg = await Message.create({
                chatId: checkoutMessage.chatId,
                sender: order.buyerId,
                message: confirmationText,
                messageType: 'text',
                timestamp: new Date(),
                readBy: [order.buyerId],
                deliveryStatus: recipients.map(recipientId => ({
                    userId: recipientId,
                    status: 'sent',
                    deliveredAt: null,
                    seenAt: null
                }))
            });

            // Update chat last message
            if (chat) {
                chat.lastMessageAt = new Date();
                chat.lastMessage = {
                    sender: order.buyerId,
                    message: `✅ Payment confirmed for #${order.orderNumber}`,
                    timestamp: new Date()
                };
                chat.lastMessageId = confirmMsg._id;
                await chat.save();
            }

            // Emit socket events
            const populatedConfirm = await Message.findById(confirmMsg._id)
                .populate('sender', 'username fullName profileImageUrl')
                .lean();

            safeEmitToChat(checkoutMessage.chatId.toString(), 'new_message', {
                chatId: checkoutMessage.chatId,
                message: populatedConfirm
            });

            // Notify seller about the payment
            safeEmitToUser(order.sellerId.toString(), 'checkout_paid', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                orderId: order._id,
                orderNumber: order.orderNumber,
                amount: order.amount,
                buyerName: buyer?.fullName || 'Buyer'
            });

            // Notify buyer about updated checkout status
            safeEmitToUser(order.buyerId.toString(), 'checkout_status_updated', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                checkoutStatus: 'paid',
                orderId: order._id,
                orderNumber: order.orderNumber
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: order._id,
                orderNumber: order.orderNumber,
                orderStatus: order.orderStatus,
                paymentStatus: order.paymentStatus
            },
            checkoutStatus: 'paid',
            message: "Payment verified! Your order has been confirmed."
        }, "Checkout payment verified and held in escrow")
    );
});
