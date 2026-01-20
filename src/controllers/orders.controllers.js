import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Order from "../models/order.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";

// Get order details
export const getOrderDetails = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user._id;

    const order = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl')
        .populate('sellerId', 'fullName username profileImageUrl')
        .populate('postId', 'media caption');

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId._id.toString() !== userId.toString() &&
        order.sellerId._id.toString() !== userId.toString()) {
        throw new ApiError(403, "Not authorized to view this order");
    }

    return res.status(200).json(
        new ApiResponse(200, { order }, "Order details fetched")
    );
});

// Get buyer's orders
export const getBuyerOrders = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const buyerId = req.user._id;

    const query = { buyerId };
    if (status) query.orderStatus = status;

    const orders = await Order.find(query)
        .populate('sellerId', 'fullName username profileImageUrl')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    return res.status(200).json(
        new ApiResponse(200, { orders, total, page: parseInt(page), totalPages: Math.ceil(total / limit) }, "Buyer orders fetched")
    );
});

// Get seller's orders
export const getSellerOrders = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const sellerId = req.user._id;

    const query = { sellerId };
    if (status) query.orderStatus = status;

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    return res.status(200).json(
        new ApiResponse(200, { orders, total, page: parseInt(page), totalPages: Math.ceil(total / limit) }, "Seller orders fetched")
    );
});

// Seller marks order as shipped
export const markOrderShipped = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { trackingId, carrier, packingVideoUrl, packingImages } = req.body;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    if (order.orderStatus !== 'payment_received' && order.orderStatus !== 'processing') {
        throw new ApiError(400, "Order cannot be shipped in current status");
    }

    order.orderStatus = 'shipped';
    order.shippingInfo = {
        trackingId,
        carrier,
        shippedAt: new Date(),
        packingVideoUrl,
        packingImages
    };
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Order marked as shipped")
    );
});

// Seller marks order as delivered
export const markOrderDelivered = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    if (order.orderStatus !== 'shipped') {
        throw new ApiError(400, "Order must be shipped first");
    }

    order.orderStatus = 'delivered';
    order.shippingInfo.deliveredAt = new Date();
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Order marked as delivered")
    );
});

// Buyer confirms delivery - releases payment to seller
export const confirmDelivery = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review, openingVideoUrl } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    if (order.orderStatus !== 'delivered' && order.orderStatus !== 'shipped') {
        throw new ApiError(400, "Order must be delivered first");
    }

    order.orderStatus = 'confirmed';
    order.paymentStatus = 'released';
    order.deliveryConfirmedAt = new Date();
    order.paymentReleasedAt = new Date();

    if (rating) order.buyerRating = rating;
    if (review) order.buyerReview = review;
    if (openingVideoUrl) {
        order.buyerProof = { ...order.buyerProof, openingVideoUrl, uploadedAt: new Date() };
    }

    await order.save();

    const escrowWallet = await EscrowWallet.getWallet();
    // No platform fee - release full amount to seller
    await escrowWallet.releaseFunds(order, order.amount, 0, `Payment released for order ${order.orderNumber}`);

    return res.status(200).json(
        new ApiResponse(200, { order }, "Delivery confirmed and payment released to seller")
    );
});

// Buyer reports issue / requests return
export const reportIssue = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason, description, evidence } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    if (!reason) {
        throw new ApiError(400, "Reason is required");
    }

    order.orderStatus = 'disputed';
    order.dispute = {
        reason,
        description,
        evidence: evidence || [],
        status: 'open',
        createdAt: new Date()
    };
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Issue reported, payment held until resolution")
    );
});

// Buyer uploads payment proof
export const uploadPaymentProof = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { paymentScreenshot } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    order.buyerProof = {
        ...order.buyerProof,
        paymentScreenshot,
        uploadedAt: new Date()
    };
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Payment proof uploaded")
    );
});

// Seller uploads packing video/images
export const uploadPackingMedia = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { packingVideoUrl, packingImages } = req.body;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    order.shippingInfo = {
        ...order.shippingInfo,
        packingVideoUrl: packingVideoUrl || order.shippingInfo?.packingVideoUrl,
        packingImages: packingImages || order.shippingInfo?.packingImages
    };
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Packing media uploaded")
    );
});

// Buyer uploads opening video
export const uploadOpeningVideo = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { openingVideoUrl } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    order.buyerProof = {
        ...order.buyerProof,
        openingVideoUrl,
        uploadedAt: new Date()
    };
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Opening video uploaded")
    );
});

// Seller rates buyer
export const rateBuyer = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review } = req.body;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Not authorized");
    }

    if (order.orderStatus !== 'confirmed') {
        throw new ApiError(400, "Order must be confirmed to rate");
    }

    order.sellerRating = rating;
    order.sellerReview = review;
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Buyer rated successfully")
    );
});
