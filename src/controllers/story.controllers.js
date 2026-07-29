import Story from "../models/story.models.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { uploadBufferToBunny } from "../utils/bunny.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/user.models.js";
import Business from "../models/business.models.js";
import { checkContentVisibility } from "../middlewares/privacy.middleware.js";

// 1. Upload Story
export const uploadStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    if (!req.file) throw new ApiError(400, "Media file is required");

    const result = await uploadBufferToBunny(req.file.buffer, "stories");
    if (!result.secure_url) throw new ApiError(500, "Failed to upload story media");

    const story = await Story.create({
        userId,
        mediaUrl: result.secure_url,
        mediaType: result.resource_type === "video" ? "video" : "image",
        caption: req.body.caption || "",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    // Map mediaType to postType, remove mediaType and viewers from response
    const storyObj = story.toObject();
    storyObj.postType = storyObj.mediaType;
    delete storyObj.mediaType;
    delete storyObj.viewers;

    res.status(201).json(new ApiResponse(201, storyObj, "Story uploaded successfully"));
});

// 2. Fetch Stories from followed users (and self) - excluding blocked users
export const fetchStoriesFeed = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const blockedUsers = req.blockedUsers || [];

    // Get current user's following list
    const currentUser = await User.findById(userId).select("following followers");
    const following = currentUser?.following || [];
    const followers = currentUser?.followers || [];

    const now = new Date();

    // Get all active stories and populate user info including privacy
    const allStories = await Story.find({
        isArchived: false,
        expiresAt: { $gt: now }
    })
        .sort({ createdAt: -1 })
        .populate("userId", "username profileImageUrl privacy followers following isBusinessProfile");

    // Get active payment plan user IDs and business user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));

    // Filter stories based on privacy rules AND business payment plan rules
    const visibleStories = allStories.filter(story => {
        const storyOwnerId = story.userId._id.toString();
        const storyOwnerPrivacy = story.userId.privacy || 'public';
        const isBusinessAccount = story.userId.isBusinessProfile || false;
        const hasActivePlan = activePlanUserIdsSet.has(storyOwnerId);

        // Rule 1: Always show own stories
        if (storyOwnerId === userId.toString()) {
            return true;
        }

        // Rule 2: Never show stories from blocked users (mutual blocking)
        if (blockedUsers.includes(storyOwnerId)) {
            return false;
        }

        // Rule 3: Hide unpaid business stories from ALL users (including followers)
        if (isBusinessAccount && !hasActivePlan) {
            return false;
        }

        // Rule 4: If story owner has PUBLIC account → show to everyone
        if (storyOwnerPrivacy === 'public') {
            return true;
        }

        // Rule 5: If story owner has PRIVATE account → only show to followers/following
        if (storyOwnerPrivacy === 'private') {
            const isFollowing = following.some(id => id.toString() === storyOwnerId);
            const isFollower = followers.some(id => id.toString() === storyOwnerId);

            return isFollowing || isFollower;
        }

        return false;
    });

    // Map mediaType to postType and remove viewers
    const storiesWithPostType = visibleStories.map(story => {
        const obj = story.toObject();
        obj.postType = obj.mediaType;
        delete obj.mediaType;
        delete obj.viewers;
        // Remove privacy field from user object in response
        if (obj.userId) {
            delete obj.userId.privacy;
            delete obj.userId.followers;
            delete obj.userId.following;
        }
        return obj;
    });

    res.status(200).json(new ApiResponse(200, storiesWithPostType, "Stories feed fetched"));
});
// 3. Fetch Stories by user id
export const fetchStoriesByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const viewerId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];

    // Rule 1: Check if user is blocked
    if (blockedUsers.includes(userId)) {
        throw new ApiError(403, "You don't have permission to view this user's stories");
    }

    // Rule 2: Get target user's privacy settings
    const targetUser = await User.findById(userId).select('privacy username profileImageUrl');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    // Rule 3: Check if viewer can see this user's content
    const isOwnStory = viewerId?.toString() === userId;
    const isPublicAccount = targetUser.privacy === 'public';

    if (!isOwnStory && !isPublicAccount) {
        // For private accounts, check if viewer is following
        if (!viewerId) {
            throw new ApiError(403, "This account is private");
        }

        // Use the existing privacy check function
        const canView = await checkContentVisibility(viewerId, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their stories.");
        }
    }

    // Get active payment plan user IDs and business user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));
    
    const targetUserFull = await User.findById(userId).select('isBusinessProfile');
    const isBusinessAccount = targetUserFull?.isBusinessProfile || false;
    const hasActivePlan = activePlanUserIdsSet.has(userId);

    const now = new Date();
    const stories = await Story.find({
        userId,
        isArchived: false,
        expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });

    // Filter out unpaid business stories (hide from ALL users including
    // followers) — but NEVER from their author. fetchStoriesFeed already
    // exempts the owner ("Rule 1: Always show own stories"); this path did
    // not, so an unpaid business account posted a status and then could not
    // see it on its own profile, which reads as the upload having failed.
    const filteredStories = stories.filter(() => {
        if (isOwnStory) return true;
        if (isBusinessAccount && !hasActivePlan) {
            return false;
        }
        return true;
    });

    // Map mediaType to postType and remove viewers
    const storiesWithPostType = filteredStories.map(story => {
        const obj = story.toObject();
        obj.postType = obj.mediaType;
        delete obj.mediaType;

        // The author gets a count of who has seen each story; nobody else
        // learns anything about the audience. The identities stay behind
        // GET /stories/:storyId/viewers, which is owner-only — this is just
        // the number, so the badge can render without opening that screen.
        // The story's own author never counts as a viewer of it.
        if (isOwnStory) {
            obj.viewerCount = (obj.viewers || []).filter(
                v => v.toString() !== story.userId.toString()
            ).length;
        }
        delete obj.viewers;
        return obj;
    });

    res.status(200).json(new ApiResponse(200, storiesWithPostType, "User's stories fetched"));
});

