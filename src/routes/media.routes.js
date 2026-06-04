import express from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    uploadSingleMedia,
    uploadMultipleMedia,
    deleteMedia,
    deleteMultipleMedia,
    getMediaInfo,
} from "../controllers/uploadMedia.controllers.js";

const router = express.Router();

router.use(verifyJWT);

// Upload single file — image / video / audio / document
// Limits: image 10 MB · video 50 MB · audio 6 MB · file 7 MB
router.post("/upload-single", upload.single("media"), uploadSingleMedia);

// Upload multiple files
router.post("/upload-multiple", upload.array("media", 10), uploadMultipleMedia);

// Delete single file
router.delete("/delete", deleteMedia);

// Delete multiple files
router.delete("/delete-multiple", deleteMultipleMedia);

// Get file info
router.get("/info", getMediaInfo);

export default router; 