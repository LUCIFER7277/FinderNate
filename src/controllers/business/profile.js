import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import mongoose from "mongoose";
import { BUSINESS_CATEGORIES, extractTagsFromText } from "./helpers.js";

// POST /api/v1/business/create
export const createBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    let existingBusiness = await Business.findOne({ userId });

    if (existingBusiness && existingBusiness.isProfileCompleted) {
        throw new ApiError(409, "Business profile already exists. Please use the update endpoint to modify your business details.");
    }

    const {
        businessName,
        businessType,
        description,
        category,
        subcategory,
        contact,
        location,
        rating,
        tags,
        website,
        gstNumber,
        aadhaarNumber
    } = req.body;

    if (category && !BUSINESS_CATEGORIES.includes(category)) {
        throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
    }

    const trimmedBusinessName = businessName ? businessName.trim() : '';
    const normalizedCategory = category ? category.trim() : '';
    const normalizedSubcategory = subcategory ? subcategory.trim() : '';

    if (contact && contact.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contact.email)) {
            throw new ApiError(400, "Invalid contact.email format");
        }
    }

    if (website && !/^https?:\/\/.+/.test(website)) {
        throw new ApiError(400, "Invalid website URL");
    }
    if (contact && contact.website && !/^https?:\/\/.+/.test(contact.website)) {
        throw new ApiError(400, "Invalid contact.website URL");
    }

    if (trimmedBusinessName) {
        const existingBusinessByName = await Business.findOne({ businessName: trimmedBusinessName });
        if (existingBusinessByName) {
            throw new ApiError(409, "Business name already in use");
        }
    }

    if (gstNumber) {
        if (gstNumber.length < 15) {
            throw new ApiError(400, "GST number must be at least 15 characters long");
        }
        const existingGST = await Business.findOne({ gstNumber });
        if (existingGST) {
            throw new ApiError(409, "GST number already registered");
        }
    }

    let finalTags = [];
    if (tags && Array.isArray(tags) && tags.length > 0) {
        finalTags = tags
            .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
            .map(tag => tag.toLowerCase().trim());

        if (finalTags.length === 0) {
            throw new ApiError(400, "Tags must be non-empty strings");
        }
    } else {
        const autoTags = extractTagsFromText(trimmedBusinessName, description, normalizedCategory, normalizedSubcategory);
        finalTags = autoTags.map(tag => tag.toLowerCase());
    }

    const uniqueTags = [...new Set(finalTags)];

    let resolvedLocation = location || {};
    if (location && (location.address || location.city)) {
        const locationString = [location.address, location.city, location.state, location.country]
            .filter(Boolean)
            .join(', ');

        if (locationString) {
            try {
                const coords = await getCoordinates(locationString);
                if (coords?.latitude && coords?.longitude) {
                    resolvedLocation.coordinates = {
                        type: "Point",
                        coordinates: [coords.longitude, coords.latitude]
                    };
                    resolvedLocation.isLiveLocationEnabled = true;
                    resolvedLocation.lastLocationUpdate = new Date();
                }
            } catch (error) {
                // Continue without coordinates if resolution fails
            }
        }
    }

    let business;

    if (existingBusiness) {
        existingBusiness.businessName = trimmedBusinessName;
        if (businessType) existingBusiness.businessType = businessType;
        if (description) existingBusiness.description = description;
        if (normalizedCategory) existingBusiness.category = normalizedCategory;
        if (normalizedSubcategory) existingBusiness.subcategory = normalizedSubcategory;
        if (contact) existingBusiness.contact = contact;
        if (resolvedLocation) existingBusiness.location = resolvedLocation;
        if (rating) existingBusiness.rating = rating;
        existingBusiness.tags = uniqueTags;
        if (website) existingBusiness.website = website;

        if (gstNumber && gstNumber.trim() !== '') {
            existingBusiness.gstNumber = gstNumber;
        }
        if (aadhaarNumber && aadhaarNumber.trim() !== '') {
            existingBusiness.aadhaarNumber = aadhaarNumber;
        }

        existingBusiness.isProfileCompleted = true;
        await existingBusiness.save();
        business = existingBusiness;
    } else {
        const Subscription = (await import('../../models/subscription.models.js')).default;
        const userSubscription = await Subscription.findOne({
            userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        let businessPlan = 'plan1';
        let businessSubscriptionStatus = 'pending';

        if (userSubscription) {
            if (userSubscription.plan === 'small_business') {
                businessPlan = 'plan2';
                businessSubscriptionStatus = 'active';
            } else if (userSubscription.plan === 'corporate') {
                businessPlan = 'plan3';
                businessSubscriptionStatus = 'active';
            }
        }

        const businessData = {
            userId,
            businessName: trimmedBusinessName,
            businessType,
            description,
            category: normalizedCategory,
            subcategory: normalizedSubcategory,
            contact,
            location: resolvedLocation,
            rating,
            tags: uniqueTags,
            website,
            plan: businessPlan,
            subscriptionStatus: businessSubscriptionStatus,
            isProfileCompleted: true
        };

        if (user.businessProfileId) {
            businessData._id = user.businessProfileId;
        }

        if (gstNumber && gstNumber.trim() !== '') {
            businessData.gstNumber = gstNumber;
        }
        if (aadhaarNumber && aadhaarNumber.trim() !== '') {
            businessData.aadhaarNumber = aadhaarNumber;
        }

        business = await Business.create(businessData);

        user.isBusinessProfile = true;
        if (!user.businessProfileId) {
            user.businessProfileId = business._id;
        }
        await user.save();
    }

    return res.status(existingBusiness ? 200 : 201).json(
        new ApiResponse(existingBusiness ? 200 : 201, {
            business,
            businessId: business._id,
            planSelectionRequired: true
        }, "Business profile created successfully. You can now update your business details using the update endpoint.")
    );
});

