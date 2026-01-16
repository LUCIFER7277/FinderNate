import { Router } from "express";
import {
    // Authentication
    adminLogin,
    adminLogout,

    // Aadhaar Verification
    getPendingAadhaarVerifications,
    verifyAadhaarCard,
    getAadhaarVerificationHistory,

    // Report Management
    getAllReports,
    updateReportStatus,
    deleteReport,

    // User Management
    getAllUsers,
    updateUserStatus,
    verifyBlueTick,

    // Business Management
    getAllBusinesses,
    getPendingBusinessVerifications,
    verifyBusinessAccount,
    getBusinessVerificationDetails,
    getBusinessVerificationHistory,
    verifyBusinessDocument,

    // Analytics & Dashboard
    getDashboardStats,
    getAdminActivityLog,

    // Super Admin Functions
    createAdmin,
    getAllAdmins,
    updateAdminPermissions
} from "../controllers/admin.controllers.js";

import {
    verifyAdminJWT,
    requirePermission
} from "../middlewares/adminAuth.middleware.js";

const router = Router();

// ===============================
// PUBLIC ROUTES (NO AUTH REQUIRED)
// ===============================
router.route("/login").post(adminLogin);

// ===============================
// PROTECTED ROUTES (AUTH REQUIRED)
// ===============================
router.use(verifyAdminJWT); // Apply admin auth to all routes below

// Authentication
router.route("/logout").post(adminLogout);

// Dashboard & Analytics
router.route("/dashboard/stats").get(requirePermission('viewAnalytics'), getDashboardStats);
router.route("/activity-log").get(getAdminActivityLog);

// ===============================
// AADHAAR VERIFICATION ROUTES
// ===============================
router.route("/aadhaar-verification/pending").get(
    requirePermission('verifyAadhaar'),
    getPendingAadhaarVerifications
);

router.route("/aadhaar-verification/verify/:businessId").post(
    requirePermission('verifyAadhaar'),
    verifyAadhaarCard
);

router.route("/aadhaar-verification/history").get(
    requirePermission('verifyAadhaar'),
    getAadhaarVerificationHistory
);

// ===============================
// REPORT MANAGEMENT ROUTES
// ===============================
router.route("/reports").get(
    requirePermission('manageReports'),
    getAllReports
);

router.route("/reports/:reportId/status").put(
    requirePermission('manageReports'),
    updateReportStatus
);

router.route("/reports/:reportId").delete(
    requirePermission('manageReports'),
    deleteReport
);

// ===============================
// USER MANAGEMENT ROUTES
// ===============================
router.route("/users").get(
    requirePermission('manageUsers'),
    getAllUsers
);

router.route("/users/:userId/status").put(
    requirePermission('manageUsers'),
    updateUserStatus
);

router.route("/users/:userId/blue-tick").put(
    requirePermission('manageUsers'),
    verifyBlueTick
);

// ===============================
// BUSINESS MANAGEMENT ROUTES
// ===============================
router.route("/businesses").get(
    requirePermission('manageBusiness'),
    getAllBusinesses
);

router.route("/businesses/pending-verification").get(
    requirePermission('manageBusiness'),
    getPendingBusinessVerifications
);

router.route("/businesses/:businessId/verify").post(
    requirePermission('manageBusiness'),
    verifyBusinessAccount
);

router.route("/businesses/:businessId/details").get(
    requirePermission('manageBusiness'),
    getBusinessVerificationDetails
);

router.route("/businesses/verification-history").get(
    requirePermission('manageBusiness'),
    getBusinessVerificationHistory
);

router.route("/businesses/:businessId/documents/:documentId/verify").post(
    requirePermission('manageBusiness'),
    verifyBusinessDocument
);

// ===============================
// ADMIN MANAGEMENT ROUTES
// ===============================
router.route("/create-admin").post(createAdmin);
router.route("/all-admins").get(getAllAdmins);
router.route("/:adminId/permissions").put(updateAdminPermissions);

export default router;
