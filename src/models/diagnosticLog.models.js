import mongoose from 'mongoose';

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * Stores diagnostic log batches uploaded by the mobile app (and optionally the
 * web frontend) while Findernate is in testing. Retention is handled entirely
 * by MongoDB: the TTL index below auto-deletes every document
 * DIAG_RETENTION_DAYS after creation — no cron/cleanup job needed.
 */

export const DIAG_RETENTION_DAYS = 30;

const diagnosticEntrySchema = new mongoose.Schema(
    {
        ts: { type: Date },              // client-side timestamp of the log line
        level: { type: String },         // DEBUG | INFO | WARN | ERROR
        tag: { type: String },           // e.g. net.err, location.fix, switch
        message: { type: String },
        data: { type: mongoose.Schema.Types.Mixed }, // small structured context
    },
    { _id: false }
);

const diagnosticLogSchema = new mongoose.Schema(
    {
        deviceId: { type: String, required: true, index: true }, // random app-install UUID (not a hardware id)
        sessionId: { type: String, index: true },                // one UUID per app launch
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
        // 'server' records are written by the backend itself. Without it here
        // the enum rejects them outright, and the three tiers stay three
        // separate piles: the app's symptom, the browser's symptom, and the
        // stack that caused both, none of them reachable from the others.
        source: { type: String, enum: ['app', 'web', 'server'], default: 'app' },
        // The thread between tiers. Set from the X-Request-Id header: the
        // server assigns it, returns it on the response, and the clients log
        // the one they were given when a call failed. One id then pulls up the
        // user's tap, the browser error and the server stack as one story.
        requestId: { type: String, default: null },
        appVersion: { type: String },
        platform: { type: String },      // android / ios / web + OS version
        entries: { type: [diagnosticEntrySchema], default: [] },
        entryCount: { type: Number, default: 0 },
        createdAt: {
            type: Date,
            default: Date.now,
            // TTL: MongoDB deletes the document this many seconds after createdAt.
            expires: 60 * 60 * 24 * DIAG_RETENTION_DAYS,
        },
    },
    { versionKey: false }
);

// Fast "all batches for one device, newest first" retrieval when diagnosing.
diagnosticLogSchema.index({ deviceId: 1, createdAt: -1 });

// The correlation lookup — "show me every tier's record of this one request".
// Sparse because only failed client calls and server-tier rows carry an id;
// the majority of app batches have none and do not belong in this index.
diagnosticLogSchema.index({ requestId: 1 }, { sparse: true });

// The default view when opening the log: newest first, optionally narrowed to
// one tier. Without this, "what broke in the last hour" is a collection scan.
diagnosticLogSchema.index({ source: 1, createdAt: -1 });

const DiagnosticLog = mongoose.model('DiagnosticLog', diagnosticLogSchema);
export default DiagnosticLog;
