import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Order from "../../models/order.models.js";
import { sendOrderNotification, populateOrder } from "./helpers.js";

const VALID_DISPUTE_REASONS = ['damaged_product', 'wrong_item', 'missing_item', 'not_as_described', 'defective', 'counterfeit', 'other'];

const DISPUTE_REASON_LABELS = {
    damaged_product: 'Damaged Product',
    wrong_item: 'Wrong Item Received',
    missing_item: 'Missing Item',
    not_as_described: 'Not As Described',
    defective: 'Defective Product',
    counterfeit: 'Counterfeit Product',
    other: 'Other'
};

export const confirmDelivery = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review, openingVideoUrl } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Only the buyer can confirm delivery");
    if (order.orderStatus !== 'delivered' && order.orderStatus !== 'shipped') {
        throw new ApiError(400, "Order must be shipped or delivered first");
    }

    order.orderStatus = 'confirmed';
    // Payment stays held — admin will manually release
    order.deliveryConfirmedAt = new Date();

    if (rating) order.buyerRating = rating;
    if (review) order.buyerReview = review;
    if (openingVideoUrl) {
        order.buyerProof = { ...order.buyerProof, openingVideoUrl, uploadedAt: new Date() };
    }

    await order.save();

    sendOrderNotification({
        recipientId: order.sellerId,
        senderId: buyerId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        notificationMessage: `Order #${order.orderNumber} delivery confirmed by buyer! Payment will be released by admin shortly.`,
        chatMessageText: `Order #${order.orderNumber} has been delivered successfully!\n\nThe buyer has confirmed receiving the product. Payment will be released by admin shortly.${rating ? `\nRating: ${'⭐'.repeat(rating)}` : ''}`,
        chatId: order.chatId,
        buyerId: order.buyerId
    }).catch(err => console.error('Confirm notification error:', err));

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Delivery confirmed. Payment will be released by admin.")
    );
});

export const reportIssue = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason, description, evidence, disputeVideoUrl } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Not authorized");
    if (!reason) throw new ApiError(400, "Reason is required");
    if (!VALID_DISPUTE_REASONS.includes(reason)) {
        throw new ApiError(400, `Invalid dispute reason. Must be one of: ${VALID_DISPUTE_REASONS.join(', ')}`);
    }

    order.orderStatus = 'disputed';
    order.dispute = {
        reason,
        description,
        evidence: evidence || [],
        status: 'open',
        createdAt: new Date()
    };

    if (disputeVideoUrl) {
        order.dispute.disputeVideoUrl = disputeVideoUrl;
        order.dispute.disputeVideoUploadedAt = new Date();
    }

    await order.save();

    const reasonLabel = DISPUTE_REASON_LABELS[reason] || reason;
    sendOrderNotification({
        recipientId: order.sellerId,
        senderId: buyerId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        notificationMessage: `Dispute raised on order #${order.orderNumber}. Reason: ${reasonLabel}`,
        chatMessageText: `A dispute has been raised on Order #${order.orderNumber}.\n\nReason: ${reasonLabel}${description ? `\nDescription: ${description}` : ''}${disputeVideoUrl ? '\n\nThe buyer has uploaded a proof video. You can view it in the order details.' : '\n\nThe buyer has not yet uploaded a proof video.'}\n\nThe admin team will review this dispute.`,
        chatId: order.chatId,
        buyerId: order.buyerId
    }).catch(err => console.error('Dispute notification error:', err));

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, {
            order: updatedOrder,
            disputePolicy: {
                videoRequired: true,
                videoUploaded: !!disputeVideoUrl,
                message: "You must upload a video showing proof of damage to be eligible for refund or return. This footage will be reviewed by both the admin and the seller. If valid proof is not provided, the item will not be eligible for refund or return."
            }
        }, "Issue reported, payment held until resolution")
    );
});

export const uploadDisputeVideo = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { disputeVideoUrl } = req.body;
    const buyerId = req.user._id;

    if (!disputeVideoUrl) {
        throw new ApiError(400, "Dispute video URL is required. You must upload a video showing proof of damage to be eligible for refund or return.");
    }

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Only the buyer can upload dispute video");
    if (order.orderStatus !== 'disputed') throw new ApiError(400, "Can only upload dispute video for disputed orders");
    if (!order.dispute) throw new ApiError(400, "No active dispute found for this order");
    if (order.dispute.status === 'resolved' || order.dispute.status === 'rejected') {
        throw new ApiError(400, "Cannot upload video for a closed dispute");
    }

    order.dispute.disputeVideoUrl = disputeVideoUrl;
    order.dispute.disputeVideoUploadedAt = new Date();
    await order.save();

    sendOrderNotification({
        recipientId: order.sellerId,
        senderId: buyerId,
        orderId: order._id,
        orderNumber: order.orderNumber,
        notificationMessage: `Buyer uploaded dispute proof video for order #${order.orderNumber}`,
        chatMessageText: `The buyer has uploaded a proof video for the dispute on Order #${order.orderNumber}.\n\nYou can view the video evidence in the order details. The admin team will review this dispute.`,
        chatId: order.chatId,
        buyerId: order.buyerId
    }).catch(err => console.error('Dispute video notification error:', err));

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, {
            order: updatedOrder,
            notice: "Your dispute video has been submitted. Both the admin and seller will review this footage. If valid proof of damage is not provided, the item will not be eligible for refund or return."
        }, "Dispute proof video uploaded successfully")
    );
});

export const uploadPaymentProof = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { paymentScreenshot } = req.body;
    const buyerId = req.user._id;

    if (!paymentScreenshot) throw new ApiError(400, "Payment screenshot URL is required");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Only the buyer can upload payment proof");

    const allowedStatuses = ['payment_received', 'processing', 'shipped', 'delivered'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Cannot upload payment proof for this order status");
    }

    order.buyerProof = { ...order.buyerProof, paymentScreenshot, uploadedAt: new Date() };
    await order.save();

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Payment proof uploaded successfully")
    );
});

export const uploadOpeningVideo = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { openingVideoUrl } = req.body;
    const buyerId = req.user._id;

    if (!openingVideoUrl) throw new ApiError(400, "Opening video URL is required");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Only the buyer can upload opening video");

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

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Opening video uploaded successfully")
    );
});

export const rateSeller = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review } = req.body;
    const buyerId = req.user._id;

    if (!rating || rating < 1 || rating > 5) throw new ApiError(400, "Rating must be between 1 and 5");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.buyerId.toString() !== buyerId.toString()) throw new ApiError(403, "Only the buyer can rate the seller");
    if (!['confirmed', 'delivered'].includes(order.orderStatus)) {
        throw new ApiError(400, "Order must be delivered or confirmed to rate the seller");
    }
    if (order.buyerRating) throw new ApiError(400, "You have already rated this seller");

    order.buyerRating = rating;
    order.buyerReview = review;
    await order.save();

    const updatedOrder = await populateOrder(orderId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Seller rated successfully")
    );
});
