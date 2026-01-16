import { Router } from "express";
import { optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { getSuggestedForYou } from "../controllers/suggestedForYou.controllers.js";

const router = Router();

// Get suggested for you (all suggestions combined)
router.get("/suggested-for-you", optionalVerifyJWT, getBlockedUsersMiddleware, getSuggestedForYou);

export default router; 