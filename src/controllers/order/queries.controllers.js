import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Order from "../../models/order.models.js";
import { redactOrderForViewer, redactOrdersForViewer } from "./helpers.js";

// An order created by a guest through a shareable payment link has buyerId:null
// until an account is created for that buyer on confirmed payment — and orders
// created by the online-store guest flow may stay that way forever. Reading
// `order.buyerId._id` on one of those threw a TypeError, so the SELLER opening
// their own guest order got a 500 instead of the order. Populated refs can also
// resolve to null when the referenced user is gone, so unwrap defensively.
const idOf = (ref) => {
    const value = ref?._id ?? ref;
    return value ? value.toString() : null;
};

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

    const buyerIdStr  = idOf(order.buyerId);
    const sellerIdStr = idOf(order.sellerId);
    const viewerIdStr = userId.toString();

    // A guest order has no buyer, so only the seller can reach it. It must still
    // RENDER — the seller has to see the address and the guest contact details
    // in order to ship it.
    if (buyerIdStr !== viewerIdStr && sellerIdStr !== viewerIdStr) {
        throw new ApiError(403, "Not authorized to view this order");
    }

    // The seller has to see the shipping address and a contact number to ship
    // this, but NOT the buyer's email address — see redactOrderForViewer. The
    // buyer's own view of their own order is unaffected.
    const responseData = {
        order: redactOrderForViewer(order, userId),
        isGuestOrder: !buyerIdStr
    };

    // Include dispute policy info when order is disputed
    if (order.orderStatus === 'disputed' && order.dispute) {
        responseData.disputePolicy = {
            videoRequired: true,
            videoUploaded: !!order.dispute.disputeVideoUrl,
            message: "The buyer must upload a video showing proof of damage to be eligible for refund or return. This footage is accessible to both the admin and the seller. If valid proof is not provided, the item will not be eligible for refund or return."
        };
    }

    return res.status(200).json(
        new ApiResponse(200, responseData, "Order details fetched")
    );
});

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
        new ApiResponse(200, {
            // Guest orders in this list carry buyerDetails; strip the email.
            orders: redactOrdersForViewer(orders, sellerId),
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        }, "Seller orders fetched")
    );
});

// Count orders with 'payment_received' status — these need seller action (shipping)
export const getSellerNewOrdersCount = asyncHandler(async (req, res) => {
    const sellerId = req.user._id;

    const newOrdersCount = await Order.countDocuments({
        sellerId,
        orderStatus: 'payment_received'
    });

    return res.status(200).json(
        new ApiResponse(200, { newOrdersCount }, "New orders count fetched")
    );
});
