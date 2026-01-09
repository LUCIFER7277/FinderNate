import mongoose from "mongoose";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Post from "../models/userPost.models.js";
import Like from "../models/like.models.js";
import Comment from "../models/comment.models.js";
import PostInteraction from "../models/postInteraction.models.js";
import Follower from "../models/follower.models.js";
import { canViewPost } from "../utlis/postPrivacy.js";
import {
  canSharePost,
  generatePreviewHTML,
  sanitizePostForGuest,
  generateErrorHTML,
} from "../utlis/shareUtils.js";
import { redisClient } from "../config/redis.config.js";

/**
 * Generate shareable link for a post
 * POST /api/v1/share/post/:postId/generate
 * Authentication: Required
 */
export const generatePostShareLink = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const userId = req.user._id;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Find post with user details
  const post = await Post.findById(postId).populate(
    "userId",
    "username fullName profileImageUrl"
  );

  if (!post) {
    throw new ApiError(404, "Post not found");
  }

  // Check if post can be shared
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Verify user can access this post (owner or post is public)
  const isOwner = post.userId._id.toString() === userId.toString();
  if (!isOwner && post.settings?.privacy !== "public") {
    throw new ApiError(403, "You don't have permission to share this post");
  }

  // Generate shareable link
  const shareLink = `https://findernate.com/p/${postId}`;

  // Prepare preview data
  const previewData = {
    shareLink,
    postType: post.postType,
    contentType: post.contentType,
    preview: {
      caption: post.caption
        ? post.caption.substring(0, 200) + (post.caption.length > 200 ? "..." : "")
        : null,
      thumbnailUrl: post.media?.[0]?.thumbnailUrl || post.media?.[0]?.url,
      author: {
        username: post.userId.username,
        fullName: post.userId.fullName,
        profileImageUrl: post.userId.profileImageUrl,
      },
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(200, previewData, "Share link generated successfully")
    );
});

/**
 * Generate shareable link for a reel
 * POST /api/v1/share/reel/:postId/generate
 * Authentication: Required
 */
export const generateReelShareLink = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const userId = req.user._id;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Find post with user details
  const post = await Post.findById(postId).populate(
    "userId",
    "username fullName profileImageUrl"
  );

  if (!post) {
    throw new ApiError(404, "Reel not found");
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    throw new ApiError(400, "This post is not a reel or video");
  }

  // Check if post can be shared
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Verify user can access this post (owner or post is public)
  const isOwner = post.userId._id.toString() === userId.toString();
  if (!isOwner && post.settings?.privacy !== "public") {
    throw new ApiError(403, "You don't have permission to share this reel");
  }

  // Generate shareable link
  const shareLink = `https://findernate.com/r/${postId}`;

  // Prepare preview data with video-specific metadata
  const previewData = {
    shareLink,
    postType: post.postType,
    contentType: post.contentType,
    preview: {
      caption: post.caption
        ? post.caption.substring(0, 200) + (post.caption.length > 200 ? "..." : "")
        : null,
      thumbnailUrl: post.media?.[0]?.thumbnailUrl || post.media?.[0]?.url,
      videoUrl: post.media?.[0]?.url,
      duration: post.media?.[0]?.duration,
      dimensions: post.media?.[0]?.dimensions,
      author: {
        username: post.userId.username,
        fullName: post.userId.fullName,
        profileImageUrl: post.userId.profileImageUrl,
      },
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(200, previewData, "Share link generated successfully")
    );
});

/**
 * Get shared post (public endpoint for guests)
 * GET /api/v1/share/post/:postId
 * Authentication: Optional (optionalVerifyJWT)
 */
