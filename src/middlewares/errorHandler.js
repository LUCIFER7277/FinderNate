import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';
import { MAX_UPLOAD_MB, overallTooLargeMessage } from '../constants/uploadLimits.js';

const errorHandler = (err, req, res, next) => {
    // Handle Multer errors
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            // Multer raises this for a field it does not recognise AND for one
            // file too many on a field it does — attaching two videos to a
            // post lands here, where the old "Unexpected file field: video"
            // read like a bug rather than a limit. Stays route-agnostic: this
            // handler is global, so it cannot quote any one route's counts.
            return res.status(400).json({
                success: false,
                message: `Too many files, or an unexpected one, on "${err.field}". `
                    + `Either this endpoint does not accept that field, or more files were attached than it allows.`,
                errors: [],
                data: { field: err.field ?? null }
            });
        }

        // Multer's own text for this is the bare string "File too large",
        // which leaves the user with no idea what the limit is or what to do.
        // It fires mid-stream, before any controller runs, so the file's type
        // and full size are not known here — only the hard ceiling.
        // 413 rather than 400: this is specifically a payload-size refusal,
        // and clients can key retry/compress behaviour off it.
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                message: overallTooLargeMessage(err.field),
                errors: [],
                data: { limitMB: MAX_UPLOAD_MB, field: err.field ?? null }
            });
        }

        return res.status(400).json({
            success: false,
            message: err.message,
            errors: [],
            data: null
        });
    }

    // Handle custom ApiError
    if (err instanceof ApiError) {
        logError(err, req, err.statusCode || 500);
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message,
            errors: err.errors || [],
            data: err.data || null,
            requestId: req.id
        });
    }

    // ── Database errors ────────────────────────────────────────────────────
    // These arrive as raw driver objects whose `message` names the collection
    // and index that failed ("E11000 duplicate key error collection:
    // test.users index: username_1 dup key: { username: \"mnbhat\" }"). That
    // went straight into the response below, so the client both showed the
    // user something meaningless AND leaked the internal schema. Translate the
    // ones that represent a real, explainable conflict; everything else falls
    // through to the generic 500.

    if (err?.code === 11000) {
        const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
        return res.status(409).json({
            success: false,
            message: duplicateMessage(field),
            errors: field ? [{ field, message: duplicateMessage(field) }] : [],
            data: null,
            requestId: req.id
        });
    }

    if (err?.name === 'ValidationError' && err.errors) {
        const errors = Object.entries(err.errors).map(([field, e]) => ({
            field,
            message: e.message
        }));
        return res.status(400).json({
            success: false,
            message: errors.map(e => e.message).join(', ') || 'Invalid input',
            errors,
            data: null,
            requestId: req.id
        });
    }

    if (err?.name === 'CastError') {
        // A malformed id in the URL — "/posts/undefined" is the usual source.
        return res.status(400).json({
            success: false,
            message: `Invalid ${err.path === '_id' ? 'id' : err.path} in request`,
            errors: [],
            data: null,
            requestId: req.id
        });
    }

    // ── Anything unexpected ────────────────────────────────────────────────
    const statusCode = err.statusCode || 500;
    logError(err, req, statusCode);

    // `err.message` on an unhandled exception is written for a developer, not
    // a user, and can carry connection strings, file paths or driver internals.
    // Past this point the honest thing to show is that something broke, plus
    // the id that finds the stack in the logs.
    const safeMessage = statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'Something went wrong on our end. Please try again.'
        : (err.message || 'Internal Server Error');

    return res.status(statusCode).json({
        success: false,
        message: safeMessage,
        errors: err.errors || [],
        data: null,
        requestId: req.id,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
};

const DUPLICATE_MESSAGES = {
    username: 'That username is already taken. Please choose another.',
    email: 'An account already exists for this email address. Please sign in instead.',
    phoneNumber: 'That phone number is already registered.',
};

const duplicateMessage = (field) =>
    DUPLICATE_MESSAGES[field] || 'That value is already in use. Please try a different one.';

/**
 * Everything that failed gets written down.
 *
 * 5xx carries the stack, because the question is "what broke". 4xx is a single
 * line, because the question is "who is being refused and why" — and a stack
 * for every rejected password would drown the log.
 *
 * 401 and 429 are skipped: expired tokens and rate limits are constant
 * background noise on a public API, and requestLogger already counts them.
 */
const logError = (err, req, statusCode) => {
    if (statusCode === 401 || statusCode === 429) return;

    const who = req.user?._id ? ` user=${req.user._id}` : '';
    const head = `[error] id=${req.id} ${req.method} ${req.originalUrl} → ${statusCode}${who}`;

    if (statusCode >= 500) {
        console.error(`${head}\n  ${err.name}: ${err.message}\n${err.stack || ''}`);
    } else {
        console.warn(`${head} — ${err.message}`);
    }
};

export { errorHandler };
