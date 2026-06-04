import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import {
    notificationRateLimit,
    unreadCountsRateLimit
} from "../middlewares/rateLimiter.middleware.js";
import {
    getNotifications,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    getUnreadCounts,
    getInitialUnreadCounts
} from "../controllers/notification.controllers.js";

const router = Router();

// All routes require authentication
router.use(verifyJWT);

// Apply rate limiting to all notification routes
router.use(notificationRateLimit);

// Get all notifications for the logged-in user
router.get("/", getBlockedUsersMiddleware, getNotifications);

// 🚀 NEW: Get initial unread counts (for app startup only)
router.get("/initial-counts", getInitialUnreadCounts);

// ⚠️ DEPRECATED: Get unread counts (heavily rate limited to discourage polling)
router.get("/unread-counts", unreadCountsRateLimit, getUnreadCounts);

// Mark a specific notification as read
router.put("/:notificationId/read", markNotificationAsRead);

// Mark all notifications as read
router.put("/mark-all-read", markAllNotificationsAsRead);

// Delete a specific notification
router.delete("/:notificationId", deleteNotification);

export default router;