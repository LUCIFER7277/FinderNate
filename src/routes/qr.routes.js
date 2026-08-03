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

// Authenticated QR routes (require login to know whose QR to generate).
//
// These MUST stay above the parameterised routes below. Express matches in
// declaration order, so with /:username registered first every one of these was
// swallowed — GET /qr/my-qr matched /:username with username='my-qr' (which
// passes isValidUsername) and 404'd with "User not found". Worse, 'my-qr' is a
// registerable username, so anyone signing up under it would have started
// serving THEIR profile QR to every user opening their own "My QR" screen.
router.get("/my-qr", verifyJWT, getMyQRCode);
router.get("/share/my-qr", verifyJWT, shareMyQRCode);
router.get("/chat/my-qr", verifyJWT, shareMyQRForChat);

// Public QR routes - No authentication required
router.get("/share/:username", shareQRCode);
router.get("/chat/:username", shareQRForChat);
router.get("/:username", getStyledQRCode);

export default router;