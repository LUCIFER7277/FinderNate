import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import PostInteraction from "../models/postInteraction.models.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

const VALID_INTERACTION_TYPES = ['view', 'like', 'comment', 'share', 'click', 'hide'];

// Ceiling on one batch. The batch endpoint used to accept an array of any
// length, so a single authenticated request could hand bulkWrite hundreds of
// thousands of upserts and sit on a connection while it worked through them —
// a cheap way to saturate the collection the feed and the TTL cleanup share.
// Clients batch a screenful of view events at a time; 200 is far above that.
const MAX_BATCH_INTERACTIONS = 200;

export const trackPostInteraction = asyncHandler(async (req, res) => {
    const { postId, interactionType, viewDuration = 0 } = req.body;
    const userId = req.user._id;

    if (!postId || !interactionType) {
        throw new ApiError(400, "postId and interactionType are required");
    }

    if (!VALID_INTERACTION_TYPES.includes(interactionType)) {
        throw new ApiError(400, "Invalid interaction type");
    }

    // The same guard the batch endpoint applies: a malformed id would otherwise
    // reach the upsert and come back as a CastError wrapped in a 500.
    if (!mongoose.Types.ObjectId.isValid(postId)) {
        throw new ApiError(400, "Invalid post ID format");
    }

    try {
        // One atomic upsert instead of findOne-then-save.
        //
        // The read and the write used to be two round trips, so two taps landing
        // together both saw "no row yet" and both inserted — the same
        // {userId, postId, interactionType} triple stored twice, splitting the
        // interaction count across rows and double-counting the post in every
        // aggregate built on this collection. Letting the server do the match
        // and the write in one operation closes that window.
        //
        // $max carries the viewDuration rule (keep the longest view) without a
        // read, and works on insert too, so no $setOnInsert is needed for it —
        // which is what the batch endpoint's $max/$setOnInsert conflict was
        // about. Everything else (viewDuration 0, isHidden false) still comes
        // from the schema defaults Mongoose applies on upsert.
        const update = {
            $set: { lastInteracted: new Date() },
            $inc: { interactionCount: 1 },
            $setOnInsert: { userId, postId, interactionType }
        };

        if (viewDuration > 0) {
            update.$max = { viewDuration };
        }

        await PostInteraction.updateOne(
            { userId, postId, interactionType },
            update,
            { upsert: true }
        );

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

    if (interactions.length > MAX_BATCH_INTERACTIONS) {
        throw new ApiError(400, `A batch may contain at most ${MAX_BATCH_INTERACTIONS} interactions, but ${interactions.length} were sent.`);
    }

    try {
        const bulkOps = [];

        for (const interaction of interactions) {
            const { postId, interactionType, viewDuration } = interaction;

            if (!postId || !interactionType) continue;

            // The same whitelist the single-interaction endpoint enforces. It
            // was missing here, so anything at all became an upsert whose
            // schema validation failure surfaced only as a 500 carrying the raw
            // Mongo error.
            if (!VALID_INTERACTION_TYPES.includes(interactionType)) {
                throw new ApiError(400, "Invalid interaction type");
            }

            // A malformed id would otherwise reach bulkWrite and fail the whole
            // batch with a CastError dressed up as a 500.
            if (!mongoose.Types.ObjectId.isValid(postId)) {
                throw new ApiError(400, "Invalid post ID format");
            }

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
        // Rethrow the deliberate 400s above untouched — this catch used to
        // relabel them as 500s, so "viewDuration is not allowed for like
        // interactions" reached the client as a server error.
        if (error instanceof ApiError) throw error;
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