import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import Feedback from "../models/feedback.models.js";
import { User } from "../models/user.models.js";
import mongoose from "mongoose";

// Submit feedback (User endpoint)
const submitFeedback = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    const { message } = req.body;

    // Validation
    if (!message || message.trim().length === 0) {
        throw new ApiError(400, "Message is required");
    }

    if (message.trim().length > 1000) {
        throw new ApiError(400, "Message must be less than 1000 characters");
    }

    try {
        const feedback = await Feedback.create({
            userId,
            message: message.trim()
        });

        const populatedFeedback = await Feedback.findById(feedback._id)
            .populate('userId', 'username fullName email profileImageUrl');

        return res.status(201).json(
            new ApiResponse(201, populatedFeedback, "Feedback submitted successfully")
        );
    } catch (error) {
        console.error('Error submitting feedback:', error);
        throw new ApiError(500, "Failed to submit feedback");
    }
});

// Get all feedback (Admin only)
const getAllFeedback = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const MAX_LIMIT = 100; // Prevent excessive data requests
    const requestedLimit = parseInt(req.query.limit) || 20;
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const skip = (page - 1) * limit;

    try {
        const feedback = await Feedback.find()
            .populate('userId', 'username fullName email profileImageUrl')
            .sort({ submittedAt: -1 })
            .limit(limit)
            .skip(skip);

        const total = await Feedback.countDocuments();

        return res.status(200).json(
            new ApiResponse(200, {
                feedback,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(total / limit),
                    totalItems: total,
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            }, "All feedback retrieved successfully")
        );
    } catch (error) {
        console.error('Error retrieving all feedback:', error);
        throw new ApiError(500, "Failed to retrieve feedback");
    }
});

// Delete feedback (Admin only)
const deleteFeedback = asyncHandler(async (req, res) => {
    const { feedbackId } = req.params;

    if (!mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback ID");
    }

    try {
        const feedback = await Feedback.findByIdAndDelete(feedbackId);

        if (!feedback) {
            throw new ApiError(404, "Feedback not found");
        }

        return res.status(200).json(
            new ApiResponse(200, { deletedId: feedbackId }, "Feedback deleted successfully")
        );
    } catch (error) {
        console.error('Error deleting feedback:', error);
        throw new ApiError(500, "Failed to delete feedback");
    }
});

export {
    submitFeedback,
    getAllFeedback,
    deleteFeedback
};