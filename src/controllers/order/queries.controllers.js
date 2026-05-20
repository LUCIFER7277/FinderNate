import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Order from "../../models/order.models.js";

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

    const responseData = { order };

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
        new ApiResponse(200, { orders, total, page: parseInt(page), totalPages: Math.ceil(total / limit) }, "Seller orders fetched")
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
