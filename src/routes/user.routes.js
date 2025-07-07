import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { loginUser, logOutUser, registerUser } from "../controllers/user.controllers.js";

const router = Router();

router.route("/register").post(registerUser);
router.route("/login").post(loginUser);
router.route("/logout").post(verifyJWT, logOutUser);
export default router;