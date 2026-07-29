import mongoose from 'mongoose';
import DiagnosticLog from '../../models/diagnosticLog.models.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * DIAGNOSTICS MODULE (removable — see DIAGNOSTICS_REMOVAL.md in the mobile repo).
 *
 * Reading the store back. Until now diagnostics could only be written: the
 * ingest endpoint existed, the collection filled up, and the only way to see
 * any of it was to open a MongoDB shell. Which meant that in practice nobody
 * looked, and a system built to explain failures explained nothing.
 *
 * ADMIN ONLY. Note that admin JWTs are signed with the same secret as ordinary
 * user tokens — verifyAdminJWT is what separates them, by looking the id up in
 * the admins collection. A hand-rolled jwt.verify here would authenticate every
 * logged-in user as an administrator, so these routes must stay behind that
 * middleware.
 *
 * These logs can contain personal data: whatever the app and website chose to
 * log, redacted only for bearer tokens and JWTs. Treat this endpoint as
 * carrying user data, because it does.
 */

// Entries live in an array inside a batch document, so a plain find() that
// matches a batch returns every entry in it — including the 499 unrelated ones
// either side of the error you were looking for. Filtering by level or tag
// therefore has to happen after an $unwind, which is what timeline() does.
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (raw) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
};

const parseWhen = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * GET /api/v1/admin/diagnostics/request/:requestId
 *
 * The whole point of the feature: one id, every tier. Returns the server's
 * record of a request alongside whatever the app or browser logged about the
 * same call, oldest first, so a failure reads as a sequence rather than three
 * disconnected fragments.
 */
export const getRequestTrace = asyncHandler(async (req, res) => {
    const { requestId } = req.params;

    if (!requestId || !/^[A-Za-z0-9._-]{6,64}$/.test(requestId)) {
        throw new ApiError(400, 'A valid requestId is required');
    }

    const batches = await DiagnosticLog.find({ requestId })
        .sort({ createdAt: 1 })
        .limit(MAX_LIMIT)
        .lean();

    const timeline = [];
    for (const b of batches) {
        for (const e of b.entries || []) {
            timeline.push({
                ts: e.ts,
                source: b.source,
                level: e.level,
                tag: e.tag,
                message: e.message,
                data: e.data,
                userId: b.userId,
                deviceId: b.deviceId,
                appVersion: b.appVersion,
                platform: b.platform,
            });
        }
    }

    timeline.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    return res.status(200).json(
        new ApiResponse(200, {
            requestId,
            tiers: [...new Set(batches.map((b) => b.source))],
            entryCount: timeline.length,
            timeline,
        }, timeline.length ? 'Trace found' : 'No records for that request id')
    );
});

/**
 * GET /api/v1/admin/diagnostics
 *
 * The browsing view. Filters narrow to individual ENTRIES rather than batches,
 * because "show me errors" returning a batch that merely contains one is not an
 * answer — it is 500 lines to read through.
 *
 * Query: source, level, tag, userId, deviceId, requestId, since, until, q, limit, page
 */
export const listDiagnostics = asyncHandler(async (req, res) => {
    const { source, level, tag, userId, deviceId, requestId, since, until, q } = req.query;
    const limit = clampLimit(req.query.limit);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // Narrow at the document level first so $unwind runs over as little as
    // possible — these predicates are the ones backed by indexes.
    const match = {};
    if (source) match.source = source;
    if (deviceId) match.deviceId = deviceId;
    if (requestId) match.requestId = requestId;
    if (userId) {
        if (!mongoose.isValidObjectId(userId)) throw new ApiError(400, 'Invalid userId');
        match.userId = new mongoose.Types.ObjectId(userId);
    }

    const from = parseWhen(since);
    const to = parseWhen(until);
    if (from || to) {
        match.createdAt = {};
        if (from) match.createdAt.$gte = from;
        if (to) match.createdAt.$lte = to;
    }

    // Then per-entry predicates, which can only be applied once unwound.
    const entryMatch = {};
    if (level) entryMatch['entries.level'] = String(level).toUpperCase();
    if (tag) entryMatch['entries.tag'] = tag;
    if (q) {
        // Escaped: an admin pasting a stack fragment containing regex
        // metacharacters should search for that text, not compile it.
        const safe = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        entryMatch['entries.message'] = { $regex: safe, $options: 'i' };
    }

    const pipeline = [
        { $match: match },
        { $sort: { createdAt: -1 } },
        // Bounded before the unwind so one query cannot fan a huge number of
        // batches into an unbounded number of entries.
        { $limit: 500 },
        { $unwind: '$entries' },
        ...(Object.keys(entryMatch).length ? [{ $match: entryMatch }] : []),
        { $sort: { 'entries.ts': -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
            $project: {
                _id: 0,
                ts: '$entries.ts',
                level: '$entries.level',
                tag: '$entries.tag',
                message: '$entries.message',
                data: '$entries.data',
                source: 1,
                requestId: 1,
                userId: 1,
                deviceId: 1,
                sessionId: 1,
                appVersion: 1,
                platform: 1,
            },
        },
    ];

    const entries = await DiagnosticLog.aggregate(pipeline);

    return res.status(200).json(
        new ApiResponse(200, {
            entries,
            page,
            limit,
            // Deliberately not a total count: counting would mean running the
            // whole unwind twice on every page. hasMore answers the question
            // pagination actually asks.
            hasMore: entries.length === limit,
        }, 'Diagnostics retrieved')
    );
});

/**
 * GET /api/v1/admin/diagnostics/summary
 *
 * What is going wrong right now, grouped, so the question "is anything broken"
 * does not require reading a log line by line.
 */
export const getDiagnosticsSummary = asyncHandler(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [byTier, topErrors] = await Promise.all([
        DiagnosticLog.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: '$source', batches: { $sum: 1 }, entries: { $sum: '$entryCount' } } },
        ]),
        DiagnosticLog.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $limit: 2000 },
            { $unwind: '$entries' },
            { $match: { 'entries.level': 'ERROR' } },
            {
                $group: {
                    _id: { tag: '$entries.tag', source: '$source' },
                    count: { $sum: 1 },
                    lastSeen: { $max: '$entries.ts' },
                    sample: { $first: '$entries.message' },
                    sampleRequestId: { $first: '$requestId' },
                },
            },
            { $sort: { count: -1 } },
            { $limit: 25 },
        ]),
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            windowHours: hours,
            since,
            byTier,
            topErrors: topErrors.map((e) => ({
                tag: e._id.tag,
                source: e._id.source,
                count: e.count,
                lastSeen: e.lastSeen,
                sample: e.sample,
                sampleRequestId: e.sampleRequestId,
            })),
        }, 'Summary generated')
    );
});