export const getSharedPost = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const viewer = req.user || null;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Check cache first
  const cacheKey = `fn:share:post:${postId}`;
  const cachedData = await redisClient.get(cacheKey);

  if (cachedData) {
    const parsed = JSON.parse(cachedData);
    // If viewer exists, we need to recalculate isLikedBy
    if (viewer) {
      const likes = await Like.find({ postId }).lean();
      const likedByUserIds = likes.map((like) => like.userId.toString());
      parsed.post.isLikedBy = likedByUserIds.includes(viewer._id.toString());
    }
    return res
      .status(200)
      .json(new ApiResponse(200, parsed, "Post fetched from cache"));
  }

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl privacy isFullPrivate")
    .lean();

  if (!post) {
    throw new ApiError(404, "This post is no longer available");
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Get viewer's following/followers lists if viewer is authenticated
  let viewerFollowing = [];
  let viewerFollowers = [];

  if (viewer) {
    // Check if viewer is blocked by post owner or vice versa
    const Block = mongoose.model("Block");
    const blockExists = await Block.findOne({
      $or: [
        { blockerId: post.userId._id, blockedId: viewer._id },
        { blockerId: viewer._id, blockedId: post.userId._id },
      ],
    });

    if (blockExists) {
      throw new ApiError(404, "Post not found");
    }

    const followingRecords = await Follower.find({
      followerId: viewer._id,
    }).lean();
    const followerRecords = await Follower.find({ userId: viewer._id }).lean();

    viewerFollowing = followingRecords.map((f) => f.userId.toString());
    viewerFollowers = followerRecords.map((f) => f.followerId.toString());
  }

  // Check privacy using existing privacy utility
  const canView = canViewPost(
    post,
    post.userId,
    viewer,
    viewerFollowing,
    viewerFollowers
  );

  if (!canView) {
    if (!viewer) {
      throw new ApiError(
        403,
        "This post is private. Please sign in to view if you have permission."
      );
    } else {
      throw new ApiError(403, "You don't have permission to view this post");
    }
  }

  // Fetch engagement data
  const likes = await Like.find({ postId }).lean();
  const comments = await Comment.find({ postId }).lean();

  const likedByUserIds = likes.map((like) => like.userId.toString());
  if (viewer) {
    post.isLikedBy = likedByUserIds.includes(viewer._id.toString());
  }

  // Get top 3 users who liked
  const topLikes = await Like.find({ postId })
    .populate("userId", "username fullName profileImageUrl")
    .limit(3)
    .lean();
  post.likedBy = topLikes.map((like) => like.userId);

  // Sanitize post data for guests
  const sanitizedPost = sanitizePostForGuest(post, viewer);

  const responseData = {
    post: sanitizedPost,
    shareMetadata: {
      shareUrl: `https://findernate.com/p/${postId}`,
      canShare: true,
      viewerCanInteract: !!viewer,
    },
  };

  // Cache the response for 5 minutes (300 seconds)
  // Don't cache viewer-specific fields
  const cacheData = {
    post: sanitizePostForGuest(post, null),
    shareMetadata: {
      shareUrl: `https://findernate.com/p/${postId}`,
      canShare: true,
      viewerCanInteract: false,
    },
  };
  await redisClient.setex(cacheKey, 300, JSON.stringify(cacheData));

  return res
    .status(200)
    .json(new ApiResponse(200, responseData, "Post fetched successfully"));
});

/**
 * Get shared reel (public endpoint for guests)
 * GET /api/v1/share/reel/:postId
 * Authentication: Optional (optionalVerifyJWT)
 */
export const getSharedReel = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const viewer = req.user || null;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Check cache first
  const cacheKey = `fn:share:reel:${postId}`;
  const cachedData = await redisClient.get(cacheKey);

  if (cachedData) {
    const parsed = JSON.parse(cachedData);
    // If viewer exists, we need to recalculate isLikedBy
    if (viewer) {
      const likes = await Like.find({ postId }).lean();
      const likedByUserIds = likes.map((like) => like.userId.toString());
      parsed.post.isLikedBy = likedByUserIds.includes(viewer._id.toString());
    }
    return res
      .status(200)
      .json(new ApiResponse(200, parsed, "Reel fetched from cache"));
  }

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl privacy isFullPrivate")
    .lean();

  if (!post) {
    throw new ApiError(404, "This reel is no longer available");
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    throw new ApiError(400, "This content is not a reel or video");
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Get viewer's following/followers lists if viewer is authenticated
  let viewerFollowing = [];
  let viewerFollowers = [];

  if (viewer) {
    // Check if viewer is blocked by post owner or vice versa
    const Block = mongoose.model("Block");
    const blockExists = await Block.findOne({
      $or: [
        { blockerId: post.userId._id, blockedId: viewer._id },
        { blockerId: viewer._id, blockedId: post.userId._id },
      ],
    });

    if (blockExists) {
      throw new ApiError(404, "Reel not found");
    }

    const followingRecords = await Follower.find({
      followerId: viewer._id,
    }).lean();
    const followerRecords = await Follower.find({ userId: viewer._id }).lean();

    viewerFollowing = followingRecords.map((f) => f.userId.toString());
    viewerFollowers = followerRecords.map((f) => f.followerId.toString());
  }

  // Check privacy using existing privacy utility
  const canView = canViewPost(
    post,
    post.userId,
    viewer,
    viewerFollowing,
    viewerFollowers
  );

  if (!canView) {
    if (!viewer) {
      throw new ApiError(
        403,
        "This reel is private. Please sign in to view if you have permission."
      );
    } else {
      throw new ApiError(403, "You don't have permission to view this reel");
    }
  }

  // Fetch engagement data
  const likes = await Like.find({ postId }).lean();
  const comments = await Comment.find({ postId }).lean();

  const likedByUserIds = likes.map((like) => like.userId.toString());
  if (viewer) {
    post.isLikedBy = likedByUserIds.includes(viewer._id.toString());
  }

  // Get top 3 users who liked
  const topLikes = await Like.find({ postId })
    .populate("userId", "username fullName profileImageUrl")
    .limit(3)
    .lean();
  post.likedBy = topLikes.map((like) => like.userId);

  // Sanitize post data for guests
  const sanitizedPost = sanitizePostForGuest(post, viewer);

  const responseData = {
    post: sanitizedPost,
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: true,
      viewerCanInteract: !!viewer,
    },
  };

  // Cache the response for 5 minutes (300 seconds)
  const cacheData = {
    post: sanitizePostForGuest(post, null),
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: true,
      viewerCanInteract: false,
    },
  };
  await redisClient.setex(cacheKey, 300, JSON.stringify(cacheData));

  return res
    .status(200)
    .json(new ApiResponse(200, responseData, "Reel fetched successfully"));
});

