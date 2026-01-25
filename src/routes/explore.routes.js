import express from "express";
import { getExploreFeed } from "../controllers/explore.controllers.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";

const router = express.Router();

router.route("/").get(verifyJWT, getBlockedUsersMiddleware, getExploreFeed);

export default router;
