import {
    initiatePhonePePayment,
    checkPhonePePaymentStatus,
    verifyPhonePeWebhookSignature,
    generateMerchantTransactionId
} from "../config/phonepe.config.js";
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

// Create PhonePe payment for chat payment link
export const createPhonePeOrder = asyncHandler(async (req, res) => {
    const { linkId, shippingAddress } = req.body;
    const buyerId = req.user._id;

    const paymentLink = await PaymentLink.findOne({ linkId, status: 'active' });
    if (!paymentLink) {
        throw new ApiError(404, "Payment link not found or expired");
    }

    // --- IDEMPOTENCY: block if already paid, delete stale pending on retry ---
    if (paymentLink.orderId) {
        const existingOrder = await Order.findById(paymentLink.orderId);
        if (existingOrder?.paymentStatus === 'held' || existingOrder?.paymentStatus === 'released') {
            throw new ApiError(400, "Payment for this link has already been completed");
        }
        if (existingOrder?.paymentStatus === 'pending') {
            await Order.findByIdAndDelete(existingOrder._id);
            paymentLink.orderId = null;
            await paymentLink.save();
        }
    }

    const orderNumber = generateOrderNumber();
    const order = await Order.create({
        orderNumber,
        buyerId,
        sellerId: paymentLink.sellerId,
        postId: paymentLink.postId,
        chatId: paymentLink.chatId,
        paymentLinkId: paymentLink._id,
        productDetails: paymentLink.productDetails,
        amount: paymentLink.amount,
        platformFee: 0,
        sellerAmount: paymentLink.amount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });
    paymentLink.orderId = order._id;
    await paymentLink.save();

    const merchantTransactionId = generateMerchantTransactionId();
    const frontendUrl = getFrontendUrl();


    const phonePePayload = {
        merchantOrderId: merchantTransactionId,
        amount: paymentLink.amount * 100, // paise
        expireAfter: 1200,
        paymentFlow: {
            type: 'PG_CHECKOUT',
            message: `Payment for order ${order.orderNumber}`,
            merchantUrls: {
                redirectUrl: `${frontendUrl}/payment/success?txnId=${merchantTransactionId}&orderId=${order._id}`,
            }
        }
    };

    let phonePeResponse;
    try {
        phonePeResponse = await initiatePhonePePayment(phonePePayload);
    } catch (phonePeError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = phonePeError?.response?.data?.message || phonePeError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

    const redirectUrl = phonePeResponse?.redirectUrl;
    if (!redirectUrl) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment URL from PhonePe");
    }

    order.phonePeMerchantTransactionId = merchantTransactionId;
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, {
            merchantTransactionId,
            phonePeRedirectUrl: redirectUrl,
            orderId: order._id,
            orderNumber: order.orderNumber
        }, "PhonePe payment initiated")
    );
});

