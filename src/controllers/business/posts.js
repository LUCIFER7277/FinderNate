import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

async function findOrCreateMinimalBusiness(businessId, userId) {
    let business = await Business.findById(businessId);

    if (!business) {
        // 'pending', not 'active': the pre-save hook in business.models.js turns
        // a transition into 'active' — including on a brand new document — into
        // isVerified:true, which is the public verification badge an admin is
        // supposed to grant only after reviewing the seller's ID. This row is a
        // placeholder created so post settings have somewhere to live; it has
        // been through no verification at all. Entitlements are unaffected, they
        // all require plan !== 'plan1'.
        business = await Business.create({
            _id: businessId,
            userId,
            plan: 'plan1',
            subscriptionStatus: 'pending'
        });
    }

    if (!business.postSettings) {
        business.postSettings = {
            allowProductPosts: true,
            allowServicePosts: true
        };
    }

    return business;
}

// POST /api/v1/business/toggle-product-posts
export const toggleProductPosts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { businessId } = req.body;

    if (!businessId) {
        throw new ApiError(400, "Business ID is required");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId || user.businessProfileId.toString() !== businessId) {
        throw new ApiError(403, "Unauthorized to toggle product posts for this business");
    }

    const business = await findOrCreateMinimalBusiness(businessId, userId);

    const currentState = business.postSettings.allowProductPosts ?? true;
    business.postSettings.allowProductPosts = !currentState;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            allowProductPosts: business.postSettings.allowProductPosts,
            businessId: business._id
        }, `Product posts ${business.postSettings.allowProductPosts ? 'enabled' : 'disabled'} successfully`)
    );
});

// POST /api/v1/business/toggle-service-posts
export const toggleServicePosts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { businessId } = req.body;

    if (!businessId) {
        throw new ApiError(400, "Business ID is required");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId || user.businessProfileId.toString() !== businessId) {
        throw new ApiError(403, "Unauthorized to toggle service posts for this business");
    }

    const business = await findOrCreateMinimalBusiness(businessId, userId);

    const currentState = business.postSettings.allowServicePosts ?? true;
    business.postSettings.allowServicePosts = !currentState;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            allowServicePosts: business.postSettings.allowServicePosts,
            businessId: business._id
        }, `Service posts ${business.postSettings.allowServicePosts ? 'enabled' : 'disabled'} successfully`)
    );
});
