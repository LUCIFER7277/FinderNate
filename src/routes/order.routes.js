import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import {
    getOrderDetails,
    getBuyerOrders,
    getSellerOrders,
    getSellerNewOrdersCount,
    sellerConfirmOrder,
    sellerRejectOrder,
    markOrderShipped,
    markOrderDelivered,
    updateTrackingInfo,
    confirmDelivery,
    reportIssue,
    uploadDisputeVideo,
    uploadPaymentProof,
    uploadPackingMedia,
    uploadOpeningVideo,
    rateBuyer,
    rateSeller,
    getBuyerOrderHistory,
    getSellerOrderHistory,
    getBuyerOrderStatistics,
    getSellerOrderStatistics,
    exportOrdersToCSV,
    getUserReviews
} from "../controllers/orders.controllers.js";

const router = Router();

// Public routes (no auth required)
router.get("/user/:userId/reviews", optionalVerifyJWT, getUserReviews);

router.use(verifyJWT);

// Order statistics (must come before generic /buyer and /seller routes)
router.get("/buyer/statistics", getBuyerOrderStatistics);
router.get("/seller/statistics", getSellerOrderStatistics);
router.get("/seller/new-count", getSellerNewOrdersCount);

// Enhanced order history with advanced filtering
router.get("/buyer/history", getBuyerOrderHistory);
router.get("/seller/history", getSellerOrderHistory);

// Export orders
router.get("/export", exportOrdersToCSV);

// Get orders (basic - kept for backward compatibility)
router.get("/buyer", getBuyerOrders);
router.get("/seller", getSellerOrders);

// Get specific order details
router.get("/:orderId", getOrderDetails);

// Seller actions
router.patch("/:orderId/seller-confirm", sellerConfirmOrder);
router.patch("/:orderId/seller-reject", sellerRejectOrder);
router.patch("/:orderId/ship", markOrderShipped);
router.patch("/:orderId/deliver", markOrderDelivered);
router.patch("/:orderId/tracking", updateTrackingInfo);
router.post("/:orderId/packing-media", uploadPackingMedia);
router.post("/:orderId/rate-buyer", rateBuyer);

// Buyer actions
router.patch("/:orderId/confirm", confirmDelivery);
router.post("/:orderId/rate-seller", rateSeller);
router.post("/:orderId/report", reportIssue);
router.post("/:orderId/dispute-video", uploadDisputeVideo);
router.post("/:orderId/payment-proof", uploadPaymentProof);
router.post("/:orderId/opening-video", uploadOpeningVideo);

export default router;
