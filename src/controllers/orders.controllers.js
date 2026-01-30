import mongoose from "mongoose";
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

// Get count of new orders for seller (orders that need to be shipped)
export const getSellerNewOrdersCount = asyncHandler(async (req, res) => {
    const sellerId = req.user._id;

    // Count orders with 'payment_received' status - these need seller action (shipping)
    const newOrdersCount = await Order.countDocuments({
        sellerId,
        orderStatus: 'payment_received'
    });

    return res.status(200).json(
        new ApiResponse(200, { newOrdersCount }, "New orders count fetched")
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
        throw new ApiError(403, "Only the seller can mark order as shipped");
    }

    if (order.orderStatus !== 'payment_received' && order.orderStatus !== 'processing') {
        throw new ApiError(400, "Order cannot be shipped in current status");
    }

    order.orderStatus = 'shipped';
    order.shippingInfo = {
        ...order.shippingInfo,
        trackingId: trackingId || order.shippingInfo?.trackingId,
        carrier: carrier || order.shippingInfo?.carrier,
        shippedAt: new Date(),
        packingVideoUrl: packingVideoUrl || order.shippingInfo?.packingVideoUrl,
        packingImages: packingImages && packingImages.length > 0
            ? [...(order.shippingInfo?.packingImages || []), ...packingImages].slice(0, 10)
            : order.shippingInfo?.packingImages
    };
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order marked as shipped")
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
        throw new ApiError(403, "Only the seller can mark order as delivered");
    }

    if (order.orderStatus !== 'shipped') {
        throw new ApiError(400, "Order must be shipped first");
    }

    order.orderStatus = 'delivered';
    if (!order.shippingInfo) {
        order.shippingInfo = {};
    }
    order.shippingInfo.deliveredAt = new Date();
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order marked as delivered")
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
        throw new ApiError(403, "Only the buyer can confirm delivery");
    }

    if (order.orderStatus !== 'delivered' && order.orderStatus !== 'shipped') {
        throw new ApiError(400, "Order must be shipped or delivered first");
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

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Delivery confirmed and payment released to seller")
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

    if (!paymentScreenshot) {
        throw new ApiError(400, "Payment screenshot URL is required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Only the buyer can upload payment proof");
    }

    // Validate order status
    const allowedStatuses = ['payment_received', 'processing', 'shipped', 'delivered'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Cannot upload payment proof for this order status");
    }

    order.buyerProof = {
        ...order.buyerProof,
        paymentScreenshot,
        uploadedAt: new Date()
    };
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Payment proof uploaded successfully")
    );
});

// Seller uploads packing video/images
export const uploadPackingMedia = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { packingVideoUrl, packingImages } = req.body;
    const sellerId = req.user._id;

    if (!packingVideoUrl && (!packingImages || packingImages.length === 0)) {
        throw new ApiError(400, "At least one media file (video or images) is required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Only the seller can upload packing media");
    }

    // Validate order status
    const allowedStatuses = ['payment_received', 'processing', 'shipped'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Cannot upload packing media for this order status");
    }

    // Initialize shippingInfo if it doesn't exist
    if (!order.shippingInfo) {
        order.shippingInfo = {};
    }

    // Update packing video if provided
    if (packingVideoUrl) {
        order.shippingInfo.packingVideoUrl = packingVideoUrl;
    }

    // Append new images to existing ones (limit to 10 total)
    if (packingImages && packingImages.length > 0) {
        const existingImages = order.shippingInfo.packingImages || [];
        const allImages = [...existingImages, ...packingImages].slice(0, 10);
        order.shippingInfo.packingImages = allImages;
    }

    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Packing media uploaded successfully")
    );
});

// Buyer uploads opening video
export const uploadOpeningVideo = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { openingVideoUrl } = req.body;
    const buyerId = req.user._id;

    if (!openingVideoUrl) {
        throw new ApiError(400, "Opening video URL is required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Only the buyer can upload opening video");
    }

    // Validate order status - only allow after shipment
    const allowedStatuses = ['shipped', 'delivered'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Can only upload opening video after shipment");
    }

    order.buyerProof = {
        ...order.buyerProof,
        openingVideoUrl,
        uploadedAt: order.buyerProof?.uploadedAt || new Date()
    };
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Opening video uploaded successfully")
    );
});

// Seller rates buyer
export const rateBuyer = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review } = req.body;
    const sellerId = req.user._id;

    if (!rating || rating < 1 || rating > 5) {
        throw new ApiError(400, "Rating must be between 1 and 5");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.sellerId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "Only the seller can rate the buyer");
    }

    if (!['confirmed', 'delivered'].includes(order.orderStatus)) {
        throw new ApiError(400, "Order must be delivered or confirmed to rate the buyer");
    }

    if (order.sellerRating) {
        throw new ApiError(400, "You have already rated this buyer");
    }

    order.sellerRating = rating;
    order.sellerReview = review;
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Buyer rated successfully")
    );
});

