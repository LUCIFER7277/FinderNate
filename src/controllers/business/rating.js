import Business from "../../models/business.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import mongoose from "mongoose";

// POST /api/v1/business/:businessId/rate
export const rateBusiness = asyncHandler(async (req, res) => {
    const { businessId } = req.params;
    const userId = req.user._id;
    const { rating } = req.body;

    if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new ApiError(400, "Rating must be a number between 1 and 5");
    }

    const business = await Business.findById(businessId);
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    if (business.userId.toString() === userId.toString()) {
        throw new ApiError(403, "Cannot rate your own business");
    }

    const existingRating = await BusinessRating.findOne({ businessId, userId });

    if (existingRating) {
        existingRating.rating = rating;
        await existingRating.save();
    } else {
        await BusinessRating.create({ businessId, userId, rating });
    }

    const allRatings = await BusinessRating.find({ businessId });
    const totalRating = allRatings.reduce((sum, r) => sum + r.rating, 0);
    const averageRating = totalRating / allRatings.length;

    business.rating = Math.round(averageRating * 10) / 10;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            rating: existingRating ? "updated" : "created",
            businessRating: business.rating,
            totalRatings: allRatings.length
        }, `Business rating ${existingRating ? 'updated' : 'created'} successfully`)
    );
});

// GET /api/v1/business/:businessId/rating-summary
export const getBusinessRatingSummary = asyncHandler(async (req, res) => {
    const { businessId } = req.params;

    const business = await Business.findById(businessId).select('businessName rating');
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    const stats = await BusinessRating.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
        {
            $group: {
                _id: null,
                totalRatings: { $sum: 1 },
                averageRating: { $avg: '$rating' }
            }
        }
    ]);

    if (stats.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                business: {
                    businessName: business.businessName,
                    averageRating: 0,
                    totalRatings: 0
                },
                message: "No ratings yet"
            }, "Business rating summary fetched successfully")
        );
    }

    const stat = stats[0];

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                businessName: business.businessName,
                averageRating: Math.round(stat.averageRating * 10) / 10,
                totalRatings: stat.totalRatings
            }
        }, "Business rating summary fetched successfully")
    );
});
