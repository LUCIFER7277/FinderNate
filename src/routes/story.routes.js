import express from "express";
import { uploadStory, fetchStoriesFeed, fetchStoriesByUser, markStorySeen, fetchStoryViewers, fetchArchivedStoriesByUser, deleteStory } from "../controllers/story.controllers.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multerConfig.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";

const router = express.Router();

// Upload a story (single image/video)
router.post("/upload", verifyJWT, upload.single("media"), uploadStory);

// Fetch stories feed (from followed + self)
router.get("/feed", verifyJWT, getBlockedUsersMiddleware, fetchStoriesFeed);

// Fetch stories by user id - allow both authenticated and unauthenticated users with privacy checks
router.get("/user/:userId", optionalVerifyJWT, getBlockedUsersMiddleware, fetchStoriesByUser);

// Mark story as seen
router.post("/seen", verifyJWT, getBlockedUsersMiddleware, markStorySeen);

// Fetch archived stories by user - allow both authenticated and unauthenticated users with privacy checks
router.get("/archived/:userId", optionalVerifyJWT, getBlockedUsersMiddleware, fetchArchivedStoriesByUser);

// Fetch viewers of a story
router.get("/:storyId/viewers", verifyJWT, fetchStoryViewers);

// Delete a story
router.delete("/:storyId", verifyJWT, deleteStory);

export default router;