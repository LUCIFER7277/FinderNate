import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    getOrderDetails,
    getBuyerOrders,
    getSellerOrders,
    markOrderShipped,
    markOrderDelivered,
    confirmDelivery,
    reportIssue,
    uploadPaymentProof,
    uploadPackingMedia,
    uploadOpeningVideo,
    rateBuyer,
    getBuyerOrderHistory,
    getSellerOrderHistory,
    getBuyerOrderStatistics,
    getSellerOrderStatistics,
    exportOrdersToCSV
} from "../controllers/orders.controllers.js";

const router = Router();

router.use(verifyJWT);

// Order statistics (must come before generic /buyer and /seller routes)
router.get("/buyer/statistics", getBuyerOrderStatistics);
router.get("/seller/statistics", getSellerOrderStatistics);

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
router.patch("/:orderId/ship", markOrderShipped);
router.patch("/:orderId/deliver", markOrderDelivered);
router.post("/:orderId/packing-media", uploadPackingMedia);
router.post("/:orderId/rate-buyer", rateBuyer);

// Buyer actions
router.patch("/:orderId/confirm", confirmDelivery);
router.post("/:orderId/report", reportIssue);
router.post("/:orderId/payment-proof", uploadPaymentProof);
router.post("/:orderId/opening-video", uploadOpeningVideo);

export default router;
