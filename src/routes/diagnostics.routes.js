import { Router } from "express";
import { optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { diagnosticsRateLimit } from "../middlewares/rateLimiter.middleware.js";
import { ingestDiagnostics } from "../controllers/diagnostics.controllers.js";

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * diagnosticsRateLimit: tight per-IP cap so an unauthenticated flood can't fill
 * the DB before the 30-day TTL prunes it.
 * optionalVerifyJWT: logs from logged-out sessions (onboarding, sign-in bugs)
 * are accepted too; when the app IS logged in, req.user links the batch to the
 * user for easier debugging.
 */
const router = Router();

router.post("/", diagnosticsRateLimit, optionalVerifyJWT, ingestDiagnostics);

export default router;
