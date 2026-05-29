import multer from "multer";

// Accept any image/*, video/*, audio/*, plus specific document types.
// Per-type size limits and stricter type checks are handled in each controller.
const isAllowedMime = (mime) => {
    if (!mime) return false;
    if (mime.startsWith('image/')) return true;
    if (mime.startsWith('video/')) return true;
    if (mime.startsWith('audio/')) return true;
    const allowedDocs = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'application/zip',
        'application/x-rar-compressed',
        'application/x-zip-compressed',
        'application/octet-stream',
    ];
    return allowedDocs.includes(mime);
};

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 80 * 1024 * 1024, // 80 MB global cap — per-type limits enforced in controllers
    },
    fileFilter: (req, file, cb) => {
        if (isAllowedMime(file.mimetype)) {
            cb(null, true);
        } else {
            // Return a proper error — Express will convert this to 400 via error middleware
            cb(Object.assign(new Error(`File type "${file.mimetype}" is not supported`), { status: 400 }), false);
        }
    },
});
