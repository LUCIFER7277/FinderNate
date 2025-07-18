// routes/post.routes.js
import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
    createNormalPost,
    createProductPost,
    createServicePost,
    createBusinessPost,
} from "../controllers/post.controllers.js";
import { getHomeFeed } from "../controllers/homeFeed.controllers.js";

const router = Router();

// Accept image or video from frontend
const mediaUpload = upload.fields([
    { name: "image", maxCount: 10 },
    { name: "video", maxCount: 10 },
    { name: "reel", maxCount: 10 },
    { name: "story", maxCount: 10 },
]);

router.route("/create/normal").post(mediaUpload, verifyJWT, createNormalPost);
router.route("/create/service").post(mediaUpload, verifyJWT, createServicePost);
router.route("/create/product").post(mediaUpload, verifyJWT, createProductPost);
router.route("/create/business").post(mediaUpload, verifyJWT, createBusinessPost);

router.route("/home-feed").get(verifyJWT, getHomeFeed);

export default router;
