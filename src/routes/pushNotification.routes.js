import { Router } from "express";
import { 
  subscribeToPush, 
  unsubscribeFromPush, 
  testPushNotification,
  getUserSubscriptions
} from "../controllers/pushNotification.controllers.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// All push notification routes require authentication
router.use(verifyJWT);

// Subscribe to push notifications
router.route("/subscribe").post(subscribeToPush);

// Unsubscribe from push notifications
router.route("/unsubscribe").post(unsubscribeFromPush);

// Get user's push subscriptions (for debugging)
router.route("/subscriptions").get(getUserSubscriptions);

// Test push notification endpoint
router.route("/test").post(testPushNotification);

export default router;