// GET /api/v1/business/profile
export const getBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId }).lean();
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const businessObj = { ...business };
    if (businessObj.rating !== undefined) {
        delete businessObj.rating;
    }

    const isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';

    return res.status(200).json(
        new ApiResponse(200, {
            business: businessObj,
            visibility: {
                isContentVisible,
                message: isContentVisible
                    ? 'Your business content is visible to all users'
                    : 'Your business content is currently hidden. Activate your payment plan to make it visible.'
            }
        }, "Business profile fetched successfully")
    );
});

// GET /api/v1/business/:id
export const getBusinessById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const business = await Business.findById(id)
        .select("-gstNumber")
        .lean();

    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const owner = await User.findById(business.userId)
        .select("username avatar fullName")
        .lean();

    if (!owner) {
        throw new ApiError(404, "Business owner not found");
    }

    const ratingStats = await BusinessRating.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(id) } },
        {
            $group: {
                _id: null,
                totalRatings: { $sum: 1 },
                averageRating: { $avg: '$rating' }
            }
        }
    ]);

    const ratingInfo = ratingStats.length > 0 ? {
        averageRating: Math.round(ratingStats[0].averageRating * 10) / 10,
        totalRatings: ratingStats[0].totalRatings
    } : {
        averageRating: 0,
        totalRatings: 0
    };

    const isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                ...business,
                rating: ratingInfo.averageRating,
                totalRatings: ratingInfo.totalRatings
            },
            owner,
            visibility: {
                isContentVisible,
                message: isContentVisible
                    ? 'Business content is visible'
                    : 'Business content is currently hidden due to inactive payment plan'
            }
        }, "Business profile fetched successfully")
    );
});

