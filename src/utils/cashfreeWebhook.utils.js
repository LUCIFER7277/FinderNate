import { verifyCashfreeWebhook } from "../config/cashfree.config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Cashfree S2S webhook authentication.
//
// Every payment webhook route is unauthenticated by design — Cashfree sends no
// JWT. The signature IS the authentication, so it is mandatory: a request that
// simply omits the headers must be rejected, not waved through.
//
// Cashfree v2023-08-01 signs each delivery with
//   x-webhook-signature: base64(HMAC-SHA256(timestamp + rawBody, clientSecret))
//   x-webhook-timestamp: unix seconds
//
// The HMAC is computed over the EXACT bytes Cashfree sent, so it can only be
// verified against the raw body. app.js captures it via
// express.json({ verify: ... }) into req.rawBody; if that ever stops happening
// no signature can be verified and we fail closed rather than trusting the
// payload.
// ─────────────────────────────────────────────────────────────────────────────

// Replay window. A capture older than this is rejected even if the signature is
// genuine, so a recorded "order PAID" delivery cannot be replayed later.
const REPLAY_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Cashfree webhook request.
 * @returns {{ ok: boolean, reason?: string }}
 */
export const verifyCashfreeWebhookRequest = (req) => {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    if (!timestamp || !signature) {
        return { ok: false, reason: 'Missing x-webhook-timestamp / x-webhook-signature header' };
    }

    if (typeof req.rawBody !== 'string' || req.rawBody.length === 0) {
        return { ok: false, reason: 'Raw request body unavailable - cannot verify signature' };
    }

    const rawTimestamp = Number(timestamp);
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
        return { ok: false, reason: 'Malformed x-webhook-timestamp' };
    }

    // Cashfree sends epoch seconds; tolerate a millisecond value so a gateway
    // change of units cannot start rejecting every genuine delivery. The
    // signature itself is always computed over the header string as sent.
    const timestampSec = rawTimestamp > 1e12 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;

    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - timestampSec);
    if (ageSec > REPLAY_TOLERANCE_SECONDS) {
        return { ok: false, reason: `Webhook timestamp is ${ageSec}s old - outside the ${REPLAY_TOLERANCE_SECONDS}s replay window` };
    }

    if (!verifyCashfreeWebhook(String(timestamp), String(signature), req.rawBody)) {
        return { ok: false, reason: 'Signature mismatch' };
    }

    return { ok: true };
};

/**
 * Guard for webhook handlers. Responds 401 and returns false when the request
 * is not a genuine, fresh Cashfree delivery; returns true when it is safe to
 * process the payload.
 *
 *   if (!requireCashfreeWebhookSignature(req, res, '[Cashfree webhook]')) return;
 */
export const requireCashfreeWebhookSignature = (req, res, label = '[Cashfree webhook]') => {
    const result = verifyCashfreeWebhookRequest(req);
    if (!result.ok) {
        console.error(`${label} Rejected unauthenticated webhook: ${result.reason}`);
        res.status(401).json({ status: 'unauthorized' });
        return false;
    }
    return true;
};

export default requireCashfreeWebhookSignature;
