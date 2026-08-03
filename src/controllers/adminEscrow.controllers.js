import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Order from "../models/order.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";
import { getFeeRates } from "../utils/fees.utils.js";
import {
    generateCashfreeRefundId,
    getCashfreeOrderStatus,
    getCashfreeRefund,
    createCashfreeRefund,
} from "../config/cashfree.config.js";


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

    // Store orders sit at 'paid' rather than 'held' but are equally awaiting a
    // manual payout, so they belong in this count.
    const pendingOrders = await Order.countDocuments({ paymentStatus: { $in: ['held', 'paid'] } });
    const disputedOrders = await Order.countDocuments({ orderStatus: 'disputed' });
    const rejectedOrders = await Order.countDocuments({ orderStatus: 'seller_rejected' });
    const completedOrders = await Order.countDocuments({ paymentStatus: 'released' });

    return res.status(200).json(
        new ApiResponse(200, {
            wallet: stats,
            orderStats: {
                pendingRelease: pendingOrders,
                disputed: disputedOrders,
                sellerRejected: rejectedOrders,
                completed: completedOrders
            }
        }, "Escrow dashboard fetched")
    );
});

// Get escrow transactions (Admin only)
export const getEscrowTransactions = asyncHandler(async (req, res) => {
    const { type } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;

    // The ledger lives in one document's array, so filtering, sorting and
    // slicing are pushed into MongoDB. Loading the whole array into Node and
    // sorting it there took seconds once the wallet had grown, and it ran on
    // every page view.
    const [result] = await EscrowWallet.aggregate([
        { $match: { isSystemWallet: true } },
        { $project: { transactions: 1 } },
        { $unwind: '$transactions' },
        ...(type ? [{ $match: { 'transactions.type': type } }] : []),
        { $sort: { 'transactions.createdAt': -1 } },
        {
            $facet: {
                rows:  [{ $skip: skip }, { $limit: limit }, { $replaceRoot: { newRoot: '$transactions' } }],
                count: [{ $count: 'total' }]
            }
        }
    ]);

    const transactions = result?.rows || [];
    const total = result?.count?.[0]?.total || 0;

    return res.status(200).json(
        new ApiResponse(200, {
            transactions,
            total,
            page,
            totalPages: Math.ceil(total / limit)
        }, "Escrow transactions fetched")
    );
});

