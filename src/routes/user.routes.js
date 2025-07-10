import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { loginUser, logOutUser, registerUser, getUserProfile, updateUserProfile, changePassword, deleteAccount, searchUsers, verifyEmailwithToken, sendVerificationEmailWithToken, verifyEmailWithOTP, sendVerificationOTP } from "../controllers/user.controllers.js";

const router = Router();

router.route("/register").post(registerUser);
router.route("/login").post(loginUser);
router.route("/logout").post(verifyJWT, logOutUser);
router.route("/profile").get(verifyJWT, getUserProfile);
router.route("/profile").put(verifyJWT, updateUserProfile);
router.route("/profile/change-password").put(verifyJWT, changePassword);
router.route("/profile").delete(verifyJWT, deleteAccount);
router.route("/profile/search").get(verifyJWT, searchUsers);
router.route("/verify-email-token").get(verifyEmailwithToken);
router.route("/send-verification-email-token").post(sendVerificationEmailWithToken);
router.route("/verify-email-otp").post(verifyEmailWithOTP);
router.route("/send-verification-otp").post(sendVerificationOTP);

export default router;