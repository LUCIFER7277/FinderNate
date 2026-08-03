import Notification from "../../models/notification.models.js";
import Message from "../../models/message.models.js";
import Chat from "../../models/chat.models.js";
import Order from "../../models/order.models.js";
import socketManager from "../../config/socket.js";
import notificationCache from "../../utils/notificationCache.utils.js";

export const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    }
};

export const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    }
};

export const sendOrderNotification = async ({
    recipientId,
    senderId,
    orderId,
    orderNumber,
    notificationMessage,
    chatMessageText,
    chatId,
    buyerId
}) => {
    try {
        const notification = await Notification.create({
            receiverId: recipientId,
            senderId: senderId,
            type: 'order',
            orderId: orderId,
            message: notificationMessage
        });

        if (global.io) {
            global.io.to(`user_${recipientId}`).emit("notification", notification);
        }

        await notificationCache.invalidateNotificationCache(recipientId);

        // Skip chat message for guest/shareable orders
        if (!chatId || !buyerId) return;

        const chat = await Chat.findById(chatId);
        if (!chat) return;

        const recipients = chat.participants.filter(
            p => p.toString() !== senderId.toString()
        );

        const chatMessage = await Message.create({
            chatId,
            sender: senderId,
            message: chatMessageText,
            messageType: 'order_update',
            timestamp: new Date(),
            readBy: [senderId],
            deliveryStatus: recipients.map(rid => ({
                userId: rid,
                status: 'sent'
            }))
        });

        chat.lastMessageAt = new Date();
        chat.lastMessage = {
            sender: senderId,
            message: chatMessageText,
            timestamp: new Date()
        };
        chat.lastMessageId = chatMessage._id;
        await chat.save();

        const populatedMessage = await Message.findById(chatMessage._id)
            .populate('sender', 'username fullName profileImageUrl')
            .lean();

        safeEmitToChat(chatId.toString(), 'new_message', { chatId, message: populatedMessage });
        safeEmitToUser(recipientId.toString(), 'new_message', { chatId, message: populatedMessage });

        await notificationCache.invalidateMessageCache(recipientId);
    } catch (error) {
        console.error(`sendOrderNotification error for order ${orderNumber}:`, error);
    }
};

export const populateOrder = (orderId) =>
    Order.findById(orderId)
        .populate('buyerId', 'fullName username profileImageUrl phoneNumber')
        .populate('sellerId', 'fullName username profileImageUrl phoneNumber')
        .populate('postId', 'media caption');

// ─────────────────────────────────────────────────────────────────────────────
// THE SELLER DOES NOT GET THE BUYER'S EMAIL ADDRESS
//
// Guest orders carry `buyerDetails { fullName, email, phoneNumber }`, and every
// seller-facing order read returned the whole order document — so the seller
// got the address the buyer's Findernate account is (or will be) keyed on. That
// is the one field a hostile seller can act on: it is the login identifier, it
// is what password reset is addressed to, and it is what the removed
// order-claim endpoint keyed ownership on. The seller is precisely the party
// best placed to abuse it, and fulfilment does not need it.
//
// What fulfilment DOES need is a name and a phone number, so that is what is
// left. The buyer's own view of their own order is untouched.
const SELLER_VISIBLE_BUYER_DETAILS = (details) => ({
    fullName:    details?.fullName    ?? null,
    phoneNumber: details?.phoneNumber ?? null,
});

/**
 * Projects an order down to what `viewerId` is allowed to see.
 *
 * Anyone who is not the buyer — which on the order routes means the seller,
 * since a guest order has no buyer at all and these routes all require a token —
 * gets buyerDetails reduced to the fulfilment fields.
 *
 * Accepts a hydrated Mongoose document, a .lean() object or a plain object, and
 * always returns a plain object (the caller is about to serialise it anyway).
 */
export const redactOrderForViewer = (order, viewerId) => {
    if (!order) return order;

    const obj = typeof order.toObject === 'function' ? order.toObject() : { ...order };

    // buyerId may be an ObjectId, a populated document, or null on a guest order.
    const buyerIdStr  = (obj.buyerId?._id ?? obj.buyerId)?.toString() ?? null;
    const viewerIdStr = viewerId ? viewerId.toString() : null;

    // The buyer reading their own order sees everything.
    if (buyerIdStr && viewerIdStr && buyerIdStr === viewerIdStr) return obj;

    if (obj.buyerDetails) obj.buyerDetails = SELLER_VISIBLE_BUYER_DETAILS(obj.buyerDetails);
    return obj;
};

export const redactOrdersForViewer = (orders, viewerId) =>
    (orders || []).map(order => redactOrderForViewer(order, viewerId));

/**
 * populateOrder + the redaction above. Every seller action responds with the
 * order it just changed, so they all go through this rather than populateOrder.
 */
export const populateOrderFor = async (orderId, viewerId) =>
    redactOrderForViewer(await populateOrder(orderId), viewerId);
