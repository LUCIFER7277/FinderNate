import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyAdminJWT } from "../middlewares/adminAuth.middleware.js";
import {
  getCurrentVersions,
  getAcceptanceStatus,
  acceptAtSignup,
  acceptDocument,
  acceptSellerOnboarding,
  getAcceptanceHistory,
  adminGetVersions,
  adminUpdateVersion,
  adminGetUserAcceptanceHistory,
} from "../controllers/legal.controllers.js";

const router = Router();

// Public — get current versions (used by frontend before login)
router.get("/versions", getCurrentVersions);

// Authenticated — user acceptance
router.get("/status",        verifyJWT, getAcceptanceStatus);
router.post("/accept/signup",  verifyJWT, acceptAtSignup);
router.post("/accept/:docType", verifyJWT, acceptDocument);
router.post("/accept-seller-onboarding", verifyJWT, acceptSellerOnboarding);
router.get("/history",        verifyJWT, getAcceptanceHistory);

// Admin
router.get("/admin/versions",             verifyJWT, verifyAdminJWT, adminGetVersions);
router.post("/admin/versions",            verifyJWT, verifyAdminJWT, adminUpdateVersion);
router.get("/admin/history/:userId",      verifyJWT, verifyAdminJWT, adminGetUserAcceptanceHistory);

export default router;
