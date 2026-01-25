import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { generalRateLimit } from "../middlewares/rateLimiter.middleware.js";
import {
  generatePostShareLink,
  generateReelShareLink,
  getSharedPost,
  getSharedReel,
  getPostPreviewPage,
  getReelPreviewPage,
  trackShare,
} from "../controllers/share.controllers.js";

const router = Router();

// ===============================
// PUBLIC ROUTES (GUEST-FRIENDLY)
// ===============================

// Get shared post (guest-friendly with optional auth)
router.get("/post/:postId", optionalVerifyJWT, generalRateLimit, getSharedPost);

// Get shared reel (guest-friendly with optional auth)
router.get("/reel/:postId", optionalVerifyJWT, generalRateLimit, getSharedReel);

// Preview pages with Open Graph meta tags (no auth required)
router.get("/post/:postId/preview", getPostPreviewPage);
router.get("/reel/:postId/preview", getReelPreviewPage);

// ===============================
// AUTHENTICATED ROUTES
// ===============================

// Generate share link for post (requires authentication)
router.post("/post/:postId/generate", verifyJWT, generalRateLimit, generatePostShareLink);

// Generate share link for reel (requires authentication)
router.post("/reel/:postId/generate", verifyJWT, generalRateLimit, generateReelShareLink);

// Track share event (requires authentication)
router.post("/track", verifyJWT, generalRateLimit, trackShare);

export default router;
