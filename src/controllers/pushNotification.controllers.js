import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { ApiError } from "../utlis/ApiError.js";
import PushSubscription from "../models/pushSubscription.models.js";
import webpush from 'web-push';

// Lazy initialization flag
let vapidInitialized = false;

// Configure web-push with VAPID keys (lazy initialization)
const initializeVapid = () => {
  if (!vapidInitialized) {
    webpush.setVapidDetails(
      'mailto:support@findernate.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidInitialized = true;
  }
};

// Subscribe to push notifications
export const subscribeToPush = asyncHandler(async (req, res) => {
  initializeVapid();
  
  const { subscription } = req.body;
  const userId = req.user._id;

  if (!subscription || !subscription.endpoint) {
    throw new ApiError(400, "Invalid subscription object");
  }

  try {
    // Check if subscription already exists for this user
    let existingSubscription = await PushSubscription.findOne({ userId });

    if (existingSubscription) {
      // Update existing subscription
      existingSubscription.endpoint = subscription.endpoint;
      existingSubscription.p256dh = subscription.keys.p256dh;
      existingSubscription.auth = subscription.keys.auth;
      existingSubscription.updatedAt = new Date();
      await existingSubscription.save();
    } else {
      // Create new subscription
      existingSubscription = await PushSubscription.create({
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth
      });
    }

    return res.status(200).json(
      new ApiResponse(200, existingSubscription, "Push subscription saved successfully")
    );
  } catch (error) {
    console.error("Error saving push subscription:", error);
    throw new ApiError(500, "Failed to save push subscription");
  }
});

// Unsubscribe from push notifications
export const unsubscribeFromPush = asyncHandler(async (req, res) => {
  const { subscription } = req.body;
  const userId = req.user._id;

  try {
    const result = await PushSubscription.deleteOne({
      userId,
      endpoint: subscription.endpoint
    });

    return res.status(200).json(
      new ApiResponse(200, { deletedCount: result.deletedCount }, "Push subscription removed successfully")
    );
  } catch (error) {
    console.error("Error removing push subscription:", error);
    throw new ApiError(500, "Failed to remove push subscription");
  }
});

// Send push notification to user(s)
export const sendPushNotification = async (userIds, notificationData) => {
  try {
<<<<<<< HEAD
    initializeVapid();
    
=======
>>>>>>> ac77c6651c422022ac6ec4f8ddfa65a87d42f7ee
    if (!Array.isArray(userIds)) {
      userIds = [userIds];
    }

    // Get all subscriptions for the target users
    const subscriptions = await PushSubscription.find({
      userId: { $in: userIds },
      isActive: true
    });

    if (subscriptions.length === 0) {
      return;
    }

    // Prepare notification payload
    const payload = JSON.stringify({
      title: notificationData.title,
      body: notificationData.body,
      icon: notificationData.icon || '/Findernate.ico',
      badge: '/Findernate.ico',
      tag: notificationData.tag || 'message-notification',
      url: notificationData.url || '/chats',
      chatId: notificationData.chatId,
      messageId: notificationData.messageId,
      senderId: notificationData.senderId,
      timestamp: Date.now()
    });

    // Send notifications to all subscriptions
    const notificationPromises = subscriptions.map(async (sub) => {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        await webpush.sendNotification(pushSubscription, payload);
      } catch (error) {
        console.error(`Failed to send push notification to user ${sub.userId}:`, error);

        // If subscription is invalid, mark it as inactive
        if (error.statusCode === 410 || error.statusCode === 404) {
          await PushSubscription.updateOne(
            { _id: sub._id },
            { isActive: false }
          );
        }
      }
    });

    await Promise.allSettled(notificationPromises);

  } catch (error) {
    console.error("Error in sendPushNotification:", error);
  }
};

// Get user's push subscriptions (for debugging)
export const getUserSubscriptions = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const subscriptions = await PushSubscription.find({ userId, isActive: true });

  return res.status(200).json(
    new ApiResponse(200, { subscriptions, count: subscriptions.length }, "User subscriptions retrieved")
  );
});

// Test push notification endpoint (for testing purposes)
export const testPushNotification = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const testNotification = {
    title: "Test Notification",
    body: "This is a test push notification from FinderNate! 🎉",
    chatId: "test-chat",
    messageId: "test-message",
    senderId: userId,
    url: "/chats"
  };

  await sendPushNotification([userId], testNotification);

  return res.status(200).json(
    new ApiResponse(200, {}, "Test push notification sent")
  );
});