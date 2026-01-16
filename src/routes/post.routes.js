// routes/post.routes.js
import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { cacheUserFeed } from "../middlewares/cache.middleware.js";
import {
    createNormalPost,
    createProductPost,
    createServicePost,
    createBusinessPost,
    getUserProfilePosts,
    getMyPosts,
    getPostById,
    deleteContent,
    editPost,
} from "../controllers/post.controllers.js";
import { getHomeFeed } from "../controllers/homeFeed.controllers.js";
import { likePost, unlikePost, likeComment, unlikeComment } from "../controllers/like.controllers.js";
import { createComment, getCommentsByPost, getCommentById, updateComment, deleteComment } from "../controllers/comment.controllers.js";
import { getNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification } from "../controllers/notification.controllers.js";
import { getProfileTabContent } from "../controllers/switch.controllers.js";
import { savePost, unsavePost, getSavedPosts, checkPostSaved } from "../controllers/savePost.controllers.js";
import { reportContent, getReports, updateReportStatus } from "../controllers/report.controllers.js";
import { trackPostInteraction, hidePost, batchTrackInteractions, getUserInteractionHistory } from "../controllers/postInteraction.controllers.js";


const router = Router();

// Accept image or video from frontend
const mediaUpload = upload.fields([
    { name: "image", maxCount: 10 },
    { name: "video", maxCount: 10 },
    { name: "reel", maxCount: 10 },
    { name: "story", maxCount: 10 },
    { name: "thumbnail", maxCount: 1 },
]);

router.route("/create/normal").post(mediaUpload, verifyJWT, createNormalPost);
router.route("/create/service").post(mediaUpload, verifyJWT, createServicePost);
router.route("/create/product").post(mediaUpload, verifyJWT, createProductPost);
router.route("/create/business").post(mediaUpload, verifyJWT, createBusinessPost);
router.route("/user/:userId/profile").get(verifyJWT, getUserProfilePosts);
router.route("/switch/profile/:userId").get(verifyJWT, getProfileTabContent);
router.route("/home-feed").get(optionalVerifyJWT, getBlockedUsersMiddleware, cacheUserFeed, getHomeFeed);
router.route("/myPosts").get(verifyJWT, getMyPosts);
router.route("/notifications").get(verifyJWT, getNotifications);


// Like/unlike post
router.route("/like").post(verifyJWT, likePost);
router.route("/unlike").post(verifyJWT, unlikePost);

// Like/unlike comment
router.route("/like-comment").post(verifyJWT, likeComment);
router.route("/unlike-comment").post(verifyJWT, unlikeComment);

// Comment routes
router.route("/comment").post(verifyJWT, createComment);
router.route("/comments").get(verifyJWT, getCommentsByPost);
router.route("/comment/:commentId").get(verifyJWT, getCommentById);
router.route("/comment/:commentId").put(verifyJWT, updateComment);
router.route("/comment/:commentId").delete(verifyJWT, deleteComment);

// Save post routes (Instagram-style: Always private, only visible to owner)
router.route("/save").post(verifyJWT, savePost);
router.route("/save/:postId").delete(verifyJWT, unsavePost);
router.route("/saved").get(verifyJWT, getSavedPosts);
router.route("/saved/check/:postId").get(verifyJWT, checkPostSaved);

// Report routes
router.route("/report").post(verifyJWT, reportContent);
router.route("/reports").get(verifyJWT, getReports);
router.route("/report/:reportId/status").put(verifyJWT, updateReportStatus);

// Interaction tracking routes
router.route("/interaction/track").post(verifyJWT, trackPostInteraction);
router.route("/interaction/batch").post(verifyJWT, batchTrackInteractions);
router.route("/interaction/hide").post(verifyJWT, hidePost);
router.route("/interaction/history").get(verifyJWT, getUserInteractionHistory);

// Edit post route
router.route("/edit/:postId").put(verifyJWT, editPost);

// Common API - handles get and delete for posts, stories, and reels
router.route("/:postId").get(verifyJWT, getPostById).delete(verifyJWT, deleteContent);

// Notification routes
router.route("/notification").get(optionalVerifyJWT, getNotifications);
router.route("/notification/:notificationId/read").patch(verifyJWT, markNotificationAsRead);
router.route("/notification/read-all").patch(verifyJWT, markAllNotificationsAsRead);
router.route("/notification/:notificationId").delete(verifyJWT, deleteNotification);

export default router;