// Buyer rates seller (dedicated endpoint, separate from confirmDelivery)
export const rateSeller = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review } = req.body;
    const buyerId = req.user._id;

    if (!rating || rating < 1 || rating > 5) {
        throw new ApiError(400, "Rating must be between 1 and 5");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.buyerId.toString() !== buyerId.toString()) {
        throw new ApiError(403, "Only the buyer can rate the seller");
    }

    if (!['confirmed', 'delivered'].includes(order.orderStatus)) {
        throw new ApiError(400, "Order must be delivered or confirmed to rate the seller");
    }

    if (order.buyerRating) {
        throw new ApiError(400, "You have already rated this seller");
    }

    order.buyerRating = rating;
    order.buyerReview = review;
    await order.save();

    // Populate and return updated order
    const updatedOrder = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Seller rated successfully")
    );
});

// Enhanced buyer order history with advanced filtering
export const getBuyerOrderHistory = asyncHandler(async (req, res) => {
    const {
        status,
        paymentStatus,
        startDate,
        endDate,
        minAmount,
        maxAmount,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        page = 1,
        limit = 20
    } = req.query;

    const buyerId = req.user._id;
    const query = { buyerId };

    // Status filters
    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    // Date range filter
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Amount range filter
    if (minAmount || maxAmount) {
        query.amount = {};
        if (minAmount) query.amount.$gte = parseFloat(minAmount);
        if (maxAmount) query.amount.$lte = parseFloat(maxAmount);
    }

    // Search by order number or product name
    if (search) {
        query.$or = [
            { orderNumber: { $regex: search, $options: 'i' } },
            { 'productDetails.name': { $regex: search, $options: 'i' } }
        ];
    }

    // Sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const orders = await Order.find(query)
        .populate('sellerId', 'fullName username profileImageUrl')
        .populate('postId', 'media caption')
        .sort(sortConfig)
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    // Calculate summary statistics
    const stats = await Order.aggregate([
        { $match: { buyerId: new mongoose.Types.ObjectId(buyerId) } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalSpent: { $sum: '$amount' },
                completedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'confirmed'] }, 1, 0] }
                },
                pendingOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['payment_received', 'processing', 'shipped', 'delivered']] }, 1, 0] }
                },
                cancelledOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['cancelled', 'refunded']] }, 1, 0] }
                }
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit),
            stats: stats[0] || { totalOrders: 0, totalSpent: 0, completedOrders: 0, pendingOrders: 0, cancelledOrders: 0 }
        }, "Buyer order history fetched")
    );
});

// Enhanced seller order history with advanced filtering
export const getSellerOrderHistory = asyncHandler(async (req, res) => {
    const {
        status,
        paymentStatus,
        startDate,
        endDate,
        minAmount,
        maxAmount,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        page = 1,
        limit = 20
    } = req.query;

    const sellerId = req.user._id;
    const query = { sellerId };

    // Status filters
    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    // Date range filter
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Amount range filter
    if (minAmount || maxAmount) {
        query.amount = {};
        if (minAmount) query.amount.$gte = parseFloat(minAmount);
        if (maxAmount) query.amount.$lte = parseFloat(maxAmount);
    }

    // Search by order number or product name
    if (search) {
        query.$or = [
            { orderNumber: { $regex: search, $options: 'i' } },
            { 'productDetails.name': { $regex: search, $options: 'i' } }
        ];
    }

    // Sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl')
        .populate('postId', 'media caption')
        .sort(sortConfig)
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    // Calculate summary statistics
    const stats = await Order.aggregate([
        { $match: { sellerId: new mongoose.Types.ObjectId(sellerId) } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalEarned: { $sum: '$sellerAmount' },
                completedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'confirmed'] }, 1, 0] }
                },
                pendingOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['payment_received', 'processing', 'shipped', 'delivered']] }, 1, 0] }
                },
                cancelledOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['cancelled', 'refunded']] }, 1, 0] }
                }
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit),
            stats: stats[0] || { totalOrders: 0, totalEarned: 0, completedOrders: 0, pendingOrders: 0, cancelledOrders: 0 }
        }, "Seller order history fetched")
    );
});

// Get buyer order statistics
export const getBuyerOrderStatistics = asyncHandler(async (req, res) => {
    const buyerId = new mongoose.Types.ObjectId(req.user._id);
    const { year, month } = req.query;

    const matchQuery = { buyerId };

    // Optional date filtering for specific year/month
    if (year) {
        const startDate = new Date(year, month ? month - 1 : 0, 1);
        const endDate = month
            ? new Date(year, month, 0, 23, 59, 59)
            : new Date(year, 11, 31, 23, 59, 59);

        matchQuery.createdAt = { $gte: startDate, $lte: endDate };
    }

    // Overall statistics
    const overallStats = await Order.aggregate([
        { $match: { buyerId: buyerId } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalSpent: { $sum: '$amount' },
                averageOrderValue: { $avg: '$amount' },
                completedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'confirmed'] }, 1, 0] }
                },
                pendingOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['payment_received', 'processing', 'shipped', 'delivered']] }, 1, 0] }
                },
                disputedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'disputed'] }, 1, 0] }
                },
                cancelledOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['cancelled', 'refunded']] }, 1, 0] }
                }
            }
        }
    ]);

    // Category-wise spending
    const categoryStats = await Order.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: '$productDetails.category',
                totalSpent: { $sum: '$amount' },
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { totalSpent: -1 } },
        { $limit: 10 }
    ]);

    // Monthly spending trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
        {
            $match: {
                buyerId: buyerId,
                createdAt: { $gte: sixMonthsAgo }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' }
                },
                totalSpent: { $sum: '$amount' },
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    // Status breakdown
    const statusBreakdown = await Order.aggregate([
        { $match: { buyerId: buyerId } },
        {
            $group: {
                _id: '$orderStatus',
                count: { $sum: 1 }
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            overall: overallStats[0] || {},
            categoryStats,
            monthlyTrend,
            statusBreakdown
        }, "Buyer order statistics fetched")
    );
});