// Get all orders (Admin only)
export const getAllOrders = asyncHandler(async (req, res) => {
    const { status, paymentStatus, page = 1, limit = 20 } = req.query;

    const query = { paymentStatus: { $ne: 'pending' } };
    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl')
        .populate('sellerId', 'fullName username profileImageUrl')
        .populate('postId', 'customization contentType')
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
        .populate('postId', 'customization contentType')
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

// Get seller-rejected orders pending admin refund (Admin only)
export const getRejectedOrders = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;

    const orders = await Order.find({ orderStatus: 'seller_rejected' })
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber email')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'customization contentType')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments({ orderStatus: 'seller_rejected' });

    return res.status(200).json(
        new ApiResponse(200, {
            orders,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "Seller-rejected orders fetched")
    );
});

// Helper: Calculate fee breakdown for an order
const calculateFeeBreakdown = async (order) => {
    const productPrice = order.productDetails.price || 0;

    // Get shipping charges from the post
    let shippingCharges = 0;
    if (order.postId) {
        const Post = (await import('../models/userPost.models.js')).default;
        const post = await Post.findById(order.postId);
        if (post) {
            if (post.customization?.product) {
                shippingCharges = post.customization.product.shippingCharges || 0;
            } else if (post.customization?.service) {
                shippingCharges = post.customization.service.shippingCharges || 0;
            }
        }
    }

    const { gatewayFeeRate, platformFeeRate } = await getFeeRates();
    const gatewayFee = Number((productPrice * gatewayFeeRate).toFixed(2));
    const platformFee = Number((productPrice * platformFeeRate).toFixed(2));
    const totalDeductions = shippingCharges + gatewayFee + platformFee;
    const buyerRefund = Math.max(0, order.amount - totalDeductions);
    const sellerSettlement = shippingCharges;
    const finerateEarnings = gatewayFee + platformFee;

    return {
        productPrice,
        shippingCharges,
        gatewayFee,
        platformFee,
        totalDeductions,
        buyerRefund,
        sellerSettlement,
        finerateEarnings
    };
};

// Resolve dispute (Admin only)
export const resolveDispute = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { resolution, action, forceResolve = false } = req.body;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");

    if (order.orderStatus !== 'disputed') {
        throw new ApiError(400, "Order is not in disputed status");
    }

    // Edge case: already released or refunded — just close the dispute record
    if (order.paymentStatus === 'released' || order.paymentStatus === 'refunded') {
        if (order.dispute) {
            order.dispute.status = 'resolved';
            order.dispute.resolution = resolution || `Dispute resolved - payment was already ${order.paymentStatus}`;
            order.dispute.resolvedAt = new Date();
        }
        order.orderStatus = order.paymentStatus === 'released' ? 'confirmed' : 'refunded';
        await order.save();
        return res.status(200).json(
            new ApiResponse(200, { order }, `Dispute resolved - payment was already ${order.paymentStatus}`)
        );
    }

    if (order.paymentStatus !== 'held') {
        throw new ApiError(400, "Payment is not in held status - cannot resolve");
    }

    if (action !== 'refund_buyer' && action !== 'release_seller') {
        throw new ApiError(400, "Invalid action. Use: refund_buyer or release_seller");
    }

    const escrowWallet = await EscrowWallet.getWallet();
    const insufficientBalance = escrowWallet.heldBalance < order.amount;

    if (insufficientBalance && !forceResolve) {
        throw new ApiError(400,
            `Insufficient escrow balance. Wallet has ₹${escrowWallet.heldBalance} held but order requires ₹${order.amount}. Use forceResolve: true to proceed without escrow movement.`
        );
    }

    let feeBreakdown = null;
    let refundStatus = null;
    let refundId = null;

    if (action === 'refund_buyer') {
        if (!order.cashfreeOrderId) {
            throw new ApiError(400, "No Cashfree order ID on this order - cannot initiate refund");
        }

        feeBreakdown = await calculateFeeBreakdown(order);

        if (feeBreakdown.buyerRefund < 2) {
            throw new ApiError(400, `Invalid refund value for the order: calculated refund ₹${feeBreakdown.buyerRefund} is below the minimum allowed (₹2)`);
        }

        refundId = order.refundId || generateCashfreeRefundId();

        let cashfreeOrder;
        try {
            cashfreeOrder = await getCashfreeOrderStatus(order.cashfreeOrderId);
        } catch (err) {
            throw new ApiError(502, `Failed to fetch Cashfree order status: ${err.message}`);
        }

        if (cashfreeOrder.order_status !== 'PAID') {
            throw new ApiError(400, `Cashfree order is not PAID (status: ${cashfreeOrder.order_status})`);
        }

        if (order
            .refundId) {
            try {
                const existing = await getCashfreeRefund(order.cashfreeOrderId, order.refundId);
                refundStatus = existing.refund_status;
            } catch (error) {
            }
        }

        if (refundStatus !== 'SUCCESS') {
            let cfRefund;
            try {
                cfRefund = await createCashfreeRefund(
                    order.cashfreeOrderId,
                    refundId,
                    feeBreakdown.buyerRefund,
                    `Dispute resolution refund - Order ${order.orderNumber}`
                );
            } catch (err) {
                 
                throw new ApiError(502, `Cashfree refund creation failed: ${err.message}`);
            }
            refundStatus = cfRefund.refund_status;
        }

        if (refundStatus !== 'SUCCESS' && refundStatus !== 'PENDING') {
            throw new ApiError(502, `Cashfree refund in unexpected state: ${refundStatus}`);
        }
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (action === 'refund_buyer') {
                if (!insufficientBalance) {
                    // Fetch wallet inside transaction for a consistent view
                    const wallet = await EscrowWallet.findOne({ isSystemWallet: true }).select('-transactions').session(session);

                    if (feeBreakdown.buyerRefund > 0) {
                        await wallet.refundFunds(
                            order,
                            feeBreakdown.buyerRefund,
                            `Dispute refund: ${resolution || 'resolved'} - Order ${order.orderNumber}`,
                            { session }
                        );
                    }
                    const remaining = order.amount - feeBreakdown.buyerRefund;
                    if (remaining > 0) {
                        await wallet.releaseFunds(
                            order,
                            remaining,
                            feeBreakdown.finerateEarnings,
                            `Fees & shipping settlement - Order ${order.orderNumber}`,
                            { session }
                        );
                    }
                }

                order.refundId = refundId;
                order.paymentStatus = 'refunded';
                order.orderStatus = 'refunded';
                order.platformFee = feeBreakdown.finerateEarnings;
                order.sellerAmount = feeBreakdown.sellerSettlement;

            } else {
                // release_seller
                const wallet = await EscrowWallet.findOne({ isSystemWallet: true }).select('-transactions').session(session);
                await wallet.releaseFunds(
                    order,
                    order.amount,
                    0,
                    `Payment released after dispute resolution - Order ${order.orderNumber}`,
                    { session }
                );
                order.paymentStatus = 'released';
                order.orderStatus = 'confirmed';
            }

            if (order.dispute) {
                order.dispute.status = 'resolved';
                order.dispute.resolution = resolution || (insufficientBalance ? 'Force resolved - insufficient escrow balance' : 'Resolved by admin');
                order.dispute.resolvedAt = new Date();
            }
            order.paymentReleasedAt = new Date();
            await order.save({ session });
        });
    } finally {
        await session.endSession();
    }

    const warning = insufficientBalance
        ? 'Force resolved - escrow balance was insufficient; no escrow movement recorded'
        : undefined;

    return res.status(200).json(
        new ApiResponse(200,
            { order, feeBreakdown, refundStatus, ...(warning && { warning }) },
            "Dispute resolved successfully"
        )
    );
});

