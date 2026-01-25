import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    sendContactRequest,
    getRequestStatus,
    getBusinessRequests,
    respondToRequest
} from "../controllers/contactRequest.controllers.js";

const router = Router();

// All routes require authentication
router.use(verifyJWT);

// POST /api/v1/contact-requests/:businessId - Send new contact request
router.route("/:businessId").post(sendContactRequest);

// GET /api/v1/contact-requests/status/:businessId - Get my request status for a business
router.route("/status/:businessId").get(getRequestStatus);

// GET /api/v1/contact-requests/business/:businessId - Business owner views incoming requests
router.route("/business/:businessId").get(getBusinessRequests);

// PATCH /api/v1/contact-requests/:requestId/respond - Business owner responds to request
router.route("/:requestId/respond").patch(respondToRequest);

export default router;