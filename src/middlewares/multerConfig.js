import multer from "multer";
import { MAX_UPLOAD_MB } from "../constants/uploadLimits.js";

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

// Hard ceiling, from constants/uploadLimits.js so the number and the message
// the user gets can never disagree.
//
// WARNING: storage is memoryStorage, so the WHOLE file is held in the Node
// process while it uploads. Peak RSS is about this figure multiplied by the
// number of uploads in flight. A single post is now bounded at one video plus
// nine images (uploadPostMedia enforces both the counts and the per-type sizes,
// so ~700 MB worst case), but the batch route still carries six posts' worth.
// Serving this safely needs either disk storage or direct client-to-Bunny
// uploads — until then, treat the container's memory headroom as the real
// limit, not this number.
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES, // global cap — per-type limits enforced in controllers
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
