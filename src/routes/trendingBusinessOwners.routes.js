import { Router } from "express";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { getTrendingBusinessOwners } from "../controllers/trendingBusinessOwners.controllers.js";

const router = Router();

// Get trending business profiles
router.get("/trending-business-owners", getBlockedUsersMiddleware, getTrendingBusinessOwners); // Removed verifyJWT for testing

export default router;  