// Statuses whose money is sitting in escrow and can still be moved.
// Online-store orders land on 'paid' rather than 'held', and were previously
// unreleasable and unrefundable through the admin panel because of it.
const RELEASABLE_PAYMENT_STATUSES = ['held', 'paid'];

// Manual release payment (Admin only)
export const manualReleasePayment = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId)
        .populate('sellerId', 'fullName username profileImageUrl businessProfileId');

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (!RELEASABLE_PAYMENT_STATUSES.includes(order.paymentStatus)) {
        throw new ApiError(400, "Payment is not in held status");
    }

    // Get seller's bank details including QR code
    let sellerBankDetails = null;
    if (order.sellerId?.businessProfileId) {
        const Business = (await import('../models/business.models.js')).default;
        const business = await Business.findById(order.sellerId.businessProfileId).select('bankDetails');

        if (business?.bankDetails) {
            sellerBankDetails = {
                accountHolderName: business.bankDetails.accountHolderName,
                bankName: business.bankDetails.bankName,
                accountNumber: business.bankDetails.accountNumber,
                ifscCode: business.bankDetails.ifscCode,
                upiId: business.bankDetails.upiId,
                paymentQRCode: business.bankDetails.paymentQRCode
            };
        }
    }

    // ── Atomic claim + release ────────────────────────────────────────────────
    // The status check above is only a fast fail. The real guard is the
    // compare-and-set below: a double-clicked Release used to pass the
    // read-only check twice and debit the escrow ledger twice, leaving the
    // payout worklist showing double what the seller was owed.
    const session = await mongoose.startSession();
    let releasedOrder;
    try {
        await session.withTransaction(async () => {
            const claimed = await Order.findOneAndUpdate(
                { _id: order._id, paymentStatus: { $in: RELEASABLE_PAYMENT_STATUSES } },
                {
                    $set: {
                        paymentStatus: 'released',
                        orderStatus: 'confirmed',
                        paymentReleasedAt: new Date()
                    }
                },
                { new: true, session }
            );

            if (!claimed) {
                throw new ApiError(400, "Payment is not in held status");
            }

            const wallet = await EscrowWallet.findOne({ isSystemWallet: true })
                .select('-transactions')
                .session(session);

            if (!wallet) {
                throw new ApiError(400, "Escrow wallet has not been initialised - no funds are recorded as held");
            }

            // No platform fee - release full amount to seller
            await wallet.releaseFunds(claimed, claimed.amount, 0, `Manual release by admin: ${reason || 'Admin action'}`, { session });

            releasedOrder = claimed;
        });
    } finally {
        await session.endSession();
    }

    const populatedOrder = await Order.findById(releasedOrder._id)
        .populate('sellerId', 'fullName username profileImageUrl businessProfileId');

    return res.status(200).json(
        new ApiResponse(200, {
            order: populatedOrder,
            sellerBankDetails
        }, "Payment released manually")
    );
});

