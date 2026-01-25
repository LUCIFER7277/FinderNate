import express from "express";
import { getSuggestedReels } from "../controllers/reel.controllers.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { optionalVerifyJWT } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Get suggested reels with comprehensive data and filtering options
router.get("/suggested", optionalVerifyJWT, getBlockedUsersMiddleware, getSuggestedReels);

export default router;