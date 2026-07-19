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
        source: { type: String, enum: ['app', 'web'], default: 'app' },
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

const DiagnosticLog = mongoose.model('DiagnosticLog', diagnosticLogSchema);
export default DiagnosticLog;
