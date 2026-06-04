import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";

const saveFCMToken = asyncHandler(async (req, res) => {
    const { fcmToken } = req.body;
    const userId = req.user?._id;

    if (!fcmToken) {
        throw new ApiError(400, "FCM token is required");
    }

    if (!userId) {
        return res.status(200).json(
            new ApiResponse(200, {
                saved: false,
                reason: "not_authenticated"
            }, "User not authenticated. FCM token will be saved after login.")
        );
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { fcmToken, fcmTokenUpdatedAt: new Date() },
        { new: true }
    ).select('fcmToken fcmTokenUpdatedAt');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            saved: true,
            fcmToken: user.fcmToken,
            updatedAt: user.fcmTokenUpdatedAt
        }, "FCM token saved successfully")
    );
});

const checkFirebaseStatus = asyncHandler(async (req, res) => {
    const status = {
        envVarsPresent: {
            FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
            FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
            FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY
        },
        envVarsValues: {
            FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'NOT SET',
            FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || 'NOT SET',
            FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ?
                `${process.env.FIREBASE_PRIVATE_KEY.substring(0, 50)}... (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` :
                'NOT SET'
        }
    };

    return res.status(200).json(
        new ApiResponse(200, status, "Firebase configuration status")
    );
});

const testFCMNotification = asyncHandler(async (req, res) => {
    const userId = req.user?._id;

    if (!userId) {
        throw new ApiError(401, "User not authenticated");
    }

    const user = await User.findById(userId).select('fcmToken username fullName');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.fcmToken) {
        throw new ApiError(400, "No FCM token found for this user. Please refresh the app.");
    }

    try {
        const { sendNotification } = await import('../../config/firebase-admin.config.js');

        const notification = {
            title: "Test Notification",
            body: "This is a test FCM notification from FinderNate backend"
        };

        const data = {
            type: 'test',
            timestamp: new Date().toISOString()
        };

        const result = await sendNotification(user.fcmToken, notification, data);

        if (result.success) {
            return res.status(200).json(
                new ApiResponse(200, {
                    success: true,
                    messageId: result.messageId,
                    fcmToken: user.fcmToken.substring(0, 20) + '...'
                }, "Test FCM notification sent successfully")
            );
        } else {
            console.error('❌ Test FCM failed:', result.error);
            return res.status(500).json(
                new ApiResponse(500, {
                    success: false,
                    error: result.error,
                    invalidToken: result.invalidToken
                }, "Failed to send test FCM notification")
            );
        }
    } catch (error) {
        console.error('❌ FCM test error:', error);
        throw new ApiError(500, `FCM test failed: ${error.message}`);
    }
});

export {
    saveFCMToken,
    checkFirebaseStatus,
    testFCMNotification,
};
