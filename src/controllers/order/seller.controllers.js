import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Order from "../../models/order.models.js";
import { sendOrderNotification, populateOrderFor } from "./helpers.js";

const VALID_REJECTION_REASONS = ['out_of_stock', 'price_change', 'invalid_address', 'need_clarification', 'certificate_required', 'other'];

const REJECTION_REASON_LABELS = {
    out_of_stock: 'Out of Stock',
    price_change: 'Price Change',
    invalid_address: 'Buyer Address Not Valid',
    need_clarification: 'Seller Needs More Clarification',
    certificate_required: 'Certificates Required for This Product',
    other: 'Other'
};

export const sellerConfirmOrder = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can confirm this order");
    if (order.orderStatus !== 'payment_received') throw new ApiError(400, "Order can only be confirmed when payment is received");

    order.orderStatus = 'processing';
    order.sellerResponse = { status: 'confirmed', respondedAt: new Date() };
    await order.save();

    if (order.buyerId) {
        sendOrderNotification({
            recipientId: order.buyerId,
            senderId: sellerId,
            orderId: order._id,
            orderNumber: order.orderNumber,
            notificationMessage: `Your order #${order.orderNumber} has been confirmed by the seller! It is now being processed.`,
            chatMessageText: `Order #${order.orderNumber} has been confirmed by the seller!\n\nYour order is now being processed and will be shipped soon.`,
            chatId: order.chatId,
            buyerId: order.buyerId
        }).catch(err => console.error('Seller confirm notification error:', err));
    }

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order confirmed by seller")
    );
});

export const sellerRejectOrder = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { reason, note } = req.body;
    const sellerId = req.user._id;

    if (!reason) throw new ApiError(400, "Rejection reason is required");
    if (!VALID_REJECTION_REASONS.includes(reason)) {
        throw new ApiError(400, `Invalid rejection reason. Must be one of: ${VALID_REJECTION_REASONS.join(', ')}`);
    }

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can reject this order");
    if (order.orderStatus !== 'payment_received') throw new ApiError(400, "Order can only be rejected when payment is received");

    order.orderStatus = 'seller_rejected';
    order.sellerResponse = {
        status: 'rejected',
        rejectionReason: reason,
        rejectionNote: note || '',
        respondedAt: new Date()
    };
    await order.save();

    const rejectionLabel = REJECTION_REASON_LABELS[reason] || reason;
    if (order.buyerId) {
        sendOrderNotification({
            recipientId: order.buyerId,
            senderId: sellerId,
            orderId: order._id,
            orderNumber: order.orderNumber,
            notificationMessage: `Your order #${order.orderNumber} has been rejected by the seller. Reason: ${rejectionLabel}`,
            chatMessageText: `Order #${order.orderNumber} has been rejected by the seller.\n\nReason: ${rejectionLabel}${note ? `\nNote: ${note}` : ''}\n\nYour payment is safe in escrow. The Findernate team will process your refund shortly.`,
            chatId: order.chatId,
            buyerId: order.buyerId
        }).catch(err => console.error('Seller reject notification error:', err));
    }

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order rejected by seller. Admin will process the refund.")
    );
});

export const markOrderShipped = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { trackingId, carrier, packingVideoUrl, packingImages } = req.body;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can mark order as shipped");
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

    if (order.buyerId) {
        sendOrderNotification({
            recipientId: order.buyerId,
            senderId: sellerId,
            orderId: order._id,
            orderNumber: order.orderNumber,
            notificationMessage: `Your order #${order.orderNumber} has been shipped!`,
            chatMessageText: `Order #${order.orderNumber} has been shipped!${order.shippingInfo?.trackingId ? `\nTracking ID: ${order.shippingInfo.trackingId}` : ''}${order.shippingInfo?.carrier ? `\nCarrier: ${order.shippingInfo.carrier}` : ''}\n\nYou will be notified when it is delivered.`,
            chatId: order.chatId,
            buyerId: order.buyerId
        }).catch(err => console.error('Ship notification error:', err));
    }

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order marked as shipped")
    );
});

