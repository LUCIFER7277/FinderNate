import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Order from "../../models/order.models.js";
import { redactOrdersForViewer } from "./helpers.js";

/**
 * End bound for a date range, inclusive of the whole final day.
 *
 * Both clients send a bare `yyyy-MM-dd` from a date picker, which parses to
 * MIDNIGHT — so `$lte` dropped every order placed during the last day of the
 * range. Filtering 1–31 July silently lost the 31st, in the list and in the CSV
 * export people reconcile their spending against. An end value that carries an
 * explicit time is honoured exactly as sent.
 */
const endOfDayBound = (endDate) => {
    const date = new Date(endDate);
    if (isNaN(date.getTime())) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim())) {
        // Date-only strings parse as UTC midnight, so extend in UTC too.
        date.setUTCHours(23, 59, 59, 999);
    }
    return date;
};

const buildOrderHistoryQuery = ({ status, paymentStatus, startDate, endDate, minAmount, maxAmount, search }) => {
    const query = {};

    if (status) query.orderStatus = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = endOfDayBound(endDate);
            if (end) query.createdAt.$lte = end;
        }
        // An unparseable end date must not leave an empty `createdAt: {}`,
        // which matches no document at all.
        if (!Object.keys(query.createdAt).length) delete query.createdAt;
    }

    if (minAmount || maxAmount) {
        query.amount = {};
        if (minAmount) query.amount.$gte = parseFloat(minAmount);
        if (maxAmount) query.amount.$lte = parseFloat(maxAmount);
    }

    if (search) {
        query.$or = [
            { orderNumber: { $regex: search, $options: 'i' } },
            { 'productDetails.name': { $regex: search, $options: 'i' } }
        ];
    }

    return query;
};

// Map 'held' → 'paid' for user display (admin retains 'held' in DB for manual release)
// ── What counts as MONEY, and what counts as DONE ────────────────────────────
//
// Every total on these screens used to be `$sum: '$amount'` over the buyer's or
// seller's whole order collection, with no reference to whether the order was
// ever paid. A buyer with one ₹1 payment and two abandoned ₹1 checkouts was told
// they had spent ₹3.00, and a seller was credited with earnings for money that
// never arrived. An unpaid order is not a purchase; it is an intention.
//
// paymentStatus enum: pending | paid | held | released | refunded | failed
//   paid / held / released → the buyer was actually charged (held = sitting in
//                            manual escrow, released = already paid out). All
//                            three are real money that left the buyer.
//   refunded               → charged, then given back. Net spend is zero, so it
//                            must NOT be counted as spent.
//   pending / failed       → never charged.
const SETTLED_PAYMENT_STATUSES = ['paid', 'held', 'released'];

// Sum `field` only over orders where money genuinely moved.
const sumWhenPaid = (field) => ({
    $sum: { $cond: [{ $in: ['$paymentStatus', SETTLED_PAYMENT_STATUSES] }, field, 0] }
});
const avgWhenPaid = (field) => ({
    $avg: { $cond: [{ $in: ['$paymentStatus', SETTLED_PAYMENT_STATUSES] }, field, null] }
});

// orderStatus enum: created | payment_pending | payment_received | processing |
//                   shipped | delivered | confirmed | disputed | cancelled |
//                   refunded | seller_rejected
//
// These three buckets must PARTITION the orders — completed + pending +
// cancelled has to equal totalOrders, or the cards contradict the list beneath
// them. They did not: "pending" was a hand-written list that included
// payment_received/shipped/delivered (not pending at all) while omitting
// `created` and `payment_pending` (the only genuinely pending ones), so a buyer
// with 3 orders saw Completed 0 / Pending 1.
const COMPLETED_ORDER_STATUSES = ['confirmed'];
const CANCELLED_ORDER_STATUSES = ['cancelled', 'refunded', 'seller_rejected'];

const countWhereStatusIn = (statuses) => ({
    $sum: { $cond: [{ $in: ['$orderStatus', statuses] }, 1, 0] }
});