/**
 * Get post preview page with Open Graph meta tags
 * GET /api/v1/share/post/:postId/preview
 * Authentication: None
 */
export const getPostPreviewPage = asyncHandler(async (req, res) => {
  const { postId } = req.params;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return res.status(404).type("html").send(generateErrorHTML("Invalid post ID"));
  }

  // Check cache first
  const cacheKey = `fn:share:preview:${postId}`;
  const cachedHTML = await redisClient.get(cacheKey);

  if (cachedHTML) {
    return res.status(200).type("html").send(cachedHTML);
  }

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl")
    .lean();

  if (!post) {
    const errorHTML = generateErrorHTML("Post Not Found");
    return res.status(404).type("html").send(errorHTML);
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    const errorHTML = generateErrorHTML(shareCheck.reason);
    return res.status(403).type("html").send(errorHTML);
  }

  // Generate preview HTML
  const htmlContent = generatePreviewHTML(post, "post");

  // Cache for 10 minutes (600 seconds)
  await redisClient.setex(cacheKey, 600, htmlContent);

  return res.status(200).type("html").send(htmlContent);
});

/**
 * Get reel preview page with Open Graph meta tags
 * GET /api/v1/share/reel/:postId/preview
 * Authentication: None
 */
export const getReelPreviewPage = asyncHandler(async (req, res) => {
  const { postId } = req.params;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return res.status(404).type("html").send(generateErrorHTML("Invalid reel ID"));
  }

  // Check cache first
  const cacheKey = `fn:share:preview:reel:${postId}`;
  const cachedHTML = await redisClient.get(cacheKey);

  if (cachedHTML) {
    return res.status(200).type("html").send(cachedHTML);
  }

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl")
    .lean();

  if (!post) {
    const errorHTML = generateErrorHTML("Reel Not Found");
    return res.status(404).type("html").send(errorHTML);
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    const errorHTML = generateErrorHTML("This content is not a reel or video");
    return res.status(400).type("html").send(errorHTML);
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    const errorHTML = generateErrorHTML(shareCheck.reason);
    return res.status(403).type("html").send(errorHTML);
  }

  // Generate preview HTML
  const htmlContent = generatePreviewHTML(post, "reel");

  // Cache for 10 minutes (600 seconds)
  await redisClient.setex(cacheKey, 600, htmlContent);

  return res.status(200).type("html").send(htmlContent);
});

/**
 * Track share event
 * POST /api/v1/share/track
 * Authentication: Required
 */
export const trackShare = asyncHandler(async (req, res) => {
  const { postId, platform, referrer } = req.body;
  const userId = req.user._id;

  // Validate postId
  if (!postId || !mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Find post
  const post = await Post.findById(postId);

  if (!post) {
    throw new ApiError(404, "Post not found");
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Increment engagement counter
  await Post.findByIdAndUpdate(postId, {
    $inc: { "engagement.shares": 1 },
  });

  // Create PostInteraction record
  await PostInteraction.create({
    userId,
    postId,
    interactionType: "share",
    lastInteracted: new Date(),
  });

  // Optionally track analytics
  if (platform || referrer) {
    await Post.findByIdAndUpdate(postId, {
      $push: {
        "analytics.shareEvents": {
          $each: [
            {
              userId,
              platform: platform || "unknown",
              referrer: referrer || req.get("referer") || "direct",
              timestamp: new Date(),
              userAgent: req.get("user-agent"),
            },
          ],
          $slice: -100, // Keep only last 100 share events
        },
      },
    });
  }

  // Get updated share count
  const updatedPost = await Post.findById(postId).select("engagement.shares");

  // Invalidate cache
  await redisClient.del(`fn:share:post:${postId}`);
  await redisClient.del(`fn:share:reel:${postId}`);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        shareCount: updatedPost.engagement.shares,
        shareUrl: `https://findernate.com/${post.postType === "reel" || post.postType === "video" ? "r" : "p"}/${postId}`,
      },
      "Share tracked successfully"
    )
  );
});