// Verify PhonePe payment and hold in escrow (called after redirect from PhonePe)
export const verifyPayment = asyncHandler(async (req, res) => {
    const { merchantTransactionId, orderId } = req.body;

    if (!merchantTransactionId || !orderId) {
        throw new ApiError(400, "merchantTransactionId and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    // --- IDEMPOTENCY GUARD: already verified (by this endpoint or webhook) ---
    if (order.paymentStatus === 'held' || order.paymentStatus === 'released') {
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: order._id,
                    orderNumber: order.orderNumber,
                    orderStatus: order.orderStatus,
                    paymentStatus: order.paymentStatus,
                    amount: order.amount,
                    productDetails: order.productDetails
                }
            }, "Payment already verified")
        );
    }

    // --- Verify with PhonePe ---
    let statusResponse;
    try {
        statusResponse = await checkPhonePePaymentStatus(merchantTransactionId);
    } catch (error) {
        throw new ApiError(400, "Failed to verify payment status with PhonePe");
    }

    if (statusResponse?.state !== 'COMPLETED') {
        order.paymentStatus = 'failed';
        order.orderStatus = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment failed: state=${statusResponse?.state || 'unknown'}`);
    }

    // --- Atomic guard: only one of verifyPayment / webhook wins ---
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            phonePeTransactionId: statusResponse?.transactionId,
            paymentStatus: 'held',
            orderStatus: 'payment_received'
        },
        { new: true }
    );

    if (!updated) {
        // Webhook already processed it — re-fetch and return
        const refreshed = await Order.findById(order._id);
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: refreshed._id,
                    orderNumber: refreshed.orderNumber,
                    orderStatus: refreshed.orderStatus,
                    paymentStatus: refreshed.paymentStatus,
                    amount: refreshed.amount,
                    productDetails: refreshed.productDetails
                }
            }, "Payment verified and held in escrow")
        );
    }

    await PaymentLink.findByIdAndUpdate(
        order.paymentLinkId,
        { status: 'paid', paidAt: new Date() }
    );
    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.holdFunds(updated, updated.amount, `Payment for order ${updated.orderNumber}`);

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: updated._id,
                orderNumber: updated.orderNumber,
                orderStatus: updated.orderStatus,
                paymentStatus: updated.paymentStatus,
                amount: updated.amount,
                productDetails: updated.productDetails
            }
        }, "Payment verified and held in escrow")
    );
});

// PhonePe S2S webhook handler (v2)
export const phonePeWebhook = asyncHandler(async (req, res) => {
    // v2 webhooks send Authorization: SHA256(username:password)
    const authHeader = req.headers['authorization'] || '';
    if (authHeader) {
        const isValid = verifyPhonePeWebhookSignature(authHeader);
        if (!isValid) {
            console.error('Invalid PhonePe webhook signature');
            return res.status(200).json({ status: 'ok' }); // always 200 to PhonePe
        }
    }

    // v2 body is plain JSON (not base64 encoded)
    const payload = req.body;
    const merchantOrderId = payload?.merchantOrderId || payload?.merchantTransactionId;
    const transactionId   = payload?.transactionId;
    const state           = payload?.state;

    if (state === 'COMPLETED' && merchantOrderId) {
        const order = await Order.findOne({ phonePeMerchantTransactionId: merchantOrderId });

        if (order && order.paymentStatus === 'pending') {
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, paymentStatus: 'pending' },
                {
                    phonePeTransactionId: transactionId,
                    paymentStatus: 'held',
                    orderStatus: 'payment_received'
                },
                { new: true }
            );
            if (updated) {
                await PaymentLink.findByIdAndUpdate(
                    order.paymentLinkId,
                    { status: 'paid', paidAt: new Date() }
                );
                const escrowWallet = await EscrowWallet.getWallet();
                await escrowWallet.holdFunds(updated, updated.amount, `Payment for order ${updated.orderNumber}`);
            }
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
        paymentUrl: `${frontendUrl}/checkout/${linkId}`,
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

// ============================================
// GET CHECKOUT DETAILS BY LINK ID (Public - for shareable checkout links)
// ============================================
export const getCheckoutByLinkId = asyncHandler(async (req, res) => {
    const { linkId } = req.params;

    const paymentLink = await PaymentLink.findOne({ linkId, isShareableLink: true })
        .populate('sellerId', 'fullName username profileImageUrl isBusinessProfile isBlueTickVerified');

    if (!paymentLink) {
        throw new ApiError(404, "Checkout link not found");
    }

    if (paymentLink.status === 'expired' || (paymentLink.expiresAt && new Date() > paymentLink.expiresAt)) {
        paymentLink.status = 'expired';
        await paymentLink.save();
        throw new ApiError(400, "Checkout link has expired");
    }

    if (paymentLink.status === 'paid') {
        throw new ApiError(400, "Payment already completed");
    }

    // Get the post for full details
    const post = await Post.findById(paymentLink.postId);
    if (!post) {
        throw new ApiError(404, "Product not found");
    }

    // Build detailed product info
    let productName = paymentLink.productDetails?.name || "Product";
    let productDescription = paymentLink.productDetails?.description || "";
    let productImages = paymentLink.productDetails?.images || [];
    let productCategory = paymentLink.productDetails?.category || "";
    let productType = post.contentType || "product";
    let specifications = [];
    let variants = [];
    let deliveryOptions = "offline";
    let sellerLocation = "";
    let shippingCharges = 0;
    let gstPercent = 0;

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || productCategory;
        specifications = p.specifications || [];
        variants = p.variants || [];
        deliveryOptions = p.deliveryOptions || "offline";
        shippingCharges = p.shippingCharges || 0;
        gstPercent = p.gstPercent || 0;
        if (p.location) {
            sellerLocation = p.location.name || p.location.address || p.location.city || "";
        }
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productCategory = s.category || productCategory;
        productType = "service";
        deliveryOptions = s.deliveryOptions || "offline";
        shippingCharges = s.shippingCharges || 0;
        gstPercent = s.gstPercent || 0;
        if (s.location) {
            sellerLocation = s.location.name || s.location.address || s.location.city || "";
        }
    }

    const basePrice = paymentLink.amount;
    const gstAmount = Math.round((basePrice * gstPercent) / 100);
    const totalPrice = basePrice + shippingCharges + gstAmount;

    const seller = paymentLink.sellerId;

    return res.status(200).json(
        new ApiResponse(200, {
            linkId: paymentLink.linkId,
            checkoutDetails: {
                postId: paymentLink.postId,
                productName,
                productDescription,
                productImages,
                productCategory,
                productType,
                specifications,
                variants,
                deliveryOptions,
                sellerLocation,
                priceBreakdown: {
                    basePrice,
                    shippingCharges,
                    gstPercent,
                    gstAmount,
                    totalPrice,
                    currency: paymentLink.currency || 'INR'
                },
                seller: {
                    _id: seller._id,
                    fullName: seller.fullName,
                    username: seller.username,
                    profileImageUrl: seller.profileImageUrl
                },
                checkoutStatus: paymentLink.status === 'active' ? 'pending' : paymentLink.status,
                expiresAt: paymentLink.expiresAt
            },
            userRole: 'buyer',
            checkoutPolicies: {
                shippingPolicy: {
                    estimatedDeliveryDays: '5-10',
                    maxShippingDays: 15,
                    description: 'Shipping is handled by the seller. Estimated delivery is 5-10 business days depending on your location. Tracking details will be shared once shipped.'
                },
                returnPolicy: {
                    maxReturnDays: 7,
                    returnConditions: [
                        'Item must be unused, unworn and in original packaging',
                        'Return request must be raised within 7 days of delivery',
                        'Record a video while opening the package for dispute support',
                        'Refunds are processed within 5-7 business days after return approval',
                        'Shipping costs for returns may be borne by the buyer unless the item is defective'
                    ],
                    description: 'Returns accepted within 7 days of delivery for eligible items. Items must be in original condition with tags and packaging intact.'
                },
                buyerNotices: [
                    {
                        type: 'escrow_protection',
                        title: 'Escrow Payment Protection',
                        message: 'Your payment is held securely in escrow and only released to the seller after you confirm delivery. If there is any issue, you can raise a dispute.',
                        priority: 'medium'
                    },
                    {
                        type: 'package_opening',
                        title: 'Record Package Opening',
                        message: 'We strongly recommend recording a video while opening your package. This is required as evidence if you need to file a return or dispute.',
                        priority: 'high'
                    },
                    {
                        type: 'fraud_warning',
                        title: 'Fraudulent Payment Warning',
                        message: 'Any fraudulent, unauthorized, or deceptive payment activity will result in immediate account suspension and legal action under applicable laws including the IT Act, 2000 and Indian Penal Code.',
                        priority: 'critical',
                        displayStyle: 'red'
                    }
                ]
            },
            actions: {
                canProceedToPay: paymentLink.status === 'active',
                addressRequired: true,
                paymentLinkId: paymentLink.linkId
            }
        }, "Checkout details fetched")
    );
});

// Create PhonePe payment for shareable payment link (can be used by guests too)
export const createShareablePhonePeOrder = asyncHandler(async (req, res) => {
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

    // --- DOUBLE BOOKING GUARD + IDEMPOTENCY ---
    if (buyerId) {
        const existingOrder = await Order.findOne({
            postId,
            buyerId,
            amount: numericAmount,
            paymentStatus: { $in: ['pending', 'held', 'released'] }
        });
        if (existingOrder?.paymentStatus === 'held' || existingOrder?.paymentStatus === 'released') {
            throw new ApiError(400, "You have already purchased this product");
        }
        if (existingOrder?.paymentStatus === 'pending') {
            await Order.findByIdAndDelete(existingOrder._id);
        }
    }

    const order = await Order.create({
        orderNumber: generateOrderNumber(),
        buyerId: buyerId || null,
        buyerDetails: !buyerId ? buyerDetails : undefined,
        sellerId: seller._id,
        postId,
        paymentLinkId: paymentLink._id,
        productDetails,
        amount: numericAmount,
        platformFee: 0,
        sellerAmount: numericAmount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending',
        isShareableOrder: true
    });

    const merchantTransactionId = generateMerchantTransactionId();
    const frontendUrl = getFrontendUrl();


    const phonePePayload = {
        merchantOrderId: merchantTransactionId,
        amount: numericAmount * 100, // paise
        expireAfter: 1200,
        paymentFlow: {
            type: 'PG_CHECKOUT',
            message: `Payment for ${productDetails.name}`,
            merchantUrls: {
                redirectUrl: `${frontendUrl}/payment/success?txnId=${merchantTransactionId}&orderId=${order._id}`,
            }
        }
    };

    let phonePeResponse;
    try {
        phonePeResponse = await initiatePhonePePayment(phonePePayload);
    } catch (phonePeError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = phonePeError?.response?.data?.message || phonePeError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

    const redirectUrl = phonePeResponse?.redirectUrl;
    if (!redirectUrl) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment URL from PhonePe");
    }

    order.phonePeMerchantTransactionId = merchantTransactionId;
    await order.save();

    paymentLink.orderId = order._id;
    await paymentLink.save();

    return res.status(200).json(
        new ApiResponse(200, {
            merchantTransactionId,
            phonePeRedirectUrl: redirectUrl,
            orderId: order._id,
            orderNumber: order.orderNumber,
            seller: {
                name: seller.fullName,
                username: seller.username
            }
        }, "PhonePe payment initiated for shareable link")
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

    // Determine user role
    const isSeller = checkout.sellerId?.toString() === userId.toString();
    const userRole = isSeller ? 'seller' : 'buyer';

    return res.status(200).json(
        new ApiResponse(200, {
            messageId: message._id,
            chatId: message.chatId,
            userRole,
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
            checkoutPolicies: {
                shippingPolicy: {
                    estimatedDeliveryDays: '5-10',
                    maxShippingDays: 15,
                    description: 'Shipping is handled by the seller. Estimated delivery is 5-10 business days depending on your location. Tracking details will be shared once shipped.'
                },
                returnPolicy: {
                    maxReturnDays: 7,
                    returnConditions: [
                        'Item must be unused, unworn and in original packaging',
                        'Return request must be raised within 7 days of delivery',
                        'Record a video while opening the package for dispute support',
                        'Refunds are processed within 5-7 business days after return approval',
                        'Shipping costs for returns may be borne by the buyer unless the item is defective'
                    ],
                    description: 'Returns accepted within 7 days of delivery for eligible items. Items must be in original condition with tags and packaging intact.'
                },
                buyerNotices: !isSeller ? [
                    {
                        type: 'escrow_protection',
                        title: 'Escrow Payment Protection',
                        message: 'Your payment is held securely in escrow and only released to the seller after you confirm delivery. If there is any issue, you can raise a dispute.',
                        priority: 'medium'
                    },
                    {
                        type: 'package_opening',
                        title: 'Record Package Opening',
                        message: 'We strongly recommend recording a video while opening your package. This is required as evidence if you need to file a return or dispute.',
                        priority: 'high'
                    },
                    {
                        type: 'fraud_warning',
                        title: 'Fraudulent Payment Warning',
                        message: 'Any fraudulent, unauthorized, or deceptive payment activity will result in immediate account suspension and legal action under applicable laws including the IT Act, 2000 and Indian Penal Code.',
                        priority: 'critical',
                        displayStyle: 'red'
                    }
                ] : [],
                sellerNotices: isSeller ? [
                    {
                        type: 'seller_info',
                        title: 'Seller View',
                        message: 'You are viewing this checkout as the seller. You cannot purchase your own product. Share this checkout link with your buyers.',
                        priority: 'medium'
                    }
                ] : []
            },
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

    // --- DOUBLE BOOKING GUARD + IDEMPOTENCY ---
    const existingCheckoutOrder = await Order.findOne({
        paymentLinkId: paymentLink._id,
        buyerId,
        paymentStatus: { $in: ['pending', 'held', 'released'] }
    });
    if (existingCheckoutOrder?.paymentStatus === 'held' || existingCheckoutOrder?.paymentStatus === 'released') {
        throw new ApiError(400, "Payment for this checkout has already been completed");
    }
    if (existingCheckoutOrder?.paymentStatus === 'pending') {
        await Order.findByIdAndDelete(existingCheckoutOrder._id);
    }

    const order = await Order.create({
        orderNumber: generateOrderNumber(),
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
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });
    paymentLink.orderId = order._id;
    await paymentLink.save();

    const merchantTransactionId = generateMerchantTransactionId();
    const frontendUrl = getFrontendUrl();


    const phonePePayload = {
        merchantOrderId: merchantTransactionId,
        amount: checkout.totalPrice * 100, // paise
        expireAfter: 1200,
        paymentFlow: {
            type: 'PG_CHECKOUT',
            message: `Payment for ${checkout.productName}`,
            merchantUrls: {
                redirectUrl: `${frontendUrl}/payment/success?txnId=${merchantTransactionId}&orderId=${order._id}&msgId=${messageId}`,
            }
        }
    };

    let phonePeResponse;
    try {
        phonePeResponse = await initiatePhonePePayment(phonePePayload);
    } catch (phonePeError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = phonePeError?.response?.data?.message || phonePeError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

    const redirectUrl = phonePeResponse?.redirectUrl;
    if (!redirectUrl) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment URL from PhonePe");
    }

    order.phonePeMerchantTransactionId = merchantTransactionId;
    await order.save();

    paymentLink.orderId = order._id;
    await paymentLink.save();

    return res.status(200).json(
        new ApiResponse(200, {
            merchantTransactionId,
            phonePeRedirectUrl: redirectUrl,
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
        }, "PhonePe payment initiated - proceed to payment")
    );
});

// Verify checkout payment & update message status
export const verifyCheckoutPayment = asyncHandler(async (req, res) => {
    const { merchantTransactionId, orderId, checkoutMessageId } = req.body;

    if (!merchantTransactionId || !orderId) {
        throw new ApiError(400, "merchantTransactionId and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.paymentStatus === 'held' || order.paymentStatus === 'released') {
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: order._id,
                    orderNumber: order.orderNumber,
                    orderStatus: order.orderStatus,
                    paymentStatus: order.paymentStatus,
                    amount: order.amount,
                    productDetails: order.productDetails
                },
                checkoutStatus: 'paid',
                message: "Payment already verified!"
            }, "Payment already verified")
        );
    }

    // Verify with PhonePe
    let statusResponse;
    try {
        statusResponse = await checkPhonePePaymentStatus(merchantTransactionId);
    } catch (error) {
        throw new ApiError(400, "Failed to verify payment status with PhonePe");
    }

    if (statusResponse?.state !== 'COMPLETED') {
        order.paymentStatus = 'failed';
        order.orderStatus = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment failed: state=${statusResponse?.state || 'unknown'}`);
    }

    // Atomic guard: only one of verifyCheckoutPayment / webhook wins
    const activeOrder = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            phonePeTransactionId: statusResponse?.transactionId,
            paymentStatus: 'held',
            orderStatus: 'payment_received'
        },
        { new: true }
    );

    if (!activeOrder) {
        // Webhook already processed — re-fetch and return
        const refreshed = await Order.findById(order._id);
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: refreshed._id,
                    orderNumber: refreshed.orderNumber,
                    orderStatus: refreshed.orderStatus,
                    paymentStatus: refreshed.paymentStatus,
                    amount: refreshed.amount,
                    productDetails: refreshed.productDetails
                },
                checkoutStatus: 'paid',
                message: "Payment already verified!"
            }, "Payment already verified")
        );
    }

    await PaymentLink.findByIdAndUpdate(
        activeOrder.paymentLinkId,
        { status: 'paid', paidAt: new Date() }
    );
    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.holdFunds(activeOrder, activeOrder.amount, `Payment for order ${activeOrder.orderNumber}`);

    let populatedConfirm;
    if (checkoutMessageId) {
        const checkoutMessage = await Message.findById(checkoutMessageId);
        if (checkoutMessage && checkoutMessage.checkoutDetails) {
            checkoutMessage.checkoutDetails.checkoutStatus = 'paid';
            await checkoutMessage.save();

            const confirmationText = `✅ Payment Confirmed!\n\nOrder: #${activeOrder.orderNumber}\nAmount: ₹${activeOrder.amount.toLocaleString('en-IN')}\nProduct: ${checkoutMessage.checkoutDetails.productName}\n\nPayment is held securely in escrow. Seller will be notified to ship your order.`;

            const recipients = [];
            const chat = await Chat.findById(checkoutMessage.chatId);
            if (chat) {
                chat.participants.forEach(p => {
                    if (p.toString() !== activeOrder.buyerId.toString()) recipients.push(p);
                });
            }

            const confirmMsg = await Message.create({
                chatId: checkoutMessage.chatId,
                sender: activeOrder.buyerId,
                message: confirmationText,
                messageType: 'text',
                timestamp: new Date(),
                readBy: [activeOrder.buyerId],
                deliveryStatus: recipients.map(recipientId => ({
                    userId: recipientId,
                    status: 'sent',
                    deliveredAt: null,
                    seenAt: null
                }))
            });

            if (chat) {
                chat.lastMessageAt = new Date();
                chat.lastMessage = {
                    sender: activeOrder.buyerId,
                    message: `✅ Payment confirmed for #${activeOrder.orderNumber}`,
                    timestamp: new Date()
                };
                chat.lastMessageId = confirmMsg._id;
                await chat.save();
            }

            populatedConfirm = { _id: confirmMsg._id, chatId: confirmMsg.chatId };
        }
    }

    // Emit socket events
    if (checkoutMessageId && populatedConfirm) {
        const checkoutMessage = await Message.findById(checkoutMessageId);
        if (checkoutMessage) {
            const fullConfirm = await Message.findById(populatedConfirm._id)
                .populate('sender', 'username fullName profileImageUrl')
                .lean();

            if (fullConfirm) {
                safeEmitToChat(checkoutMessage.chatId.toString(), 'new_message', {
                    chatId: checkoutMessage.chatId,
                    message: fullConfirm
                });
            }

            safeEmitToUser(activeOrder.sellerId.toString(), 'checkout_paid', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                orderId: activeOrder._id,
                orderNumber: activeOrder.orderNumber,
                amount: activeOrder.amount
            });

            safeEmitToUser(activeOrder.buyerId.toString(), 'checkout_status_updated', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                checkoutStatus: 'paid',
                orderId: activeOrder._id,
                orderNumber: activeOrder.orderNumber
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: activeOrder._id,
                orderNumber: activeOrder.orderNumber,
                orderStatus: activeOrder.orderStatus,
                paymentStatus: activeOrder.paymentStatus,
                amount: activeOrder.amount,
                productDetails: activeOrder.productDetails
            },
            checkoutStatus: 'paid',
            message: "Payment verified! Your order has been confirmed."
        }, "Checkout payment verified and held in escrow")
    );
});
