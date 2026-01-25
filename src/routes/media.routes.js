import express from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    uploadSingleMedia,
    uploadMultipleMedia,
    deleteMedia,
    deleteMultipleMedia,
    getMediaInfo
} from "../controllers/uploadMedia.controllers.js";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Upload single media file
router.post("/upload-single", upload.single("media"), uploadSingleMedia);

// Upload multiple media files
router.post("/upload-multiple", upload.array("media", 10), uploadMultipleMedia);

// Delete single media file
router.delete("/delete", deleteMedia);

// Delete multiple media files
router.delete("/delete-multiple", deleteMultipleMedia);

// Get media information
router.get("/info", getMediaInfo);

export default router; 