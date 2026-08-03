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
    deleteUser,

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
    getEscrowDashboard,
    getEscrowTransactions,
    getAllOrders,
    getDisputedOrders,
    getRejectedOrders,
    resolveDispute,
    manualReleasePayment,
    manualRefundPayment,
    getOrderAnalytics,
    manualConfirmPayment,
    getSellerBankDetailsByOrder
} from "../controllers/adminEscrow.controllers.js";

import {
    getPaymentLogs,
    getSubscriptionLogs,
    getErrorLogs,
    getMetrics,
    testExpiryJob,
    getDashboard as getMonitoringDashboard
} from "../controllers/monitoring.controllers.js";

import {
    debugUserChats,
    cleanupProblematicChats
} from "../controllers/admin/chat.controllers.js";

import {
    addSetting,
    getSetting,
    getAllSettings,
    updateSetting
} from "../controllers/admin/settings.controllers.js";

import {
    verifyAdminJWT,
    requirePermission
} from "../middlewares/adminAuth.middleware.js";
import { requireSuperAdmin } from "../controllers/admin/superadmin.controllers.js";
// DIAGNOSTICS HOOK (removable — see DIAGNOSTICS_REMOVAL.md)
import {
    listDiagnostics,
    getRequestTrace,
    getDiagnosticsSummary
} from "../controllers/admin/diagnostics.js";

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

// DIAGNOSTICS HOOK (removable — see DIAGNOSTICS_REMOVAL.md)
// Reading back what the app, the website and the server logged. Behind
// verifyAdminJWT (applied above) because these entries carry user data.
// /request/:requestId is registered before the list route so the literal
// segment is not swallowed by a broader match.
router.route("/diagnostics/summary").get(requirePermission('viewAnalytics'), getDiagnosticsSummary);
router.route("/diagnostics/request/:requestId").get(requirePermission('viewAnalytics'), getRequestTrace);
router.route("/diagnostics").get(requirePermission('viewAnalytics'), listDiagnostics);

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

router.route("/users/:userId").delete(
    requirePermission('manageUsers'),
    deleteUser
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
// Creating admins and rewriting their permissions are super-admin only —
// these were the only routes under verifyAdminJWT with no gate at all, so any
// admin could grant itself every permission. The controllers repeat the check,
// so it holds however the handler is reached.
router.route("/create-admin").post(requireSuperAdmin, createAdmin);
router.route("/all-admins").get(getAllAdmins);
router.route("/:adminId/permissions").put(requireSuperAdmin, updateAdminPermissions);

// ===============================
// ESCROW & ORDER MANAGEMENT ROUTES
// ===============================
router.route("/escrow/dashboard").get(getEscrowDashboard);
router.route("/escrow/transactions").get(getEscrowTransactions);
router.route("/escrow/orders").get(getAllOrders);
router.route("/escrow/disputes").get(getDisputedOrders);
router.route("/escrow/rejected").get(getRejectedOrders);
router.route("/escrow/disputes/:orderId/resolve").post(resolveDispute);
router.route("/escrow/orders/:orderId/release").post(manualReleasePayment);
router.route("/escrow/orders/:orderId/refund").post(manualRefundPayment);
router.route("/escrow/orders/:orderId/confirm").post(manualConfirmPayment);
router.route("/escrow/orders/:orderId/seller-bank-details").get(getSellerBankDetailsByOrder);
router.route("/escrow/analytics").get(getOrderAnalytics);

// ===============================
// SETTINGS ROUTES (admin-only)
// ===============================
router.route("/settings").post(addSetting).get(getAllSettings);
router.route("/settings/:key").get(getSetting).put(updateSetting);

// ===============================
// CHAT MANAGEMENT ROUTES
// ===============================
router.route("/chats/debug").get(requirePermission('manageUsers'), debugUserChats);
router.route("/chats/cleanup").post(requirePermission('manageUsers'), cleanupProblematicChats);

export default router;
