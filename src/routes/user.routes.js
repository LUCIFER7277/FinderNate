import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { loginUser, logOutUser, registerUser, verifyAndRegisterUser, getUserProfile, updateUserProfile, changePassword, deleteAccount, searchUsers, verifyEmailWithOTP, uploadProfileImage, sendVerificationOTPForEmail, sendPasswordResetOTP, resetPasswordWithOTP } from "../controllers/user.controllers.js";
import { getHomeFeed } from '../controllers/homeFeed.controllers.js';

const router = Router();

router.route("/register").post(registerUser);
router.route("/register/verify").post(verifyAndRegisterUser);
router.route("/login").post(loginUser);
router.route("/logout").post(verifyJWT, logOutUser);
router.route("/profile").get(verifyJWT, getUserProfile);
router.route("/profile").put(verifyJWT, updateUserProfile);
router.route("/profile/change-password").put(verifyJWT, changePassword);
router.route("/profile").delete(verifyJWT, deleteAccount);
router.route("/profile/search").get(verifyJWT, searchUsers);
router.route("/verify-email-otp").post(verifyEmailWithOTP);
router.route("/send-verification-otp").post(sendVerificationOTPForEmail);
router.route("/profile/upload-image").post(verifyJWT, upload.single("profileImage"), uploadProfileImage);
router.route("/send-reset-otp").post(sendPasswordResetOTP);
router.route("/reset-password").post(resetPasswordWithOTP);

export default router;