// Manual refund payment (Admin only)
export const manualRefundPayment = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");

    if (!RELEASABLE_PAYMENT_STATUSES.includes(order.paymentStatus)) {
        throw new ApiError(400, "Payment is not in held status");
    }

    if (!order.cashfreeOrderId) {
        throw new ApiError(400, "No Cashfree order ID on this order - cannot initiate refund");
    }

    const feeBreakdown = await calculateFeeBreakdown(order);

    if (feeBreakdown.buyerRefund < 2) {
        throw new ApiError(400, `Invalid refund value for the order: calculated refund ₹${feeBreakdown.buyerRefund} is below the minimum allowed (₹2)`);
    }

    const refundId = order.refundId || generateCashfreeRefundId();

    // ── 1. Verify Cashfree order is PAID ──────────────────────────────────────
    let cashfreeOrder;
    try {
        cashfreeOrder = await getCashfreeOrderStatus(order.cashfreeOrderId);
    } catch (err) {
        throw new ApiError(502, `Failed to fetch Cashfree order status: ${err.message}`);
    }

    if (cashfreeOrder.order_status !== 'PAID') {
        throw new ApiError(400, `Cashfree order is not PAID (status: ${cashfreeOrder.order_status})`);
    }

    // ── 2. Check if a refund already exists ───────────────────────────────────
    let refundStatus = null;

    if (order.refundId) {
        try {
            const existing = await getCashfreeRefund(order.cashfreeOrderId, order.refundId);
            refundStatus = existing.refund_status;
        } catch (_) {
            // Refund not found on Cashfree — will create below
        }
    }

    // ── 3. Create refund on Cashfree if not already SUCCESS ───────────────────
    if (refundStatus !== 'SUCCESS') {
        let cfRefund;
         
        try {
            cfRefund = await createCashfreeRefund(
                order.cashfreeOrderId,
                refundId,
                feeBreakdown.buyerRefund,
                `Admin manual refund: ${reason || 'Admin action'} - Order ${order.orderNumber}`
            );
        } catch (err) {
            console.log(err)
            throw new ApiError(502, `Cashfree refund creation failed: ${err.message}`);
        }
        refundStatus = cfRefund.refund_status;
    }

    if (refundStatus !== 'SUCCESS' && refundStatus !== 'PENDING') {
        throw new ApiError(502, `Cashfree refund in unexpected state: ${refundStatus}`);
    }

    // ── 4. Atomic DB update ───────────────────────────────────────────────────
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // Compare-and-set: a concurrent release/refund must not be able to
            // move the same escrowed funds twice.
            const claimed = await Order.findOneAndUpdate(
                { _id: order._id, paymentStatus: { $in: RELEASABLE_PAYMENT_STATUSES } },
                {
                    $set: {
                        refundId,
                        paymentStatus: 'refunded',
                        orderStatus: 'refunded',
                        platformFee: feeBreakdown.finerateEarnings,
                        sellerAmount: feeBreakdown.sellerSettlement
                    }
                },
                { new: true, session }
            );

            if (!claimed) {
                throw new ApiError(409, "Order payment status changed - refund already processed");
            }

            const wallet = await EscrowWallet.findOne({ isSystemWallet: true })
                .select('-transactions')
                .session(session);

            if (feeBreakdown.buyerRefund > 0) {
                await wallet.refundFunds(
                    claimed,
                    feeBreakdown.buyerRefund,
                    `Manual refund: ${reason || 'Admin action'} - Order ${order.orderNumber}`,
                    { session }
                );
            }

            const remaining = claimed.amount - feeBreakdown.buyerRefund;
            if (remaining > 0) {
                await wallet.releaseFunds(
                    claimed,
                    remaining,
                    feeBreakdown.finerateEarnings,
                    `Fees & shipping settlement - Order ${order.orderNumber}`,
                    { session }
                );
            }
        });
    } finally {
        await session.endSession();
    }

    const refundedOrder = await Order.findById(order._id);

    return res.status(200).json(
        new ApiResponse(200, { order: refundedOrder, feeBreakdown, refundStatus }, "Payment refunded manually")
    );
});

