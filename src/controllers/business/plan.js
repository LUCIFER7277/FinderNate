import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const ALL_PLANS = ['plan1', 'plan2', 'plan3', 'plan4'];

const PLAN_ALLOWED_UPGRADES = {
    plan1: ['plan2', 'plan3', 'plan4'],
    plan2: ['plan3', 'plan4'],
    plan3: ['plan4'],
    plan4: []
};

const LEGACY_PLAN_MAP = {
    'Free': 'plan1',
    'Small Business': 'plan2',
    'Corporate': 'plan3',
    'Enterprise': 'plan4'
};

// POST /api/v1/business/select-plan
export const selectBusinessPlan = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    if (!ALL_PLANS.includes(plan)) {
        throw new ApiError(400, 'Invalid plan selected');
    }

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, 'Business profile not found');
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    if (!user.isBusinessProfile) {
        throw new ApiError(403, 'Only business accounts can select a plan');
    }

    let currentPlan = business.plan || 'plan1';
    if (LEGACY_PLAN_MAP[currentPlan]) {
        currentPlan = LEGACY_PLAN_MAP[currentPlan];
    }

    const allowedUpgrades = PLAN_ALLOWED_UPGRADES[currentPlan] ?? [];

    if (!allowedUpgrades.includes(plan)) {
        const errorMessage = currentPlan === 'plan4'
            ? 'plan4 is the highest tier plan. No further upgrades available.'
            : `Cannot upgrade from ${currentPlan} to ${plan}. Allowed upgrades: ${allowedUpgrades.join(', ')}`;

        throw new ApiError(400, errorMessage);
    }

    const previousPlan = currentPlan;

    business.plan = plan;
    business.subscriptionStatus = 'active';
    await business.save();

    const businessObj = business.toObject();
    delete businessObj.rating;

    return res.status(200).json(
        new ApiResponse(200, {
            business: businessObj,
            plan: business.plan,
            subscriptionStatus: business.subscriptionStatus,
            allowedUpgrades: PLAN_ALLOWED_UPGRADES[plan] ?? [],
            previousPlan
        }, 'Plan selected successfully')
    );
});

// Helper route: update existing businesses with active subscriptions to verified status
export const updateExistingActiveBusinesses = asyncHandler(async (req, res) => {
    try {
        const result = await Business.updateMany(
            { subscriptionStatus: 'active', isVerified: false },
            { isVerified: true }
        );

        return res.status(200).json(
            new ApiResponse(200, {
                modifiedCount: result.modifiedCount,
                matchedCount: result.matchedCount
            }, `Updated ${result.modifiedCount} businesses with active subscriptions to verified status`)
        );
    } catch (error) {
        throw new ApiError(500, "Error updating existing businesses: " + error.message);
    }
});
