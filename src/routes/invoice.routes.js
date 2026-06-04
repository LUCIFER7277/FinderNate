import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    getInvoice,
    getInvoiceByOrderNumber,
    getUserInvoices,
} from "../controllers/invoice.controllers.js";

const router = Router();

router.use(verifyJWT);

// Get all invoices for the authenticated user
router.get("/", getUserInvoices);

// Get invoice by order reference number
router.get("/ref/:orderNumber", getInvoiceByOrderNumber);

// Get invoice for a specific order
router.get("/:orderId", getInvoice);

export default router;
