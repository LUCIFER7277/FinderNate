import multer from 'multer';
import { ApiError } from '../utlis/ApiError.js';

const errorHandler = (err, req, res, next) => {
    // Handle Multer errors
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                success: false,
                message: `Unexpected file field: ${err.field}`,
                errors: [],
                data: null
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
            data: null
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
