import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';

// Fixed store owner — hardcoded in DB query, never exposed via client params
const STORE_USER_ID = new mongoose.Types.ObjectId('69ba39e7ee60e4c9277fb780');

/**
 * GET /api/v1/posts/online-store/products
 * Public endpoint — no auth required.
 * Always fetches contentType=product for the fixed store owner.
 *
 * Query params:
 *   page        {number}  default 1
 *   limit       {number}  default 12, max 50
 *   search      {string}  searches product name, description, category
 *   category    {string}  exact category filter
 *   minPrice    {number}
 *   maxPrice    {number}
 *   sortBy      {string}  popular | rating | price-low | price-high
 */
export const getOnlineStoreProducts = asyncHandler(async (req, res) => {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
    const skip     = (page - 1) * limit;
    const search   = req.query.search?.trim();
    const category = req.query.category?.trim();
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    const sortBy   = req.query.sortBy || 'popular';

    // ── Base filter ──────────────────────────────────────────────────────────
    const filter = {
        userId:             STORE_USER_ID,
        contentType:        'product',
        'settings.privacy': { $ne: 'private' }  // Never show private product posts
    };

    // ── Search (name, description, category) ────────────────────────────────
    if (search) {
        const regex = new RegExp(search, 'i');
        filter.$or = [
            { 'customization.product.name':        regex },
            { 'customization.product.description': regex },
            { 'customization.product.category':    regex },
            { caption:                             regex },
        ];
    }

    // ── Category filter ──────────────────────────────────────────────────────
    if (category) {
        filter['customization.product.category'] = new RegExp(`^${category}$`, 'i');
    }

    // ── Price range filter ───────────────────────────────────────────────────
    if (minPrice !== null || maxPrice !== null) {
        filter['customization.product.price'] = {};
        if (minPrice !== null) filter['customization.product.price'].$gte = minPrice;
        if (maxPrice !== null) filter['customization.product.price'].$lte = maxPrice;
    }

    // ── Sort ─────────────────────────────────────────────────────────────────
    let sort = {};
    switch (sortBy) {
        case 'rating':      sort = { 'engagement.likes': -1 };                      break;
        case 'price-low':   sort = { 'customization.product.price':  1 };           break;
        case 'price-high':  sort = { 'customization.product.price': -1 };           break;
        case 'popular':
        default:            sort = { 'engagement.views': -1, createdAt: -1 };       break;
    }

    // ── Execute queries in parallel ──────────────────────────────────────────
    const [posts, totalCount, allCategories] = await Promise.all([
        Post.find(filter).sort(sort).skip(skip).limit(limit).lean(),
        Post.countDocuments(filter),
        // Fetch all distinct categories for the store (unfiltered, for the filter UI)
        Post.distinct('customization.product.category', {
            userId:      STORE_USER_ID,
            contentType: 'product',
            status:      'published',
        }),
    ]);

    // ── Shape response ───────────────────────────────────────────────────────
    const products = posts.map((post) => {
        const p = post.customization?.product || {};
        const image =
            (p.images && p.images[0]) ||
            post.media?.[0]?.url ||
            '';

        return {
            _id:             post._id,
            name:            p.name            || post.caption || 'Product',
            category:        p.category        || '',
            price:           p.price           ?? 0,
            originalPrice:   p.price           ?? 0,   // extend if you add MRP field
            description:     p.description     || post.description || '',
            rating:          0,                         // extend when reviews are wired up
            image,
            inStock:         p.inStock         ?? true,
            discount:        0,                         // extend if discount field is added
            gstPercent:      p.gstPercent      ?? 5,
            shippingCharges: p.shippingCharges ?? 0,
        };
    });

    const categories = allCategories.filter(Boolean).sort();

    return res.status(200).json(
        new ApiResponse(200, {
            products,
            totalCount,
            totalPages:  Math.ceil(totalCount / limit),
            currentPage: page,
            categories,
        }, 'Store products fetched successfully')
    );
});
