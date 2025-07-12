import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { loginUser, logOutUser, registerUser, verifyAndRegisterUser, getUserProfile, updateUserProfile, changePassword, deleteAccount, searchUsers, verifyEmailWithOTP, sendVerificationOTP, uploadProfileImage } from "../controllers/user.controllers.js";

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
router.route("/send-verification-otp").post(sendVerificationOTP);
router.route("/profile/upload-image").post(verifyJWT, upload.single("profileImage"), uploadProfileImage);
export default router;