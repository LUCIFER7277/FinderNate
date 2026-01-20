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
    rateBuyer
} from "../controllers/orders.controllers.js";

const router = Router();

router.use(verifyJWT);

// Get orders
router.get("/buyer", getBuyerOrders);
router.get("/seller", getSellerOrders);
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