// Pending is defined as the REMAINDER rather than its own list, so it cannot
// drift out of sync when a new orderStatus is added to the enum.
const countPendingOrders = () => ({
    $sum: {
        $cond: [
            {
                $and: [
                    { $not: [{ $in: ['$orderStatus', COMPLETED_ORDER_STATUSES] }] },
                    { $not: [{ $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] }] }
                ]
            },
            1,
            0
        ]
    }
});

const normalizePaymentStatus = (orders) =>
    orders.map(o => {
        const obj = o.toObject ? o.toObject() : o;
        if (obj.paymentStatus === 'held') obj.paymentStatus = 'paid';
        return obj;
    });

export const getBuyerOrderHistory = asyncHandler(async (req, res) => {
    const {
        status, paymentStatus, startDate, endDate,
        minAmount, maxAmount, search,
        sortBy = 'createdAt', sortOrder = 'desc',
        page = 1, limit = 20
    } = req.query;

    const buyerId = req.user._id;
    const query = { buyerId, ...buildOrderHistoryQuery({ status, paymentStatus, startDate, endDate, minAmount, maxAmount, search }) };
    const sortConfig = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const orders = await Order.find(query)
        .populate('sellerId', 'fullName username profileImageUrl')
        .populate('postId', 'media caption')
        .sort(sortConfig)
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    const stats = await Order.aggregate([
        { $match: { buyerId: new mongoose.Types.ObjectId(buyerId) } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                // Only orders the buyer was actually charged for.
                totalSpent: sumWhenPaid('$amount'),
                completedOrders: countWhereStatusIn(COMPLETED_ORDER_STATUSES),
                pendingOrders: countPendingOrders(),
                cancelledOrders: countWhereStatusIn(CANCELLED_ORDER_STATUSES)
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            orders: normalizePaymentStatus(orders),
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit),
            stats: stats[0] || { totalOrders: 0, totalSpent: 0, completedOrders: 0, pendingOrders: 0, cancelledOrders: 0 }
        }, "Buyer order history fetched")
    );
});

export const getSellerOrderHistory = asyncHandler(async (req, res) => {
    const {
        status, paymentStatus, startDate, endDate,
        minAmount, maxAmount, search,
        sortBy = 'createdAt', sortOrder = 'desc',
        page = 1, limit = 20
    } = req.query;

    const sellerId = req.user._id;
    const query = { sellerId, ...buildOrderHistoryQuery({ status, paymentStatus, startDate, endDate, minAmount, maxAmount, search }) };
    const sortConfig = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl')
        .populate('postId', 'media caption')
        .sort(sortConfig)
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    const stats = await Order.aggregate([
        { $match: { sellerId: new mongoose.Types.ObjectId(sellerId) } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                // Money the buyer was actually charged, on this seller's orders.
                // Includes `held` — under the manual escrow flow that cash has
                // been collected on the seller's behalf even though the payout
                // is still a hand transfer. It excludes refunded and never-paid
                // orders, which is what used to inflate this figure.
                totalEarned: sumWhenPaid('$sellerAmount'),
                completedOrders: countWhereStatusIn(COMPLETED_ORDER_STATUSES),
                pendingOrders: countPendingOrders(),
                cancelledOrders: countWhereStatusIn(CANCELLED_ORDER_STATUSES)
            }
        }
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            // Seller-facing list: buyerDetails is projected down to the
            // fulfilment fields, so the buyer's email never leaves the server
            // here either (order/helpers.js → redactOrdersForViewer).
            orders: redactOrdersForViewer(normalizePaymentStatus(orders), sellerId),
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit),
            stats: stats[0] || { totalOrders: 0, totalEarned: 0, completedOrders: 0, pendingOrders: 0, cancelledOrders: 0 }
        }, "Seller order history fetched")
    );
});

