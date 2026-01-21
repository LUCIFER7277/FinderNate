import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Order from "../models/order.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";

// Get escrow wallet dashboard (Admin only)
export const getEscrowDashboard = asyncHandler(async (req, res) => {
    const wallet = await EscrowWallet.getWallet();

    const stats = {
        totalBalance: wallet.totalBalance,
        heldBalance: wallet.heldBalance,
        releasedBalance: wallet.releasedBalance,
        refundedBalance: wallet.refundedBalance,
        platformEarnings: wallet.platformEarnings,
        lastUpdated: wallet.lastUpdated
    };

    const pendingOrders = await Order.countDocuments({ paymentStatus: 'held' });
    const disputedOrders = await Order.countDocuments({ orderStatus: 'disputed' });
    const completedOrders = await Order.countDocuments({ paymentStatus: 'released' });

    return res.status(200).json(
        new ApiResponse(200, {
            wallet: stats,
            orderStats: {
                pendingRelease: pendingOrders,
                disputed: disputedOrders,
                completed: completedOrders
            }
        }, "Escrow dashboard fetched")
    );
});

// Get escrow transactions (Admin only)
export const getEscrowTransactions = asyncHandler(async (req, res) => {
    const { page = 1, limit = 50, type } = req.query;

    const wallet = await EscrowWallet.getWallet();

    let transactions = wallet.transactions;

    if (type) {
        transactions = transactions.filter(t => t.type === type);
    }

    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = transactions.length;
    const start = (page - 1) * limit;
    const paginatedTransactions = transactions.slice(start, start + parseInt(limit));

    return res.status(200).json(
        new ApiResponse(200, {
            transactions: paginatedTransactions,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "Escrow transactions fetched")
    );
});

// Get all orders (Admin only)
export const getAllOrders = asyncHandler(async (req, res) => {
    const { status, paymentStatus, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl')
        .populate('sellerId', 'fullName username profileImageUrl')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "All orders fetched")
    );
});

// Get disputed orders (Admin only)
export const getDisputedOrders = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;

    const orders = await Order.find({ orderStatus: 'disputed' })
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .sort({ 'dispute.createdAt': -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments({ orderStatus: 'disputed' });

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "Disputed orders fetched")
    );
});

// Resolve dispute (Admin only)
export const resolveDispute = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { resolution, action, refundPercentage = 100 } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.orderStatus !== 'disputed') {
        throw new ApiError(400, "Order is not in disputed status");
    }

    if (order.paymentStatus !== 'held') {
        throw new ApiError(400, "Payment is not in held status - cannot resolve");
    }

    const escrowWallet = await EscrowWallet.getWallet();

    if (action === 'refund_buyer') {
        const refundAmount = Math.round(order.amount * (refundPercentage / 100));
        await escrowWallet.refundFunds(order, refundAmount, `Refund for dispute resolution - Order ${order.orderNumber}`);
        order.paymentStatus = 'refunded';
        order.orderStatus = 'refunded';
    } else if (action === 'release_seller') {
        // No platform fee - release full amount to seller
        await escrowWallet.releaseFunds(order, order.amount, 0, `Payment released after dispute resolution - Order ${order.orderNumber}`);
        order.paymentStatus = 'released';
        order.orderStatus = 'confirmed';
    } else if (action === 'partial_refund') {
        const refundAmount = Math.round(order.amount * (refundPercentage / 100));
        const releaseAmount = order.amount - refundAmount;
        await escrowWallet.refundFunds(order, refundAmount, `Partial refund - Order ${order.orderNumber}`);
        if (releaseAmount > 0) {
            await escrowWallet.releaseFunds(order, releaseAmount, 0, `Partial release - Order ${order.orderNumber}`);
        }
        order.paymentStatus = 'refunded';
        order.orderStatus = 'refunded';
    } else {
        throw new ApiError(400, "Invalid action. Use: refund_buyer, release_seller, or partial_refund");
    }

    // Update dispute object if it exists
    if (order.dispute) {
        order.dispute.status = 'resolved';
        order.dispute.resolution = resolution;
        order.dispute.resolvedAt = new Date();
    }

    order.paymentReleasedAt = new Date();
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Dispute resolved successfully")
    );
});

// Manual release payment (Admin only)
export const manualReleasePayment = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.paymentStatus !== 'held') {
        throw new ApiError(400, "Payment is not in held status");
    }

    const escrowWallet = await EscrowWallet.getWallet();
    // No platform fee - release full amount to seller
    await escrowWallet.releaseFunds(order, order.amount, 0, `Manual release by admin: ${reason || 'Admin action'}`);

    order.paymentStatus = 'released';
    order.orderStatus = 'confirmed';
    order.paymentReleasedAt = new Date();
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Payment released manually")
    );
});

// Manual refund payment (Admin only)
export const manualRefundPayment = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason, refundPercentage = 100 } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.paymentStatus !== 'held') {
        throw new ApiError(400, "Payment is not in held status");
    }

    const refundAmount = Math.round(order.amount * (refundPercentage / 100));

    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.refundFunds(order, refundAmount, `Manual refund by admin: ${reason || 'Admin action'}`);

    order.paymentStatus = 'refunded';
    order.orderStatus = 'refunded';
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Payment refunded manually")
    );
});

// Get order analytics (Admin only)
export const getOrderAnalytics = asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const matchStage = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    const analytics = await Order.aggregate([
        { $match: matchStage },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalAmount: { $sum: '$amount' },
                totalPlatformFee: { $sum: '$platformFee' },
                avgOrderValue: { $avg: '$amount' }
            }
        }
    ]);

    const statusCounts = await Order.aggregate([
        { $match: matchStage },
        { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
    ]);

    const paymentStatusCounts = await Order.aggregate([
        { $match: matchStage },
        { $group: { _id: '$paymentStatus', count: { $sum: 1 } } }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            summary: analytics[0] || { totalOrders: 0, totalAmount: 0, totalPlatformFee: 0, avgOrderValue: 0 },
            orderStatusBreakdown: statusCounts,
            paymentStatusBreakdown: paymentStatusCounts
        }, "Order analytics fetched")
    );
});