// Get seller bank details by order ID (Admin only)
export const getSellerBankDetailsByOrder = asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    const order = await Order.findById(orderId)
        .populate('sellerId', 'fullName username businessProfileId');

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (!order.sellerId) {
        throw new ApiError(404, "Seller not found for this order");
    }

    // Get seller's bank details including QR code
    let bankDetails = null;
    if (order.sellerId.businessProfileId) {
        const Business = (await import('../models/business.models.js')).default;
        const business = await Business.findById(order.sellerId.businessProfileId).select('bankDetails');

        if (business?.bankDetails) {
            bankDetails = {
                accountHolderName: business.bankDetails.accountHolderName,
                bankName: business.bankDetails.bankName,
                accountNumber: business.bankDetails.accountNumber,
                ifscCode: business.bankDetails.ifscCode,
                accountType: business.bankDetails.accountType,
                upiId: business.bankDetails.upiId,
                branchName: business.bankDetails.branchName,
                paymentQRCode: business.bankDetails.paymentQRCode,
                isVerified: business.bankDetails.isVerified
            };
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            sellerInfo: {
                fullName: order.sellerId.fullName,
                username: order.sellerId.username
            },
            bankDetails,
            hasBankDetails: !!bankDetails
        }, "Seller bank details fetched successfully")
    );
});

// Get order analytics (Admin only)
export const getOrderAnalytics = asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const matchStage = {
        paymentStatus: { $ne: 'pending' },
        ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {})
    };

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

// Manual confirm pending payment (Admin only - Demo/Sandbox)
export const manualConfirmPayment = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    if (order.paymentStatus !== 'pending') {
        throw new ApiError(400, `Cannot confirm payment. Current status: ${order.paymentStatus}. Only pending payments can be confirmed.`);
    }

    const escrowWallet = await EscrowWallet.getWallet();

    // Simulate the complete payment flow: pending -> held -> released
    // This is for demo/sandbox purposes only

    // Step 1: Hold funds (simulate payment verification)
    await escrowWallet.holdFunds(order, order.amount, `Manual confirmation - ${reason || 'Admin demo approval'}`);

    // Step 2: Release funds immediately (simulate buyer confirmation)
    await escrowWallet.releaseFunds(order, order.amount, 0, `Instant release after manual confirmation - ${reason || 'Admin demo approval'}`);

    // Update order status
    order.paymentStatus = 'released';
    order.orderStatus = 'confirmed';
    order.paymentReleasedAt = new Date();
    await order.save();

    return res.status(200).json(
        new ApiResponse(200, { order }, "Payment confirmed and released successfully")
    );
});
