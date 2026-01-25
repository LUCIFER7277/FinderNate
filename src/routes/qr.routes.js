import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    getStyledQRCode,
    getMyQRCode,
    shareQRCode,
    shareMyQRCode,
    shareQRForChat,
    shareMyQRForChat
} from "../controllers/qr.controllers.js";

const router = Router();

// Public QR routes - No authentication required
router.get("/share/:username", shareQRCode);
router.get("/chat/:username", shareQRForChat);
router.get("/:username", getStyledQRCode);

// Authenticated QR routes (require login to know whose QR to generate)
router.get("/my-qr", verifyJWT, getMyQRCode);
router.get("/share/my-qr", verifyJWT, shareMyQRCode);
router.get("/chat/my-qr", verifyJWT, shareMyQRForChat);

export default router;