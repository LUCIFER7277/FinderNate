import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { cacheSearchResults } from "../middlewares/cache.middleware.js";
import { loginUser, logOutUser, registerUser, getUserProfile, updateUserProfile, changePassword, deleteAccount, searchUsers, verifyEmailWithOTP, uploadProfileImage, sendVerificationOTPForEmail, sendPasswordResetOTP, resetPasswordWithOTP, getOtherUserProfile, checkTokenExpiry, togglePhoneNumberVisibility, toggleAddressVisibility, trackSearch, getPopularSearches, blockUser, unblockUser, getBlockedUsers, checkIfUserBlocked, getUsernameSuggestions, checkUsernameAvailability, toggleFullPrivateAccount, toggleServiceAutoFill, getPreviousServicePostData, toggleProductAutoFill, getPreviousProductPostData, saveFCMToken, testFCMNotification, checkFirebaseStatus } from "../controllers/user.controllers.js";
import { searchAllContent } from "../controllers/searchAllContent.controllers.js";
import { followUser, unfollowUser, getFollowers, getFollowing, approveFollowRequest, rejectFollowRequest, getPendingFollowRequests, getSentFollowRequests } from "../controllers/follower.controllers.js";
import { getSearchSuggestions } from "../controllers/searchSuggestion.controllers.js";

const router = Router();

router.route("/register").post(registerUser);
router.route("/login").post(loginUser);
router.route("/logout").post(verifyJWT, logOutUser);
router.route("/profile").get(verifyJWT, getUserProfile);
router.route("/profile").put(verifyJWT, upload.single("profileImage"), updateUserProfile);
router.route("/profile/change-password").put(verifyJWT, changePassword);
router.route("/profile").delete(verifyJWT, deleteAccount);
router.route("/profile/search").get(verifyJWT, getBlockedUsersMiddleware, searchUsers);
router.route("/verify-email-otp").post(verifyEmailWithOTP);
router.route("/send-verification-otp").post(sendVerificationOTPForEmail);
router.route("/profile/upload-image").post(verifyJWT, upload.single("profileImage"), uploadProfileImage);
router.route("/send-reset-otp").post(sendPasswordResetOTP);
router.route("/reset-password").post(resetPasswordWithOTP);
router.route("/check-token").post(checkTokenExpiry);
router.route("/searchAllContent").get(optionalVerifyJWT, getBlockedUsersMiddleware, cacheSearchResults, searchAllContent);
router.route("/profile/other").get(verifyJWT, getBlockedUsersMiddleware, getOtherUserProfile);

// Follower routes
router.post("/follow", verifyJWT, followUser);
router.post("/unfollow", verifyJWT, unfollowUser);
router.get("/followers/:userId", verifyJWT, getFollowers);
router.get("/following/:userId", verifyJWT, getFollowing);

// Follow request routes
router.post("/follow-request/approve", verifyJWT, approveFollowRequest);
router.post("/follow-request/reject", verifyJWT, rejectFollowRequest);
router.get("/follow-requests/pending", verifyJWT, getPendingFollowRequests);
router.get("/follow-requests/sent", verifyJWT, getSentFollowRequests);

// Search suggestion routes
router.get("/search-suggestions", verifyJWT, getSearchSuggestions);

// Search tracking routes
router.post("/track-search", trackSearch);
router.get("/popular-searches", getPopularSearches);


// Get other user profile by userId or username (already defined above with middleware)
// router.get("/profile/other", verifyJWT, getOtherUserProfile);

// Privacy settings routes
router.put("/privacy/phone-number", verifyJWT, togglePhoneNumberVisibility);
router.put("/privacy/address", verifyJWT, toggleAddressVisibility);
router.put("/privacy/account", verifyJWT, toggleFullPrivateAccount);
router.put("/privacy/full-private", verifyJWT, toggleFullPrivateAccount); // Alias for /privacy/account

// Block user routes
router.post("/block", verifyJWT, blockUser);
router.post("/unblock", verifyJWT, unblockUser);
router.get("/blocked-users", verifyJWT, getBlockedUsers);
router.get("/check-block/:userId", verifyJWT, checkIfUserBlocked);

// Username suggestion routes (real-time as user types)
router.get("/username-suggestions", getUsernameSuggestions);
router.get("/check-username", checkUsernameAvailability);

// Service post preferences routes
router.put("/service-post/toggle-autofill", verifyJWT, toggleServiceAutoFill);
router.get("/service-post/previous-data", verifyJWT, getPreviousServicePostData);

// Product post preferences routes
router.put("/product-post/toggle-autofill", verifyJWT, toggleProductAutoFill);
router.get("/product-post/previous-data", verifyJWT, getPreviousProductPostData);

// FCM token route (optional auth - saves token if authenticated, returns helpful message if not)
router.post("/fcm-token", optionalVerifyJWT, saveFCMToken);

// Firebase configuration status (for debugging)
router.get("/firebase-status", checkFirebaseStatus);

// Test FCM notification route
router.post("/test-fcm", verifyJWT, testFCMNotification);

export default router;