export const getBuyerOrderStatistics = asyncHandler(async (req, res) => {
    const buyerId = new mongoose.Types.ObjectId(req.user._id);
    const { year, month } = req.query;

    const matchQuery = { buyerId };

    if (year) {
        const startDate = new Date(year, month ? month - 1 : 0, 1);
        const endDate = month
            ? new Date(year, month, 0, 23, 59, 59)
            : new Date(year, 11, 31, 23, 59, 59);
        matchQuery.createdAt = { $gte: startDate, $lte: endDate };
    }

    const overallStats = await Order.aggregate([
        { $match: { buyerId } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalSpent: sumWhenPaid('$amount'),
                // Averaged over PAID orders only. Including unpaid ones dragged
                // the average toward zero and made it disagree with
                // totalSpent / (orders actually paid for).
                averageOrderValue: avgWhenPaid('$amount'),
                completedOrders: countWhereStatusIn(COMPLETED_ORDER_STATUSES),
                pendingOrders: countPendingOrders(),
                disputedOrders: { $sum: { $cond: [{ $eq: ['$orderStatus', 'disputed'] }, 1, 0] } },
                cancelledOrders: countWhereStatusIn(CANCELLED_ORDER_STATUSES)
            }
        }
    ]);

    const categoryStats = await Order.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: '$productDetails.category',
                totalSpent: sumWhenPaid('$amount'),
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { totalSpent: -1 } },
        { $limit: 10 }
    ]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
        { $match: { buyerId, createdAt: { $gte: sixMonthsAgo } } },
        {
            $group: {
                _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
                totalSpent: sumWhenPaid('$amount'),
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const statusBreakdown = await Order.aggregate([
        { $match: { buyerId } },
        { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
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

export const getSellerOrderStatistics = asyncHandler(async (req, res) => {
    const sellerId = new mongoose.Types.ObjectId(req.user._id);
    const { year, month } = req.query;

    const matchQuery = { sellerId };

    if (year) {
        const startDate = new Date(year, month ? month - 1 : 0, 1);
        const endDate = month
            ? new Date(year, month, 0, 23, 59, 59)
            : new Date(year, 11, 31, 23, 59, 59);
        matchQuery.createdAt = { $gte: startDate, $lte: endDate };
    }

    const overallStats = await Order.aggregate([
        { $match: { sellerId } },
        {
            $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalRevenue: sumWhenPaid('$amount'),
                totalEarned: sumWhenPaid('$sellerAmount'),
                platformFees: sumWhenPaid('$platformFee'),
                averageOrderValue: avgWhenPaid('$amount'),
                completedOrders: countWhereStatusIn(COMPLETED_ORDER_STATUSES),
                pendingOrders: countPendingOrders(),
                disputedOrders: { $sum: { $cond: [{ $eq: ['$orderStatus', 'disputed'] }, 1, 0] } },
                cancelledOrders: countWhereStatusIn(CANCELLED_ORDER_STATUSES)
            }
        }
    ]);

    const productStats = await Order.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: '$productDetails.name',
                totalRevenue: sumWhenPaid('$amount'),
                orderCount: { $sum: 1 },
                averagePrice: avgWhenPaid('$amount')
            }
        },
        { $sort: { orderCount: -1 } },
        { $limit: 10 }
    ]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
        { $match: { sellerId, createdAt: { $gte: sixMonthsAgo } } },
        {
            $group: {
                _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
                totalRevenue: sumWhenPaid('$amount'),
                totalEarned: sumWhenPaid('$sellerAmount'),
                orderCount: { $sum: 1 }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const statusBreakdown = await Order.aggregate([
        { $match: { sellerId } },
        { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
    ]);

    const ratingStats = await Order.aggregate([
        { $match: { sellerId, buyerRating: { $exists: true, $ne: null } } },
        { $group: { _id: null, averageRating: { $avg: '$buyerRating' }, totalRatings: { $sum: 1 } } }
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

export const exportOrdersToCSV = asyncHandler(async (req, res) => {
    const { type = 'buyer', status, startDate, endDate } = req.query;
    const userId = req.user._id;

    const query = type === 'buyer' ? { buyerId: userId } : { sellerId: userId };

    if (status) query.orderStatus = status;
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        //* Inclusive of the final day — the export is used for accounting, and
        //* a midnight bound silently left the last day's orders out of it.
        if (endDate) {
            const end = endOfDayBound(endDate);
            if (end) query.createdAt.$lte = end;
        }
        if (!Object.keys(query.createdAt).length) delete query.createdAt;
    }

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username')
        .populate('sellerId', 'fullName username')
        .sort({ createdAt: -1 });

    const headers = [
        'Order Number', 'Date', 'Product',
        type === 'buyer' ? 'Seller' : 'Buyer',
        'Amount', 'Order Status', 'Payment Status'
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

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders_${type}_${Date.now()}.csv"`);

    return res.status(200).send([headers, ...rows].join('\n'));
});

export const getUserReviews = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { role = 'seller', page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const userObjectId = new mongoose.Types.ObjectId(userId);

    let matchQuery, ratingField, reviewField, reviewerPopulateField, reviewerRole;

    if (role === 'buyer') {
        matchQuery = { buyerId: userObjectId, sellerRating: { $exists: true, $ne: null } };
        ratingField = 'sellerRating';
        reviewField = 'sellerReview';
        reviewerPopulateField = 'sellerId';
        reviewerRole = 'seller';
    } else {
        matchQuery = { sellerId: userObjectId, buyerRating: { $exists: true, $ne: null } };
        ratingField = 'buyerRating';
        reviewField = 'buyerReview';
        reviewerPopulateField = 'buyerId';
        reviewerRole = 'buyer';
    }

    const statsResult = await Order.aggregate([
        { $match: matchQuery },
        {
            $group: {
                _id: null,
                averageRating: { $avg: `$${ratingField}` },
                totalReviews: { $sum: 1 },
                fiveStars:  { $sum: { $cond: [{ $eq: [`$${ratingField}`, 5] }, 1, 0] } },
                fourStars:  { $sum: { $cond: [{ $eq: [`$${ratingField}`, 4] }, 1, 0] } },
                threeStars: { $sum: { $cond: [{ $eq: [`$${ratingField}`, 3] }, 1, 0] } },
                twoStars:   { $sum: { $cond: [{ $eq: [`$${ratingField}`, 2] }, 1, 0] } },
                oneStar:    { $sum: { $cond: [{ $eq: [`$${ratingField}`, 1] }, 1, 0] } }
            }
        }
    ]);

    const stats = statsResult[0] || {
        averageRating: 0, totalReviews: 0,
        fiveStars: 0, fourStars: 0, threeStars: 0, twoStars: 0, oneStar: 0
    };

    const reviews = await Order.find(matchQuery)
        .select(`${ratingField} ${reviewField} createdAt productDetails.name orderNumber`)
        .populate(reviewerPopulateField, 'fullName username profileImageUrl')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();

    const normalizedReviews = reviews.map(order => ({
        _id: order._id,
        orderNumber: order.orderNumber,
        rating: order[ratingField],
        review: order[reviewField] || null,
        productName: order.productDetails?.name || null,
        reviewer: order[reviewerPopulateField],
        reviewerRole,
        createdAt: order.createdAt
    }));

    return res.status(200).json(
        new ApiResponse(200, {
            stats: {
                averageRating: Math.round((stats.averageRating || 0) * 10) / 10,
                totalReviews: stats.totalReviews,
                breakdown: {
                    5: stats.fiveStars,
                    4: stats.fourStars,
                    3: stats.threeStars,
                    2: stats.twoStars,
                    1: stats.oneStar
                }
            },
            reviews: normalizedReviews,
            page: pageNum,
            totalPages: Math.ceil(stats.totalReviews / limitNum),
            total: stats.totalReviews
        }, "User reviews fetched successfully")
    );
});
