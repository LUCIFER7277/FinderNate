import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';

export const SUBSCRIPTION_PLANS = {
    free: {
        id: 'free',
        name: 'Free',
        price: 0,
        duration: 'lifetime'
    },
    small_business: {
        id: 'small_business',
        name: 'Small Business',
        price: 1,
        duration: 'monthly'
    },
    corporate: {
        id: 'corporate',
        name: 'Corporate',
        price: 2999,
        duration: 'monthly'
    }
};

/**
 * Google Play product id → our plan tier.
 *
 * The ids are identical to the tier names on purpose, so there is one less
 * thing to keep in step, but the map is written out rather than assumed: Play
 * product ids are permanent once a product is created, so if a tier is ever
 * renamed the old id has to keep working and this is where that would live.
 *
 * Each product carries a single `monthly` base plan in Play; the billing period
 * lives on the base plan, not on the product, so it is not part of the id.
 */
export const PLAY_PRODUCT_TO_PLAN = {
    small_business: 'small_business',
    corporate: 'corporate'
};

/** The inverse, for telling the app which products to fetch from Play. */
export const PLAN_TO_PLAY_PRODUCT = Object.fromEntries(
    Object.entries(PLAY_PRODUCT_TO_PLAN).map(([productId, plan]) => [plan, productId])
);

export const getAvailablePlans = asyncHandler(async (req, res) => {
    const plans = [
        {
            id: 'free',
            name: 'Free',
            price: '₹0',
            period: 'Forever',
            features: [
                'Basic business profile',
                'Up to 10 posts per month',
                'Basic analytics',
                'Community support'
            ],
            limitations: [
                'Limited posts',
                'Basic features only',
                'No priority support'
            ],
            isCurrentPlan: true
        },
        {
            id: 'small_business',
            name: 'Small Business',
            price: '₹1',
            period: 'per month',
            features: [
                'Enhanced business profile',
                'Unlimited posts',
                'Advanced analytics',
                'Product catalog (up to 50 items)',
                'Priority support',
                'Basic advertising tools'
            ],
            recommended: true
        },
        {
            id: 'corporate',
            name: 'Corporate',
            price: '₹2999',
            period: 'per month',
            features: [
                'Premium business profile',
                'Unlimited everything',
                'Advanced analytics & insights',
                'Unlimited product catalog',
                'Dedicated account manager',
                'Advanced advertising & promotion',
                'API access',
                'White-label options'
            ],
            recommended: false
        }
    ];

    res.status(200).json(
        new ApiResponse(200, { plans }, 'Available plans fetched successfully')
    );
});
