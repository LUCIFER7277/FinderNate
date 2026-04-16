import mongoose from "mongoose";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Order from "../models/order.models.js";

// Get invoice data for an order (both buyer and seller can access)
export const getInvoice = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user._id;

    const order = await Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber email')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber email')
        .populate('postId', 'media caption');

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    // Only buyer or seller can access the invoice
    const isBuyer = order.buyerId?._id?.toString() === userId.toString();
    const isSeller = order.sellerId?._id?.toString() === userId.toString();

    if (!isBuyer && !isSeller) {
        throw new ApiError(403, "Not authorized to view this invoice");
    }

    // Invoice is available only after payment is received
    const allowedStatuses = ['payment_received', 'processing', 'shipped', 'delivered', 'confirmed'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Invoice is not available for this order status");
    }

    const invoice = buildInvoiceData(order);

    return res.status(200).json(
        new ApiResponse(200, { invoice }, "Invoice fetched successfully")
    );
});

// Get invoice by order number (reference ID lookup)
export const getInvoiceByOrderNumber = asyncHandler(async (req, res) => {
    const { orderNumber } = req.params;
    const userId = req.user._id;

    const order = await Order.findOne({ orderNumber })
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber email')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber email')
        .populate('postId', 'media caption');

    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    const isBuyer = order.buyerId?._id?.toString() === userId.toString();
    const isSeller = order.sellerId?._id?.toString() === userId.toString();

    if (!isBuyer && !isSeller) {
        throw new ApiError(403, "Not authorized to view this invoice");
    }

    const allowedStatuses = ['payment_received', 'processing', 'shipped', 'delivered', 'confirmed'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Invoice is not available for this order status");
    }

    const invoice = buildInvoiceData(order);

    return res.status(200).json(
        new ApiResponse(200, { invoice }, "Invoice fetched successfully")
    );
});

// Get all invoices for the authenticated user (buyer or seller)
export const getUserInvoices = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { type = 'buyer', page = 1, limit = 20 } = req.query;

    const allowedStatuses = ['payment_received', 'processing', 'shipped', 'delivered', 'confirmed'];

    const query = type === 'seller'
        ? { sellerId: userId, orderStatus: { $in: allowedStatuses } }
        : { buyerId: userId, orderStatus: { $in: allowedStatuses } };

    const orders = await Order.find(query)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));

    const total = await Order.countDocuments(query);

    const invoices = orders.map(order => buildInvoiceSummary(order, type));

    return res.status(200).json(
        new ApiResponse(200, {
            invoices,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "Invoices fetched successfully")
    );
});

// Build full invoice data from an order
function buildInvoiceData(order) {
    return {
        invoiceNumber: `INV-${order.orderNumber}`,
        orderReferenceId: order.orderNumber,
        orderId: order._id,
        issueDate: order.createdAt,
        dueDate: order.createdAt,

        // Seller (From)
        seller: {
            id: order.sellerId?._id,
            fullName: order.sellerId?.fullName,
            username: order.sellerId?.username,
            profileImageUrl: order.sellerId?.profileImageUrl,
            phoneNumber: order.sellerId?.phoneNumber,
        },

        // Buyer (Bill To)
        buyer: {
            id: order.buyerId?._id,
            fullName: order.buyerId?.fullName || order.buyerDetails?.fullName,
            username: order.buyerId?.username,
            profileImageUrl: order.buyerId?.profileImageUrl,
            phoneNumber: order.buyerId?.phoneNumber || order.buyerDetails?.phoneNumber,
            email: order.buyerDetails?.email,
        },

        // Shipping Address
        shippingAddress: order.shippingAddress,

        // Line Items
        items: [
            {
                name: order.productDetails.name,
                description: order.productDetails.description,
                category: order.productDetails.category,
                images: order.productDetails.images,
                quantity: order.productDetails.quantity || 1,
                unitPrice: order.productDetails.price,
                amount: order.amount,
            }
        ],

        // Financial Summary
        shippingCharges: order.shippingCharges || 0,
        gstAmount: order.gstAmount || 0,
        subtotal: parseFloat(((order.amount || 0) - (order.shippingCharges || 0) - (order.gstAmount || 0)).toFixed(2)),
        shipping: order.shippingCharges || 0,
        platformFee: order.platformFee,
        total: order.amount,
        sellerAmount: order.sellerAmount,
        currency: order.currency || 'INR',

        // Payment Info
        paymentStatus: order.paymentStatus,
        razorpayPaymentId: order.razorpayPaymentId,
        razorpayOrderId: order.razorpayOrderId,
        paymentReleasedAt: order.paymentReleasedAt,

        // Order Status
        orderStatus: order.orderStatus,
        deliveryConfirmedAt: order.deliveryConfirmedAt,

        // Shipping Info
        shippingInfo: order.shippingInfo ? {
            trackingId: order.shippingInfo.trackingId,
            carrier: order.shippingInfo.carrier,
            shippedAt: order.shippingInfo.shippedAt,
            deliveredAt: order.shippingInfo.deliveredAt,
        } : null,

        // Ratings
        buyerRating: order.buyerRating,
        buyerReview: order.buyerReview,
        sellerRating: order.sellerRating,
        sellerReview: order.sellerReview,

        isShareableOrder: order.isShareableOrder,
    };
}

// Build invoice summary (for list view)
function buildInvoiceSummary(order, type) {
    const counterParty = type === 'seller'
        ? {
            fullName: order.buyerId?.fullName || order.buyerDetails?.fullName || 'Guest',
            username: order.buyerId?.username,
            profileImageUrl: order.buyerId?.profileImageUrl,
        }
        : {
            fullName: order.sellerId?.fullName,
            username: order.sellerId?.username,
            profileImageUrl: order.sellerId?.profileImageUrl,
        };

    return {
        invoiceNumber: `INV-${order.orderNumber}`,
        orderReferenceId: order.orderNumber,
        orderId: order._id,
        issueDate: order.createdAt,
        productName: order.productDetails.name,
        productImage: order.productDetails.images?.[0],
        amount: order.amount,
        currency: order.currency || 'INR',
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        counterParty,
    };
}
