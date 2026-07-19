import DiagnosticLog from '../models/diagnosticLog.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * Ingests diagnostic log batches from the mobile app / web frontend during the
 * testing phase. Storage is auto-pruned to the last 30 days by the TTL index on
 * the model — nothing else to maintain.
 *
 * KILL SWITCH: set env DIAGNOSTICS_INGEST_ENABLED=false and this endpoint
 * answers 503 without touching the database; clients back off quietly.
 */

// Hard caps so a misbehaving client can't flood the server/DB.
const MAX_ENTRIES_PER_BATCH = 500;
const MAX_MESSAGE_LEN = 2000;
const MAX_TAG_LEN = 64;

const ingestEnabled = () => process.env.DIAGNOSTICS_INGEST_ENABLED !== 'false';

// Server-side redaction backstop (the app also redacts before writing to disk).
const BEARER_RX = /(bearer\s+)[A-Za-z0-9\-_.=]+/gi;
const JWT_RX = /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g;
const redact = (s) =>
    typeof s === 'string'
        ? s.replace(BEARER_RX, '$1***').replace(JWT_RX, '***jwt***')
        : s;

// Safely normalise one entry's `data` field. NEVER throws: an oversized or
// unserialisable value can't fail the whole batch (which would 500 the request
// and make the client retry the same poisoned batch forever). We drop `data`
// rather than slice the JSON string mid-object (which would corrupt it).
const safeData = (v) => {
    try {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
        const raw = JSON.stringify(v);
        if (raw.length > 4000) return { _truncated: raw.length };
        return JSON.parse(redact(raw));
    } catch {
        return undefined;
    }
};

// POST /api/v1/diagnostics
// Body: { deviceId, sessionId?, source?, appVersion?, platform?, entries: [{ts, level, tag, message, data?}] }
export const ingestDiagnostics = asyncHandler(async (req, res) => {
    if (!ingestEnabled()) {
        // 503 tells clients "temporarily off" — the app keeps logs on-device only.
        throw new ApiError(503, 'Diagnostics ingestion is disabled');
    }

    const { deviceId, sessionId, source, appVersion, platform, entries } = req.body || {};

    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 100) {
        throw new ApiError(400, 'deviceId is required');
    }
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new ApiError(400, 'entries array is required');
    }
    if (entries.length > MAX_ENTRIES_PER_BATCH) {
        throw new ApiError(413, `Too many entries in one batch (max ${MAX_ENTRIES_PER_BATCH})`);
    }

    const cleaned = entries.map((e) => ({
        ts: e?.ts ? new Date(e.ts) : new Date(),
        level: String(e?.level || 'INFO').slice(0, 8),
        tag: String(e?.tag || '').slice(0, MAX_TAG_LEN),
        message: redact(String(e?.message || '').slice(0, MAX_MESSAGE_LEN)),
        // Only keep small, plain-object context; oversized/unserialisable is
        // dropped safely (never throws — see safeData).
        data: safeData(e?.data),
    }));

    await DiagnosticLog.create({
        deviceId,
        sessionId: sessionId ? String(sessionId).slice(0, 100) : undefined,
        userId: req.user?._id || null, // present when the app sent its JWT (optionalVerifyJWT)
        source: source === 'web' ? 'web' : 'app',
        appVersion: appVersion ? String(appVersion).slice(0, 40) : undefined,
        platform: platform ? String(platform).slice(0, 120) : undefined,
        entries: cleaned,
        entryCount: cleaned.length,
    });

    return res
        .status(201)
        .json(new ApiResponse(201, { stored: cleaned.length }, 'Diagnostics stored'));
});
