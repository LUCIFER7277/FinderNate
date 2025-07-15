import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { createNormalPost, createServicePost } from "../controllers/post.controllers.js";

const router = Router();

 router.route("/create/normal").post(upload.single("media"), verifyJWT, createNormalPost);
// router.route("/create/service").post(upload.single("media"), verifyJWT, createServicePost);
// router.route("/create/product").post(upload.single("media"), verifyJWT, createProductPost);
// router.route("/create/business").post(upload.single("media"), verifyJWT, createBusinessPost);

export default router;
