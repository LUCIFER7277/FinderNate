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
