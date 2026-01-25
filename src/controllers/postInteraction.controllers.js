import { asyncHandler } from "../utlis/asyncHandler.js";
import PostInteraction from "../models/postInteraction.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";

export const trackPostInteraction = asyncHandler(async (req, res) => {
    const { postId, interactionType, viewDuration = 0 } = req.body;
    const userId = req.user._id;

    if (!postId || !interactionType) {
        throw new ApiError(400, "postId and interactionType are required");
    }

    const validInteractionTypes = ['view', 'like', 'comment', 'share', 'click', 'hide'];
    if (!validInteractionTypes.includes(interactionType)) {
        throw new ApiError(400, "Invalid interaction type");
    }

    try {
        // Check if interaction already exists
        const existingInteraction = await PostInteraction.findOne({
            userId,
            postId,
            interactionType
        });

        if (existingInteraction) {
            // Update existing interaction
            existingInteraction.interactionCount += 1;
            existingInteraction.lastInteracted = new Date();
            if (viewDuration > 0) {
                existingInteraction.viewDuration = Math.max(existingInteraction.viewDuration, viewDuration);
            }
            await existingInteraction.save();
        } else {
            // Create new interaction
            await PostInteraction.create({
                userId,
                postId,
                interactionType,
                viewDuration,
                lastInteracted: new Date(),
                interactionCount: 1
            });
        }

        return res.status(200).json(
            new ApiResponse(200, {}, "Interaction tracked successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Failed to track interaction: " + error.message);
    }
});

export const hidePost = asyncHandler(async (req, res) => {
    const { postId } = req.body;
    const userId = req.user._id;

    if (!postId) {
        throw new ApiError(400, "postId is required");
    }

    try {
        // Mark post as hidden for this user
        await PostInteraction.findOneAndUpdate(
            { userId, postId, interactionType: 'hide' },
            {
                userId,
                postId,
                interactionType: 'hide',
                isHidden: true,
                lastInteracted: new Date(),
                $inc: { interactionCount: 1 }
            },
            { upsert: true, new: true }
        );

        return res.status(200).json(
            new ApiResponse(200, {}, "Post hidden successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Failed to hide post: " + error.message);
    }
});

export const batchTrackInteractions = asyncHandler(async (req, res) => {
    const { interactions } = req.body;
    const userId = req.user._id;

    if (!interactions || !Array.isArray(interactions)) {
        throw new ApiError(400, "interactions array is required");
    }

    try {
        const bulkOps = [];

        for (const interaction of interactions) {
            const { postId, interactionType, viewDuration } = interaction;

            if (!postId || !interactionType) continue;

            // Reject viewDuration for non-view interactions
            if (interactionType !== 'view' && viewDuration !== undefined) {
                throw new ApiError(400, `viewDuration is not allowed for ${interactionType} interactions`);
            }

            // Use different approach to avoid $max and $setOnInsert conflict
            if (interactionType === 'view' && viewDuration > 0) {
                // For view interactions with viewDuration, use a more complex update
                bulkOps.push({
                    updateOne: {
                        filter: { userId, postId, interactionType },
                        update: [
                            {
                                $set: {
                                    userId: userId,
                                    postId: postId,
                                    interactionType: interactionType,
                                    lastInteracted: new Date(),
                                    interactionCount: { $add: [{ $ifNull: ["$interactionCount", 0] }, 1] },
                                    viewDuration: { $max: [{ $ifNull: ["$viewDuration", 0] }, viewDuration] }
                                }
                            }
                        ],
                        upsert: true
                    }
                });
            } else {
                // For non-view interactions or view without duration, simple update
                bulkOps.push({
                    updateOne: {
                        filter: { userId, postId, interactionType },
                        update: {
                            $set: {
                                lastInteracted: new Date()
                            },
                            $inc: { interactionCount: 1 },
                            $setOnInsert: {
                                userId,
                                postId,
                                interactionType,
                                ...(interactionType === 'view' && { viewDuration: 0 })
                            }
                        },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await PostInteraction.bulkWrite(bulkOps);
        }

        return res.status(200).json(
            new ApiResponse(200, {}, `${bulkOps.length} interactions tracked successfully`)
        );
    } catch (error) {
        throw new ApiError(500, "Failed to track batch interactions: " + error.message);
    }
});

export const getUserInteractionHistory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId, days = 7 } = req.query;

    try {
        const dateFilter = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const filter = {
            userId,
            lastInteracted: { $gte: dateFilter }
        };

        if (postId) {
            filter.postId = postId;
        }

        const interactions = await PostInteraction.find(filter)
            .populate('postId', 'contentType createdAt')
            .sort({ lastInteracted: -1 })
            .limit(100);

        return res.status(200).json(
            new ApiResponse(200, interactions, "Interaction history retrieved successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Failed to get interaction history: " + error.message);
    }
});