// 4. Mark Story as Seen
export const markStorySeen = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { storyId } = req.body;
    const blockedUsers = req.blockedUsers || [];

    const story = await Story.findById(storyId);
    if (!story) throw new ApiError(404, "Story not found");

    // Don't allow marking stories as seen from blocked users
    if (blockedUsers.includes(story.userId.toString())) {
        throw new ApiError(403, "Cannot view this story");
    }

    // Don't add the story owner to viewers
    if (story.userId.toString() !== userId.toString() && !story.viewers.includes(userId)) {
        story.viewers.push(userId);
        await story.save();
    }

    res.status(200).json(new ApiResponse(200, {}, "Story marked as seen"));
});

// 5. Fetch list of seen people for a story
export const fetchStoryViewers = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    // fullName as well as username: the list is rendered as a profile row, and
    // a username alone is not who people recognise each other by.
    const story = await Story.findById(storyId)
        .populate("viewers", "username fullName profileImageUrl");
    if (!story) throw new ApiError(404, "Story not found");

    // Owner only. This previously answered for ANY authenticated caller, so
    // anyone holding a story id could enumerate who had watched someone else's
    // story — the audience for a story is private to its author everywhere
    // else, and the app only ever offers this screen to the author anyway.
    if (story.userId.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "Only the author can see who viewed this story");
    }

    // Filter out the story owner from viewers (safety measure)
    const filteredViewers = story.viewers.filter(
        viewer => viewer._id.toString() !== story.userId.toString()
    );

    // Pagination logic
    const start = (parseInt(page) - 1) * parseInt(limit);
    const end = start + parseInt(limit);
    const totalViewers = filteredViewers.length;
    const paginatedViewers = filteredViewers.slice(start, end);

    res.status(200).json(new ApiResponse(200, {
        viewers: paginatedViewers,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: totalViewers,
            totalPages: Math.ceil(totalViewers / parseInt(limit)),
            hasNextPage: end < totalViewers,
            hasPrevPage: start > 0
        }
    }, "Story viewers fetched"));
});

// 6. Fetch archived stories by user
export const fetchArchivedStoriesByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const viewerId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];
    const { page = 1, limit = 10 } = req.query;

    // Rule 1: Check if user is blocked
    if (blockedUsers.includes(userId)) {
        throw new ApiError(403, "You don't have permission to view this user's archived stories");
    }

    // Rule 2: Get target user's privacy settings
    const targetUser = await User.findById(userId).select('privacy username profileImageUrl');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    // Rule 3: Check if viewer can see this user's content
    const isOwnStory = viewerId?.toString() === userId;
    const isPublicAccount = targetUser.privacy === 'public';

    if (!isOwnStory && !isPublicAccount) {
        // For private accounts, check if viewer is following
        if (!viewerId) {
            throw new ApiError(403, "This account is private");
        }

        // Use the existing privacy check function
        const canView = await checkContentVisibility(viewerId, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their stories.");
        }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [stories, total] = await Promise.all([
        Story.find({ userId, isArchived: true })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .select("-viewers -mediaType") // remove viewers and mediaType from response
            .lean()
            .exec(),
        Story.countDocuments({ userId, isArchived: true })
    ]);

    // Map mediaType to postType in response if needed
    const storiesWithPostType = stories.map(story => {
        story.postType = story.mediaType;
        delete story.mediaType;
        return story;
    });

    res.status(200).json(new ApiResponse(200, {
        stories: storiesWithPostType,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
            hasNextPage: skip + stories.length < total,
            hasPrevPage: skip > 0
        }
    }, "User's archived stories fetched"));
});

// 7. Delete Story
export const deleteStory = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const userId = req.user._id;

    // Find the story
    const story = await Story.findById(storyId);
    if (!story) {
        throw new ApiError(404, "Story not found");
    }

    // Check if the user owns this story
    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You are not authorized to delete this story");
    }

    // Delete media from Bunny CDN
    try {
        const { deleteFromBunny } = await import("../utils/bunny.js");
        await deleteFromBunny(story.mediaUrl);
    } catch (error) {
        console.error('⚠️ Failed to delete story media from Bunny CDN:', error.message);
        // Continue with story deletion even if media deletion fails
    }

    // Delete the story from database
    await Story.findByIdAndDelete(storyId);

    res.status(200).json(new ApiResponse(200, { storyId }, "Story deleted successfully"));
});