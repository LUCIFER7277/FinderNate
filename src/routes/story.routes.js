import express from "express";
import { uploadStory, fetchStoriesFeed, fetchStoriesByUser, markStorySeen, fetchStoryViewers, fetchArchivedStoriesByUser, archiveStory, unarchiveStory, deleteStory } from "../controllers/story.controllers.js";
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

// Archive / un-archive a story — author only, and the only thing that ever
// sets isArchived. An archived story is exempt from the 24-hour purge job and
// is what GET /archived/:userId lists.
router.patch("/:storyId/archive", verifyJWT, archiveStory);
router.patch("/:storyId/unarchive", verifyJWT, unarchiveStory);

// Fetch viewers of a story
router.get("/:storyId/viewers", verifyJWT, fetchStoryViewers);

// Delete a story
router.delete("/:storyId", verifyJWT, deleteStory);

export default router;