export const updateTrackingInfo = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { trackingId, carrier } = req.body;
    const sellerId = req.user._id;

    if (!trackingId && !carrier) throw new ApiError(400, "Provide at least trackingId or carrier to update");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can update tracking info");
    if (order.orderStatus !== 'shipped' && order.orderStatus !== 'delivered') {
        throw new ApiError(400, "Order must be shipped or delivered to update tracking info");
    }

    if (!order.shippingInfo) order.shippingInfo = {};
    if (trackingId) order.shippingInfo.trackingId = trackingId;
    if (carrier) order.shippingInfo.carrier = carrier;
    await order.save();

    if (order.buyerId) {
        sendOrderNotification({
            recipientId: order.buyerId,
            senderId: sellerId,
            orderId: order._id,
            orderNumber: order.orderNumber,
            notificationMessage: `Tracking info updated for order #${order.orderNumber}`,
            chatMessageText: `Tracking info updated for Order #${order.orderNumber}${trackingId ? `\nTracking ID: ${trackingId}` : ''}${carrier ? `\nCarrier: ${carrier}` : ''}`,
            chatId: order.chatId,
            buyerId: order.buyerId
        }).catch(err => console.error('Tracking update notification error:', err));
    }

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Tracking info updated")
    );
});

export const markOrderDelivered = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const sellerId = req.user._id;

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can mark order as delivered");
    if (order.orderStatus !== 'shipped') throw new ApiError(400, "Order must be shipped first");

    order.orderStatus = 'delivered';
    if (!order.shippingInfo) order.shippingInfo = {};
    order.shippingInfo.deliveredAt = new Date();
    await order.save();

    if (order.buyerId) {
        sendOrderNotification({
            recipientId: order.buyerId,
            senderId: sellerId,
            orderId: order._id,
            orderNumber: order.orderNumber,
            notificationMessage: `Your order #${order.orderNumber} has been marked as delivered`,
            chatMessageText: `Order #${order.orderNumber} has been marked as delivered by the seller.\n\nPlease confirm delivery once you have received and inspected the product.`,
            chatId: order.chatId,
            buyerId: order.buyerId
        }).catch(err => console.error('Deliver notification error:', err));
    }

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Order marked as delivered")
    );
});

export const uploadPackingMedia = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { packingVideoUrl, packingImages } = req.body;
    const sellerId = req.user._id;

    if (!packingVideoUrl && (!packingImages || packingImages.length === 0)) {
        throw new ApiError(400, "At least one media file (video or images) is required");
    }

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can upload packing media");

    const allowedStatuses = ['payment_received', 'processing', 'shipped'];
    if (!allowedStatuses.includes(order.orderStatus)) {
        throw new ApiError(400, "Cannot upload packing media for this order status");
    }

    if (!order.shippingInfo) order.shippingInfo = {};

    if (packingVideoUrl) order.shippingInfo.packingVideoUrl = packingVideoUrl;

    if (packingImages && packingImages.length > 0) {
        const existingImages = order.shippingInfo.packingImages || [];
        order.shippingInfo.packingImages = [...existingImages, ...packingImages].slice(0, 10);
    }

    await order.save();

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Packing media uploaded successfully")
    );
});

export const rateBuyer = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { rating, review } = req.body;
    const sellerId = req.user._id;

    if (!rating || rating < 1 || rating > 5) throw new ApiError(400, "Rating must be between 1 and 5");

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");
    if (order.sellerId.toString() !== sellerId.toString()) throw new ApiError(403, "Only the seller can rate the buyer");
    if (!['confirmed', 'delivered'].includes(order.orderStatus)) {
        throw new ApiError(400, "Order must be delivered or confirmed to rate the buyer");
    }
    if (order.sellerRating) throw new ApiError(400, "You have already rated this buyer");

    order.sellerRating = rating;
    order.sellerReview = review;
    await order.save();

    const updatedOrder = await populateOrderFor(orderId, sellerId);

    return res.status(200).json(
        new ApiResponse(200, { order: updatedOrder }, "Buyer rated successfully")
    );
});