// PATCH /api/v1/business/update
export const updateBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const {
        businessName,
        businessType,
        description,
        category,
        subcategory,
        contact,
        location,
        website,
        tags,
        gstNumber,
        aadhaarNumber
    } = req.body;

    if (businessName) {
        const trimmedBusinessName = businessName.trim();
        const existingBusinessByName = await Business.findOne({
            businessName: trimmedBusinessName,
            userId: { $ne: userId }
        });

        if (existingBusinessByName) {
            throw new ApiError(409, "Business name already in use");
        }

        business.businessName = trimmedBusinessName;
    }

    if (gstNumber !== undefined) {
        if (gstNumber && gstNumber.trim() !== '') {
            if (gstNumber.length < 15) {
                throw new ApiError(400, "GST number must be at least 15 characters long");
            }

            const existingGST = await Business.findOne({
                gstNumber,
                userId: { $ne: userId }
            });
            if (existingGST) {
                throw new ApiError(409, "GST number already registered");
            }
            business.gstNumber = gstNumber;
        } else {
            business.gstNumber = undefined;
        }
    }

    if (aadhaarNumber !== undefined) {
        if (aadhaarNumber && aadhaarNumber.trim() !== '') {
            business.aadhaarNumber = aadhaarNumber;
        } else {
            business.aadhaarNumber = undefined;
        }
    }

    if (category) {
        if (!BUSINESS_CATEGORIES.includes(category)) {
            throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
        }
        business.category = category.trim();
    }

    if (subcategory) {
        business.subcategory = subcategory.trim();
    }

    if (businessType) business.businessType = businessType;
    if (description) business.description = description;

    if (location) {
        let resolvedLocation = { ...business.location, ...location };

        if (location.address || location.city || location.state || location.country) {
            const locationString = [
                resolvedLocation.address,
                resolvedLocation.city,
                resolvedLocation.state,
                resolvedLocation.country
            ].filter(Boolean).join(', ');

            if (locationString) {
                try {
                    const coords = await getCoordinates(locationString);
                    if (coords?.latitude && coords?.longitude) {
                        resolvedLocation.coordinates = {
                            type: "Point",
                            coordinates: [coords.longitude, coords.latitude]
                        };
                        resolvedLocation.isLiveLocationEnabled = true;
                        resolvedLocation.lastLocationUpdate = new Date();
                    }
                } catch (error) {
                    // Continue without updating coordinates if resolution fails
                }
            }
        }

        business.location = resolvedLocation;
    }

    if (contact) {
        if (contact.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(contact.email)) {
                throw new ApiError(400, "Invalid contact.email format");
            }
        }

        if (contact.website && !/^https?:\/\/.+/.test(contact.website)) {
            throw new ApiError(400, "Invalid contact.website URL");
        }

        business.contact = { ...business.contact, ...contact };
    }

    if (website) {
        if (!/^https?:\/\/.+/.test(website)) {
            throw new ApiError(400, "Invalid website URL");
        }
        business.website = website;
    }

    if (tags && Array.isArray(tags)) {
        if (tags.length > 0) {
            const manualTags = tags
                .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
                .map(tag => tag.toLowerCase().trim());

            if (manualTags.length === 0) {
                throw new ApiError(400, "Tags must be non-empty strings");
            }

            business.tags = [...new Set(manualTags)];
        } else {
            const autoTags = extractTagsFromText(
                business.businessName,
                business.description,
                business.category,
                business.subcategory
            );
            business.tags = [...new Set(autoTags.map(tag => tag.toLowerCase()))];
        }
    }

    await business.save();

    const businessObj = business.toObject();
    delete businessObj.rating;

    return res.status(200).json(
        new ApiResponse(200, { business: businessObj }, "Business profile updated successfully")
    );
});

// DELETE /api/v1/business/delete
export const deleteBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const { default: Post } = await import("../../models/userPost.models.js");
    const deletedPosts = await Post.deleteMany({ userId, contentType: 'business' });

    await Business.deleteOne({ userId });

    user.isBusinessProfile = false;
    user.businessProfileId = undefined;
    await user.save();

    return res.status(200).json(
        new ApiResponse(200, {
            deletedPostsCount: deletedPosts.deletedCount
        }, `Business profile and ${deletedPosts.deletedCount} business posts deleted successfully`)
    );
});

// GET /api/v1/business/my-category
export const getMyBusinessCategory = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId }).select('category subcategory businessName').lean();
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            category: business.category,
            subcategory: business.subcategory,
            businessName: business.businessName
        }, "Business category and subcategory fetched successfully")
    );
});

// PATCH /api/v1/business/update-category
export const updateBusinessCategory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { category, subcategory } = req.body;

    if (!category) {
        throw new ApiError(400, "Category is required");
    }

    if (!BUSINESS_CATEGORIES.includes(category)) {
        throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
    }

    let business = await Business.findOne({ userId });

    if (!business) {
        business = await Business.create({
            userId,
            category: category.trim(),
            subcategory: subcategory ? subcategory.trim() : undefined,
            plan: 'plan1',
            subscriptionStatus: 'active'
        });

        const user = await User.findById(userId);
        if (user) {
            user.isBusinessProfile = true;
            user.businessProfileId = business._id;
            await user.save();
        }

        const businessObj = business.toObject();
        delete businessObj.rating;

        return res.status(201).json(
            new ApiResponse(201, {
                business: businessObj,
                updatedCategory: business.category,
                updatedSubcategory: business.subcategory,
                message: "Business profile created with category"
            }, "Business category set successfully")
        );
    }

    business.category = category.trim();
    if (subcategory) {
        business.subcategory = subcategory.trim();
    }
    await business.save();

    const businessObj = business.toObject();
    delete businessObj.rating;

    return res.status(200).json(
        new ApiResponse(200, {
            business: businessObj,
            updatedCategory: business.category,
            updatedSubcategory: business.subcategory
        }, "Business category updated successfully")
    );
});

// GET /api/v1/business/categories
export const getBusinessCategories = asyncHandler(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, {
            categories: BUSINESS_CATEGORIES,
            totalCategories: BUSINESS_CATEGORIES.length
        }, "Business categories fetched successfully")
    );
});
