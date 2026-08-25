import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';
import { MAX_UPLOAD_MB, overallTooLargeMessage } from '../constants/uploadLimits.js';

/**
 * The global error handler.
 *
 * Structured as classify-then-respond rather than a chain of branches that each
 * build and send their own response. The earlier shape had six exits and only
 * two of them logged, so a duplicate key, a validation failure, a cast error
 * and every multer rejection were answered without recording anything — silent
 * in exactly the way this handler exists to prevent. Deciding the response and
 * sending it are now separate steps, which makes "returned without logging"
 * unrepresentable rather than merely fixed.
 *
 * MUST STAY SYNCHRONOUS. Express 4 does not await error handlers: marking this
 * async turns any internal rejection into an unhandledRejection, and
 * src/index.js exits the process on those. Nothing here may touch the database
 * or await anything.
 */
const errorHandler = (err, req, res, next) => {
    const { status, body } = classify(err);

    logError(err, req, status);

    return res.status(status).json({ ...body, requestId: req.id });
};

/**
 * Maps a thrown value to the status and body the client should see.
 * Pure: no I/O, no logging, no response writing.
 */
const classify = (err) => {
    // ── Upload rejections ──────────────────────────────────────────────────
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            // Multer raises this for a field it does not recognise AND for one
            // file too many on a field it does — attaching two videos to a
            // post lands here, where the old "Unexpected file field: video"
            // read like a bug rather than a limit. Stays route-agnostic: this
            // handler is global, so it cannot quote any one route's counts.
            return {
                status: 400,
                body: {
                    success: false,
                    message: `Too many files, or an unexpected one, on "${err.field}". `
                        + `Either this endpoint does not accept that field, or more files were attached than it allows.`,
                    errors: [],
                    data: { field: err.field ?? null }
                }
            };
        }

        // Multer's own text for this is the bare string "File too large",
        // which leaves the user with no idea what the limit is or what to do.
        // It fires mid-stream, before any controller runs, so the file's type
        // and full size are not known here — only the hard ceiling.
        // 413 rather than 400: this is specifically a payload-size refusal,
        // and clients can key retry/compress behaviour off it.
        if (err.code === 'LIMIT_FILE_SIZE') {
            return {
                status: 413,
                body: {
                    success: false,
                    message: overallTooLargeMessage(err.field),
                    errors: [],
                    data: { limitMB: MAX_UPLOAD_MB, field: err.field ?? null }
                }
            };
        }

        return {
            status: 400,
            body: { success: false, message: err.message, errors: [], data: null }
        };
    }

    // ── Deliberate, already-worded failures ────────────────────────────────
    if (err instanceof ApiError) {
        return {
            status: err.statusCode || 500,
            body: {
                success: false,
                message: err.message,
                errors: err.errors || [],
                data: err.data || null
            }
        };
    }

    // ── Database errors ────────────────────────────────────────────────────
    // These arrive as raw driver objects whose `message` names the collection
    // and index that failed ("E11000 duplicate key error collection:
    // test.users index: username_1 dup key: { username: \"mnbhat\" }"). That
    // used to go straight into the response, so the client both showed the
    // user something meaningless AND leaked the internal schema.
    if (err?.code === 11000) {
        const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
        const message = duplicateMessage(field);
        return {
            status: 409,
            body: {
                success: false,
                message,
                errors: field ? [{ field, message }] : [],
                data: null
            }
        };
    }

    if (err?.name === 'ValidationError' && err.errors) {
        const errors = Object.entries(err.errors).map(([field, e]) => ({
            field,
            message: e.message
        }));
        return {
            status: 400,
            body: {
                success: false,
                message: errors.map(e => e.message).join(', ') || 'Invalid input',
                errors,
                data: null
            }
        };
    }

    if (err?.name === 'CastError') {
        // A malformed id in the URL — "/posts/undefined" is the usual source.
        return {
            status: 400,
            body: {
                success: false,
                message: `Invalid ${err.path === '_id' ? 'id' : err.path} in request`,
                errors: [],
                data: null
            }
        };
    }

    // ── Anything unexpected ────────────────────────────────────────────────
    const status = err?.statusCode || 500;

    // `err.message` on an unhandled exception is written for a developer, not
    // a user, and can carry connection strings, file paths or driver
    // internals. Past this point the honest thing to show is that something
    // broke, plus the id that finds the stack in the logs.
    const message = status >= 500 && process.env.NODE_ENV === 'production'
        ? 'Something went wrong on our end. Please try again.'
        : (err?.message || 'Internal Server Error');

    return {
        status,
        body: {
            success: false,
            message,
            errors: err?.errors || [],
            data: null,
            stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined
        }
    };
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
        console.error(`${head}\n  ${err?.name}: ${err?.message}\n${err?.stack || ''}`);
    } else {
        console.warn(`${head} — ${err?.message}`);
    }
};

export { errorHandler };
