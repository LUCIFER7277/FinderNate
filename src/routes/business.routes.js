import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multerConfig.js";
import {
    switchTobusinessprofile,
    switchToPersonalAccount,
    createBusinessProfile,
    deleteBusinessProfile,
    selectBusinessPlan,
    getBusinessProfile,
    updateBusinessProfile,
    getBusinessById,
    getMyBusinessCategory,
    updateExistingActiveBusinesses,
    updateLiveLocation,
    toggleLiveLocation,
    getNearbyBusinesses,
    updateBusinessCategory,
    getBusinessCategories,
    rateBusiness,
    getBusinessRatingSummary,
    toggleProductPosts,
    toggleServicePosts,
    uploadVerificationDocument
} from "../controllers/business.controllers.js";

const router = Router();

// Switch to business profile (checks if business exists or needs registration)
router.route("/switch-to-business").post(optionalVerifyJWT, switchTobusinessprofile);

// Switch to personal account from business account
router.route("/switch-to-personal").post(optionalVerifyJWT, switchToPersonalAccount);

// Create business profile
router.route("/create").post(optionalVerifyJWT, createBusinessProfile);

// Delete business profile
router.route("/delete").delete(optionalVerifyJWT, deleteBusinessProfile);

// Select business plan
router.route("/select-plan").post(optionalVerifyJWT, selectBusinessPlan);

// Get authenticated user's business profile
router.route("/profile").get(optionalVerifyJWT, getBusinessProfile);

// Update business profile (any plan can update)
router.route("/update").patch(verifyJWT, updateBusinessProfile);

// Update business category specifically (any plan can update)
router.route("/update-category").patch(verifyJWT, updateBusinessCategory);

// Get all available business categories (public access)
router.route("/categories").get(getBusinessCategories);

// Get my business category (auth required) - Must be before /:id route
router.route("/my-category").get(optionalVerifyJWT, getMyBusinessCategory);

// 📍 Live location endpoints
router.route("/live-location").patch(verifyJWT, updateLiveLocation);
router.route("/toggle-live-location").post(verifyJWT, toggleLiveLocation);
router.route("/nearby").get(getNearbyBusinesses);

// Get business by ID (public access)
router.route("/:id").get(getBusinessById);

// 📊 Business Rating Routes
router.route("/:businessId/rate").post(verifyJWT, rateBusiness);
router.route("/:businessId/rating-summary").get(getBusinessRatingSummary);

// 📝 Post Settings Routes
router.route("/toggle-product-posts").post(verifyJWT, toggleProductPosts);
router.route("/toggle-service-posts").post(verifyJWT, toggleServicePosts);

// 📄 Document Upload Routes
// Single API: Upload file + Attach to business + Appears in admin panel
router.route("/upload-document").post(verifyJWT, upload.single("document"), uploadVerificationDocument);

// Helper route to update existing businesses with active subscriptions (admin only)
router.route("/admin/update-active-businesses").post(optionalVerifyJWT, updateExistingActiveBusinesses);

export default router; 