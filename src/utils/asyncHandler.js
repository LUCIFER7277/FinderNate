const asyncHandler = (requesHandler) => {
    return (req, res, next) => {
        Promise.resolve(requesHandler(req, res, next))
            .catch((err) => {
                if (typeof next === 'function') {
                    next(err);
                } else {
                    // If next is not available, log error and send response directly
                    console.error('Unhandled error in asyncHandler:', err);
                    if (res && typeof res.status === 'function' && !res.headersSent) {
                        res.status(err.statusCode || 500).json({
                            success: false,
                            message: err.message || "Internal Server Error",
                            errors: err.errors || [],
                            data: null
                        });
                    }
                }
            });
    }
}
export { asyncHandler };