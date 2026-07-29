import os from 'os';
import mongoose from 'mongoose';
import DiagnosticLog from '../models/diagnosticLog.models.js';

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * Writes the SERVER's own failures into the same store the app and the website
 * upload to, so one lookup shows all three tiers of a problem instead of three
 * places to go looking. Correlated by requestId (the X-Request-Id the server
 * hands out and the clients log back).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Everything below is written against one hazard: this code runs on the error
 * path, so its own failure lands on top of an existing failure. Four specific
 * ways that becomes an outage, and what stops each:
 *
 *  1. THE PROCESS KILLER. src/index.js exits(1) on any unhandledRejection
 *     whose code is not ECONNRESET/ENOTFOUND. A MongooseError has no such
 *     code, so ONE floating rejected write takes down the worker — and with
 *     several instances behind a load balancer, a database wobble becomes a
 *     rolling crash-loop across the fleet. Every promise here therefore ends
 *     in a terminal .catch() that swallows.
 *
 *  2. LOGGING A DATABASE OUTAGE TO THE DATABASE. The connection sets
 *     bufferCommands: false, so during an outage writes reject instantly
 *     rather than queueing: the failure most worth recording is exactly the
 *     one that cannot be recorded, once per request, forever. readyState is
 *     checked first and the breaker latches the rest off.
 *
 *  3. THE STORM. This runs once per failed request. A bad deploy that 500s
 *     everything turns into one insert per failure against a primary that is
 *     already unwell — diagnostics amplifying the incident it exists to
 *     explain. Hence the per-minute ceiling, which counts what it drops.
 *
 *  4. AWAITING ANYTHING ON THE RESPONSE PATH. Express 4 does not await error
 *     handlers, and a user waiting on a page should never wait on telemetry.
 *     Nothing here is awaited by the caller; it is called from res 'finish',
 *     after the response is already flushed.
 * ─────────────────────────────────────────────────────────────────────────
 */

const enabled = () => process.env.DIAGNOSTICS_INGEST_ENABLED !== 'false';

/** Which instance produced the row. Server rows have no device, and knowing
 *  WHICH instance served a request is what makes a one-instance fault legible
 *  rather than an intermittent mystery. */
const INSTANCE_ID = `server:${os.hostname()}:${process.pid}`;

// ── Circuit breaker ────────────────────────────────────────────────────────
// Opens on the first write failure and stays open for a cooldown. Without it,
// a database outage means every subsequent failed request retries the write
// and fails again, turning one fault into a per-request tax.
const BREAKER_COOLDOWN_MS = 60 * 1000;
let breakerOpenUntil = 0;

// ── Rate ceiling ───────────────────────────────────────────────────────────
// Per process, deliberately. A shared counter would need Redis on the error
// path, which is another dependency that can be the thing that is broken.
// This bounds each process; the fleet-wide ceiling is this times the instance
// count, which is the honest way to read it.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.DIAG_SERVER_MAX_PER_MIN || 120);
let windowStart = 0;
let writtenInWindow = 0;
let droppedInWindow = 0;

/** Never capture our own ingest endpoint: a failure there would be recorded by
 *  a write through the same collection, which is how a loop starts.
 *
 *  Matched against originalUrl, NOT req.path. Express trims req.url on entry
 *  to a mounted router and restores it only inside next(), so by the time the
 *  finish hook runs, the ingest route — registered as "/" within the
 *  diagnostics router — reads as req.path === "/" and would slip straight past
 *  a req.path check. The guard against the loop would have been the thing that
 *  never fired. */
const isSelf = (req) => {
    const url = (req?.originalUrl || '').split('?')[0];
    return url.startsWith('/api/v1/diagnostics');
};

const withinRate = () => {
    const now = Date.now();
    if (now - windowStart > WINDOW_MS) {
        // Report what the previous window hid. A silent cap reads as "nothing
        // else went wrong", which is the opposite of the truth.
        if (droppedInWindow > 0) {
            console.warn(`[diag] rate ceiling dropped ${droppedInWindow} server event(s) in the last minute`);
        }
        windowStart = now;
        writtenInWindow = 0;
        droppedInWindow = 0;
    }
    if (writtenInWindow >= MAX_PER_WINDOW) {
        droppedInWindow++;
        return false;
    }
    writtenInWindow++;
    return true;
};

/**
 * Record one server-side failure. Fire-and-forget by design — the caller must
 * NOT await this, and it never throws.
 */
export const captureServerEvent = ({ req, statusCode, ms, err }) => {
    try {
        if (!enabled()) return;
        if (isSelf(req)) return;
        if (Date.now() < breakerOpenUntil) return;

        // Cheap synchronous precondition. Necessary but not sufficient — the
        // socket can still drop between here and the write, which is why the
        // terminal catch below is not optional.
        if (mongoose.connection?.readyState !== 1) return;

        if (!withinRate()) return;

        const level = statusCode >= 500 ? 'ERROR' : 'WARN';
        const entry = {
            ts: new Date(),
            level,
            tag: statusCode >= 500 ? 'server.err' : 'server.fail',
            message: `${req.method} ${req.originalUrl} → ${statusCode}`
                + (err ? `  ${err.name}: ${err.message}` : ''),
            data: {
                status: String(statusCode),
                method: String(req.method || ''),
                path: String(req.originalUrl || '').slice(0, 500),
                ms: String(ms ?? ''),
                // The stack is the whole reason a server row is worth more
                // than the client's "it failed". Bounded so one deep async
                // trace cannot dominate the document.
                ...(err?.stack ? { stack: String(err.stack).slice(0, 4000) } : {}),
            },
        };

        DiagnosticLog.create({
            deviceId: INSTANCE_ID,
            userId: req.user?._id || null,
            source: 'server',
            requestId: req.id || null,
            platform: `node ${process.version}`,
            entries: [entry],
            entryCount: 1,
        }).catch((writeErr) => {
            // Terminal. Nothing may escape from here — see hazard 1 above.
            breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
            console.warn(`[diag] server capture write failed, pausing ${BREAKER_COOLDOWN_MS / 1000}s: ${writeErr?.message}`);
        });
    } catch (e) {
        // Synchronous failure (a malformed req, a model that failed to load).
        // Diagnostics must never be the reason a request handler breaks.
        try {
            console.warn(`[diag] server capture skipped: ${e?.message}`);
        } catch { /* console itself is gone; there is nothing left to do */ }
    }
};

/** Close the breaker as soon as the database is back, rather than waiting out
 *  a cooldown that is already irrelevant. */
mongoose.connection?.on?.('reconnected', () => {
    breakerOpenUntil = 0;
});
