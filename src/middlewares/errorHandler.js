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
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.message,
            errors: err.errors || [],
            data: err.data || null
        });
    }

    // Default error handler
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error",
        errors: err.errors || [],
        data: null,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
};

export { errorHandler };
