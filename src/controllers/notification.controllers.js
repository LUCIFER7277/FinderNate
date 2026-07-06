import Notification from "../models/notification.models.js";
import Message from "../models/message.models.js";
import Chat from "../models/chat.models.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import notificationCache from "../utils/notificationCache.utils.js";

const sendRealTimeNotification = async (recipientId, notification) => {
    // Use Socket.IO Redis adapter to emit to user across all processes
    if (global.io) {
        global.io.to(`user_${recipientId}`).emit("notification", notification);
    }
};

// 🟢 Like Notification
export const createLikeNotification = async ({ recipientId, sourceUserId, postId, commentId }) => {
    if (!recipientId || !sourceUserId || (!postId && !commentId)) return;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "like",
        senderId: sourceUserId,
        postId,
        commentId,
        message: commentId ? "liked your comment" : "liked your post"
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);
};

// 🟡 Comment Notification
export const createCommentNotification = asyncHandler(async ({ recipientId, sourceUserId, postId, commentId, isReply = false }) => {
    if (!recipientId || !sourceUserId || !postId || !commentId) {
        throw new ApiError(400, "recipientId, sourceUserId, postId, and commentId are required");
    }

    const type = "comment";
    const message = isReply ? "replied to your comment" : "commented on your post";

    const notification = await Notification.create({
        receiverId: recipientId,
        type,
        senderId: sourceUserId,
        postId,
        commentId,
        message
    });

    sendRealTimeNotification(recipientId, notification);

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(recipientId);
});

//  Follow Notification
export const createFollowNotification = async ({ recipientId, sourceUserId }) => {
    if (!recipientId || !sourceUserId) return;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "follow",
        senderId: sourceUserId,
        message: "started following you"
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);
};

// 🔴 Unlike Notification
export const createUnlikeNotification = async ({ recipientId, sourceUserId, postId, commentId }) => {
    if (!recipientId || !sourceUserId || (!postId && !commentId)) return;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "unlike",
        senderId: sourceUserId,
        postId,
        commentId,
        message: commentId ? "unliked your comment" : "unliked your post"
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);
};

//  Get Logged-in User's Notifications
export const getNotifications = asyncHandler(async (req, res) => {
    const receiverId = req.user._id;
    const blockedUsers = req.blockedUsers || [];

    // Build query to exclude notifications from blocked users
    const query = { receiverId };
    if (blockedUsers.length > 0) {
        query.senderId = { $nin: blockedUsers };
    }

    const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .populate("senderId", "username profileImageUrl");

    res.status(200).json(new ApiResponse(200, notifications, "Notifications fetched successfully"));
});

// 📤 Mark a Notification as Read
export const markNotificationAsRead = asyncHandler(async (req, res) => {
    const { notificationId } = req.params;

    const notification = await Notification.findById(notificationId);
    if (!notification) throw new ApiError(404, "Notification not found");

    notification.isRead = true;
    await notification.save();

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(notification.receiverId);

    res.status(200).json(new ApiResponse(200, notification, "Notification marked as read"));
});

// 📤 Mark All Notifications as Read
export const markAllNotificationsAsRead = asyncHandler(async (req, res) => {
    const receiverId = req.user._id;

    await Notification.updateMany({ receiverId, isRead: false }, { $set: { isRead: true } });

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(receiverId);

    res.status(200).json(new ApiResponse(200, {}, "All notifications marked as read"));
});

// ❌ Delete a Notification
export const deleteNotification = asyncHandler(async (req, res) => {
    const { notificationId } = req.params;

    const notification = await Notification.findById(notificationId);
    if (!notification) throw new ApiError(404, "Notification not found");

    await notification.deleteOne();

    res.status(200).json(new ApiResponse(200, {}, "Notification deleted successfully"));
});

// 📊 Get Unread Counts (Notifications & Messages) - Now with caching and deprecation warning
export const getUnreadCounts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const userToken = req.headers.authorization?.split(" ")[1] || req.cookies?.accessToken;

    try {
        // Get counts from cache first, then database if needed
        const counts = await notificationCache.getUnreadCounts(userId);

        const response = {
            unreadNotifications: counts.unreadNotifications,
            unreadMessages: counts.unreadMessages,
            userToken: userToken,
            timestamp: new Date().toISOString(),
            fromCache: counts.fromCache,
            // Deprecation warning for polling
            warning: "⚠️ Consider using WebSocket events instead of polling this endpoint. Listen to 'unread_counts_updated' event for real-time updates."
        };

        res.status(200).json(new ApiResponse(200, response, "Unread counts fetched successfully"));
    } catch (error) {
        throw new ApiError(500, "Error fetching unread counts: " + error.message);
    }
});

// 🚀 NEW: Get Initial Unread Counts (for app startup only)
export const getInitialUnreadCounts = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    try {
        const counts = await notificationCache.getUnreadCounts(userId);

        const response = {
            unreadNotifications: counts.unreadNotifications,
            unreadMessages: counts.unreadMessages,
            timestamp: new Date().toISOString(),
            fromCache: counts.fromCache,
            message: "Use Socket.IO 'unread_counts_updated' events for live updates instead of polling."
        };

        res.status(200).json(new ApiResponse(200, response, "Initial unread counts fetched successfully"));
    } catch (error) {
        throw new ApiError(500, "Error fetching initial unread counts: " + error.message);
    }
});
