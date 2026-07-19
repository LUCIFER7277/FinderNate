import { Router } from "express";
import { optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { ingestDiagnostics } from "../controllers/diagnostics.controllers.js";

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * optionalVerifyJWT: logs from logged-out sessions (onboarding, sign-in bugs)
 * are accepted too; when the app IS logged in, req.user links the batch to the
 * user for easier debugging.
 */
const router = Router();

router.post("/", optionalVerifyJWT, ingestDiagnostics);

export default router;
