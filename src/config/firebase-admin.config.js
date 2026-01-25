import admin from "firebase-admin";

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK
 *
 * Instructions:
 * 1. Go to Firebase Console: https://console.firebase.google.com/
 * 2. Select your project
 * 3. Go to Project Settings > Service Accounts
 * 4. Click "Generate new private key"
 * 5. Save the JSON file as "serviceAccountKey.json" in the src/config folder
 *
 * OR use environment variables:
 * FIREBASE_PROJECT_ID=your-project-id
 * FIREBASE_PRIVATE_KEY=your-private-key (with \n for line breaks)
 * FIREBASE_CLIENT_EMAIL=your-client-email
 */
const initializeFirebase = () => {
  if (firebaseApp) {
    console.log("ℹ️ Firebase Admin already initialized, returning existing app");
    return firebaseApp;
  }

  console.log("🔥 Initializing Firebase Admin SDK...");

  try {
    // Method 1: Using environment variables (recommended for production)
    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.FIREBASE_CLIENT_EMAIL
    ) {
      console.log("✅ Firebase environment variables found:");
      console.log("   - FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID);
      console.log("   - FIREBASE_CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL);
      console.log("   - FIREBASE_PRIVATE_KEY length:", process.env.FIREBASE_PRIVATE_KEY?.length);

      // Handle multiple levels of escaping (Coolify might double-escape)
      let privateKey = process.env.FIREBASE_PRIVATE_KEY;

      // Check for double-escaped newlines
      const hasDoubleEscape = privateKey.includes("\\\\n");
      const hasSingleEscape = privateKey.includes("\\n");

      console.log("🔍 Private key escape analysis:");
      console.log("   - Has double-escaped newlines (\\\\n):", hasDoubleEscape);
      console.log("   - Has single-escaped newlines (\\n):", hasSingleEscape);

      // Replace \\n with \n (for double-escaped newlines)
      if (hasDoubleEscape) {
        privateKey = privateKey.replace(/\\\\n/g, "\n");
        console.log("   - Converted double-escaped newlines");
      }
      // Replace \n with actual newline (for single-escaped newlines)
      if (hasSingleEscape) {
        privateKey = privateKey.replace(/\\n/g, "\n");
        console.log("   - Converted single-escaped newlines");
      }

      console.log("🔐 Initializing Firebase with credentials...");
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
      console.log("✅ Firebase Admin initialized successfully!");
      console.log("✅ Project ID:", process.env.FIREBASE_PROJECT_ID);
    }
    // Method 2: Using service account key file (for development)
    else {
      console.error(
        "❌ Firebase Admin SDK not initialized - Missing environment variables"
      );
      console.error("Missing variables:");
      console.error("   - FIREBASE_PROJECT_ID:", !!process.env.FIREBASE_PROJECT_ID);
      console.error("   - FIREBASE_CLIENT_EMAIL:", !!process.env.FIREBASE_CLIENT_EMAIL);
      console.error("   - FIREBASE_PRIVATE_KEY:", !!process.env.FIREBASE_PRIVATE_KEY);
      console.warn(
        "Please add Firebase credentials to .env file:\n" +
        "FIREBASE_PROJECT_ID=your-project-id\n" +
        "FIREBASE_CLIENT_EMAIL=your-client-email\n" +
        "FIREBASE_PRIVATE_KEY=your-private-key"
      );
      return null;
    }

    return firebaseApp;
  } catch (error) {
    console.error("❌ Failed to initialize Firebase Admin!");
    console.error("❌ Error message:", error.message);
    console.error("❌ Error code:", error.code);
    console.error("❌ Error stack:", error.stack);
    return null;
  }
};

// Initialize Firebase on module load
const app = initializeFirebase();

/**
 * Get Firebase Admin Messaging instance
 */
const getMessaging = () => {
  if (!app) {
    throw new Error(
      "Firebase Admin SDK not initialized. Please configure Firebase credentials."
    );
  }
  return admin.messaging();
};

/**
 * Send FCM notification to a single device
 */
const sendNotification = async (fcmToken, notification, data = {}) => {
  try {
    console.log('🔥 sendNotification called');
    console.log('📱 FCM Token length:', fcmToken?.length);
    console.log('📦 Notification:', notification);

    // Check if Firebase Admin is initialized
    if (!app) {
      console.error('❌ Firebase Admin SDK not initialized!');
      return {
        success: false,
        error: 'Firebase Admin SDK not initialized',
        errorCode: 'firebase/not-initialized'
      };
    }

    const messaging = getMessaging();
    console.log('✅ Firebase messaging instance obtained');

    const message = {
      token: fcmToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...data,
        // Ensure all data values are strings
        ...Object.keys(data).reduce((acc, key) => {
          acc[key] = String(data[key]);
          return acc;
        }, {}),
      },
      android: {
        priority: "high",
        notification: {
          channelId: "calls",
          priority: "high",
          defaultVibrateTimings: true,
          sound: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
            contentAvailable: true,
          },
        },
      },
    };

    console.log('📤 Sending FCM message via Firebase Admin SDK...');
    const response = await messaging.send(message);
    console.log("✅ FCM notification sent successfully! Response:", response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error("❌ FCM notification failed!");
    console.error("❌ Error message:", error.message);
    console.error("❌ Error code:", error.code);
    console.error("❌ Error name:", error.name);
    if (error.errorInfo) {
      console.error("❌ Error info:", JSON.stringify(error.errorInfo));
    }

    // Handle invalid tokens - check both error code and message
    const isInvalidToken =
      error.code === "messaging/invalid-registration-token" ||
      error.code === "messaging/registration-token-not-registered" ||
      error.code === "messaging/invalid-argument" ||
      error.message?.includes("Requested entity was not found") ||
      error.message?.includes("not a valid FCM registration token");

    if (isInvalidToken) {
      console.error("❌ INVALID TOKEN detected - this FCM token is invalid/expired");
      return {
        success: false,
        invalidToken: true,
        error: error.message,
        errorCode: error.code
      };
    }

    return { success: false, error: error.message, errorCode: error.code };
  }
};

/**
 * Send FCM notification to multiple devices
 */
const sendMulticastNotification = async (
  fcmTokens,
  notification,
  data = {}
) => {
  try {
    const messaging = getMessaging();

    const message = {
      tokens: fcmTokens,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...Object.keys(data).reduce((acc, key) => {
          acc[key] = String(data[key]);
          return acc;
        }, {}),
      },
      android: {
        priority: "high",
        notification: {
          channelId: "calls",
          priority: "high",
          defaultVibrateTimings: true,
          sound: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
            contentAvailable: true,
          },
        },
      },
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(
      `✅ FCM multicast sent: ${response.successCount}/${fcmTokens.length} delivered`
    );

    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
    };
  } catch (error) {
    console.error("❌ FCM multicast failed:", error.message);
    return { success: false, error: error.message };
  }
};

export default admin;
export { getMessaging, sendNotification, sendMulticastNotification };