// Get seller order statistics
export const getSellerOrderStatistics = asyncHandler(async (req, res) => {
    const sellerId = new mongoose.Types.ObjectId(req.user._id);
    const { year, month } = req.query;

    const matchQuery = { sellerId };

    // Optional date filtering for specific year/month
    if (year) {
        const startDate = new Date(year, month ? month - 1 : 0, 1);
        const endDate = month
            ? new Date(year, month, 0, 23, 59, 59)
            : new Date(year, 11, 31, 23, 59, 59);

        matchQuery.createdAt = { $gte: startDate, $lte: endDate };
    }

    // Overall statistics
    const overallStats = await Order.aggregate([
        { $match: { sellerId: sellerId } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalRevenue: { $sum: '$amount' },
                totalEarned: { $sum: '$sellerAmount' },
                platformFees: { $sum: '$platformFee' },
                averageOrderValue: { $avg: '$amount' },
                completedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'confirmed'] }, 1, 0] }
                },
                pendingOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['payment_received', 'processing', 'shipped', 'delivered']] }, 1, 0] }
                },
                disputedOrders: {
                    $sum: { $cond: [{ $eq: ['$orderStatus', 'disputed'] }, 1, 0] }
                },
                cancelledOrders: {
                    $sum: { $cond: [{ $in: ['$orderStatus', ['cancelled', 'refunded']] }, 1, 0] }
                }
            }
        }
    ]);

    // Product-wise sales
    const productStats = await Order.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: '$productDetails.name',
                totalRevenue: { $sum: '$amount' },
                orderCount: { $sum: 1 },
                averagePrice: { $avg: '$amount' }
            }
        },
        { $sort: { orderCount: -1 } },
        { $limit: 10 }
    ]);

    // Monthly revenue trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
        {
            $match: {
                sellerId: sellerId,
                createdAt: { $gte: sixMonthsAgo }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' }
                },
                totalRevenue: { $sum: '$amount' },
                totalEarned: { $sum: '$sellerAmount' },
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    // Status breakdown
    const statusBreakdown = await Order.aggregate([
        { $match: { sellerId: sellerId } },
        {
            $group: {
                _id: '$orderStatus',
                count: { $sum: 1 }
            }
        }
    ]);

    // Average ratings
    const ratingStats = await Order.aggregate([
        {
            $match: {
                sellerId: sellerId,
                buyerRating: { $exists: true, $ne: null }
            }
        },
        {
            $group: {
                _id: null,
                averageRating: { $avg: '$buyerRating' },
                totalRatings: { $sum: 1 }
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            overall: overallStats[0] || {},
            productStats,
            monthlyTrend,
            statusBreakdown,
            ratings: ratingStats[0] || { averageRating: 0, totalRatings: 0 }
        }, "Seller order statistics fetched")
    );
});

// Export orders to CSV
export const exportOrdersToCSV = asyncHandler(async (req, res) => {
    const { type = 'buyer', status, startDate, endDate } = req.query;
    const userId = req.user._id;

    const query = type === 'buyer' ? { buyerId: userId } : { sellerId: userId };

    if (status) query.orderStatus = status;
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username')
        .populate('sellerId', 'fullName username')
        .sort({ createdAt: -1 });

    // Generate CSV content
    const headers = [
        'Order Number',
        'Date',
        'Product',
        type === 'buyer' ? 'Seller' : 'Buyer',
        'Amount',
        'Order Status',
        'Payment Status'
    ].join(',');

    const rows = orders.map(order => {
        const counterParty = type === 'buyer'
            ? (order.sellerId?.fullName || order.sellerId?.username || 'N/A')
            : (order.buyerId?.fullName || order.buyerId?.username || order.buyerDetails?.fullName || 'Guest');

        return [
            order.orderNumber,
            new Date(order.createdAt).toLocaleDateString(),
            `"${order.productDetails.name}"`,
            counterParty,
            order.amount,
            order.orderStatus,
            order.paymentStatus
        ].join(',');
    });

    const csv = [headers, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders_${type}_${Date.now()}.csv"`);

    return res.status(200).send(csv);
});
