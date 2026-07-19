import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import mongoose from "mongoose";

// GET /users/profile serves a Redis-cached snapshot (1h TTL); without this,
// clients re-fetching the profile right after a switch read the old
// isBusinessProfile and flip back.
const invalidateProfileCache = async (userId) => {
    const { UserCacheManager } = await import("../../utils/cache.utils.js");
    await UserCacheManager.invalidateUserProfile(userId.toString());
};

// POST /api/v1/users/switch-to-business
export const switchTobusinessprofile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    let business = await Business.findOne({ userId });

    if (business) {
        if (!user.isBusinessProfile) {
            user.isBusinessProfile = true;
            user.businessProfileId = business._id;
            await user.save();
            await invalidateProfileCache(userId);
        }

        const businessObj = business.toObject();
        if (businessObj.rating !== undefined) {
            delete businessObj.rating;
        }

        return res.status(200).json(
            new ApiResponse(200, {
                alreadyBusiness: true,
                businessProfile: businessObj,
                businessId: business._id,
                message: user.isBusinessProfile ? "Already on business profile" : "Switched to existing business profile"
            }, "Switched to business profile")
        );
    }

    let businessId = user.businessProfileId;

    if (!businessId) {
        businessId = new mongoose.Types.ObjectId();
        user.businessProfileId = businessId;
    }

    user.isBusinessProfile = true;
    await user.save();
    await invalidateProfileCache(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            alreadyBusiness: false,
            businessProfile: null,
            businessId: businessId,
            message: "Switched to business account mode. Create your business profile to get started."
        }, "Switched to business account mode")
    );
});

// POST /api/v1/business/switch-to-personal
export const switchToPersonalAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    if (!user.isBusinessProfile) {
        throw new ApiError(400, "User is already on a personal account");
    }

    user.isBusinessProfile = false;
    await user.save();
    await invalidateProfileCache(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            isBusinessProfile: false,
            message: "Successfully switched to personal account"
        }, "Switched to personal account successfully")
    );
});
