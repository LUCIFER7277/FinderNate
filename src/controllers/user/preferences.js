import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";

/**
 * The value a toggle endpoint should write.
 *
 * These endpoints were flip-only: they ignored the body and inverted whatever
 * was stored. A retried request, a double tap, or two screens open at once
 * therefore landed on the opposite of what the user asked for, and the switch
 * "would not stay". An explicit boolean in the body now wins; sending nothing
 * still flips, so already-deployed clients keep working.
 */
const resolveToggleValue = (body, currentSetting) => {
    const explicit = [body?.enableAutoFill, body?.enabled, body?.isEnabled]
        .find(value => typeof value === 'boolean');
    return typeof explicit === 'boolean' ? explicit : !currentSetting;
};

const invalidateProfileCaches = async (userId) => {
    const { UserCacheManager } = await import('../../utils/cache.utils.js');
    await UserCacheManager.invalidateUserProfile(userId.toString()).catch(() => {});
};

const toggleServiceAutoFill = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    const currentSetting = user.servicePostPreferences?.enableAutoFill ?? true;
    user.servicePostPreferences = { enableAutoFill: resolveToggleValue(req.body, currentSetting) };

    await user.save({ validateBeforeSave: false });
    await invalidateProfileCaches(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            enableAutoFill: user.servicePostPreferences.enableAutoFill
        }, "Service auto-fill preference updated successfully")
    );
});

const getPreviousServicePostData = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId).select('servicePostPreferences');
    const autoFillEnabled = user?.servicePostPreferences?.enableAutoFill ?? true;

    if (!autoFillEnabled) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: false, data: null }, "Auto-fill is disabled")
        );
    }

    const latestServicePost = await Post.findOne({ userId, contentType: "service" })
        .sort({ createdAt: -1 })
        .select('customization.service')
        .lean();

    if (!latestServicePost || !latestServicePost.customization?.service) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: true, data: null }, "No previous service post found")
        );
    }

    const serviceData = latestServicePost.customization.service;
    const autoFillData = {
        serviceName: serviceData.serviceName || "",
        currency: serviceData.currency || "INR",
        description: serviceData.description || "",
        price: serviceData.price || null,
        location: serviceData.location || null
    };

    return res.status(200).json(
        new ApiResponse(200, { autoFillEnabled: true, data: autoFillData }, "Previous service post data retrieved successfully")
    );
});

const toggleProductAutoFill = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    const currentSetting = user.productPostPreferences?.enableAutoFill ?? true;
    user.productPostPreferences = { enableAutoFill: resolveToggleValue(req.body, currentSetting) };

    await user.save({ validateBeforeSave: false });
    await invalidateProfileCaches(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            enableAutoFill: user.productPostPreferences.enableAutoFill
        }, "Product auto-fill preference updated successfully")
    );
});

const getPreviousProductPostData = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const user = await User.findById(userId).select('productPostPreferences');
    const autoFillEnabled = user?.productPostPreferences?.enableAutoFill ?? true;

    if (!autoFillEnabled) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: false, data: null }, "Auto-fill is disabled")
        );
    }

    const latestProductPost = await Post.findOne({ userId, contentType: "product" })
        .sort({ createdAt: -1 })
        .select('customization.product')
        .lean();

    if (!latestProductPost || !latestProductPost.customization?.product) {
        return res.status(200).json(
            new ApiResponse(200, { autoFillEnabled: true, data: null }, "No previous product post found")
        );
    }

    const productData = latestProductPost.customization.product;
    const autoFillData = {
        productName: productData.name || "",
        currency: productData.currency || "INR",
        description: productData.description || "",
        price: productData.price || null,
        brand: productData.brand || "",
        category: productData.category || "",
        subcategory: productData.subcategory || "",
        location: productData.location || null
    };

    return res.status(200).json(
        new ApiResponse(200, { autoFillEnabled: true, data: autoFillData }, "Previous product post data retrieved successfully")
    );
});

export {
    toggleServiceAutoFill,
    getPreviousServicePostData,
    toggleProductAutoFill,
    getPreviousProductPostData,
};
