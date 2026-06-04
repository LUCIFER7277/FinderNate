import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyAdminJWT } from "../middlewares/adminAuth.middleware.js";
import {
    submitFeedback,
    getAllFeedback,
    deleteFeedback
} from "../controllers/feedback.controllers.js";

const router = Router();

// ========== USER ROUTES ==========

// Submit feedback (authenticated users only)
router.post("/submit", verifyJWT, submitFeedback);

// ========== ADMIN ROUTES ==========

// Get all feedback (admin only)
router.get("/admin/all", verifyAdminJWT, getAllFeedback);

// Delete feedback (admin only)
router.delete("/admin/:feedbackId", verifyAdminJWT, deleteFeedback);

export default router;