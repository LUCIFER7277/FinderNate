import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import Post from '../models/userPost.models.js';
import SearchSuggestion from '../models/searchSuggestion.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTypesenseEnabled } from '../config/typesense.config.js';
import {
    instantSearch as tsInstantSearch,
    searchProfiles as tsSearchProfiles,
    searchContent as tsSearchContent,
} from '../services/typesense/index.js';

/* --------------------------------- helpers -------------------------------- */

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const toFloat = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
};

// Only surface public, published content in search (mirrors the Typesense `isPublic`
// mapping: privacy !== 'private' && status not in [draft, archived]).
const PUBLIC_POST_FILTER = {
    'settings.privacy': { $ne: 'private' },
    status: { $nin: ['draft', 'archived'] },
};

/**
 * Canonical product-card shape. BOTH the Typesense path (via the service) and these
 * Mongo fallbacks must return the exact same keys so the frontend renders identically
 * whether or not Typesense is up. (Fallback can't cheaply join the author, so the
 * seller fields are null.)
 */
const postToProductCard = (p) => {
    const prod = p.customization?.product || {};
    return {
        _id: p._id,
        name: prod.name || null,
        image: (Array.isArray(prod.images) && prod.images[0]) || p.media?.[0]?.thumbnailUrl || p.media?.[0]?.url || null,
        price: Number.isFinite(prod.price) ? prod.price : null,
        currency: prod.currency || null,
        category: prod.category || null,
        subcategory: prod.subcategory || null,
        brand: prod.brand || null,
        tags: Array.isArray(prod.tags) ? prod.tags : [],
        locationCity: prod.location?.city || null,
        username: null,
        userProfileImageUrl: null,
        contentType: p.contentType || null,
    };
};

/* --------------------------- MongoDB fallbacks ----------------------------- */

const mongoInstantFallback = async (query, blockedUsers, limit) => {
    const rx = new RegExp('^' + escapeRegex(query), 'i'); // prefix match
    const [users, products] = await Promise.all([
        User.find({
            $or: [{ username: rx }, { fullName: rx }],
            accountStatus: 'active',
            _id: { $nin: blockedUsers },
        })
            .limit(limit)
            .select('username fullName profileImageUrl isBusinessProfile isBlueTickVerified')
            .lean(),
        Post.find({
            contentType: 'product',
            ...PUBLIC_POST_FILTER,
            $or: [
                { 'customization.product.name': rx },
                { 'customization.product.brand': rx },
                { 'customization.product.tags': rx },
            ],
        })
            .limit(limit)
            .select('customization.product media userId contentType')
            .lean(),
    ]);

    return {
        users: users.map((u) => ({
            _id: u._id,
            username: u.username,
            fullName: u.fullName,
            profileImageUrl: u.profileImageUrl || null,
            isBusinessProfile: !!u.isBusinessProfile,
            isBlueTickVerified: !!u.isBlueTickVerified,
            isBusinessVerified: false,
            businessName: null,
            businessCategory: null,
        })),
        products: products.map(postToProductCard),
    };
};

/* -------------------------------- endpoints -------------------------------- */

/**
 * GET /api/v1/users/search/instant?q=...&limit=6
 * Instant typeahead: matching profiles (name + photo) + products + keyword
 * completions, in one fast round trip. Falls back to Mongo if Typesense is off.
 */
export const instantSearch = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const limit = Math.min(toInt(req.query.limit, 6), 15);
    if (query.length < 1) throw new ApiError(400, "Search query 'q' is required");

    const blockedUsers = req.blockedUsers || [];

    // Keyword completions from popularity history (cheap prefix scan).
    const keywordsPromise = SearchSuggestion.find({
        keyword: { $regex: '^' + escapeRegex(query.toLowerCase()) },
    })
        .sort({ searchCount: -1, lastSearched: -1 })
        .limit(6)
        .select('keyword')
        .lean()
        .then((rows) => rows.map((r) => r.keyword))
        .catch(() => []);

    let data = null;
    if (isTypesenseEnabled) {
        try {
            data = await tsInstantSearch({
                q: query,
                blockedUserIds: blockedUsers,
                userLimit: limit,
                productLimit: limit,
            });
        } catch (err) {
            console.error('instantSearch: Typesense failed, falling back to Mongo:', err.message);
        }
    }
    if (!data) data = await mongoInstantFallback(query, blockedUsers, limit);

    const keywords = await keywordsPromise;

    return res.status(200).json(
        new ApiResponse(200, { users: data.users, products: data.products, keywords }, 'Instant search results')
    );
});

/**
 * GET /api/v1/users/search/profiles?q=...&page=1&limit=20
 * Fast, typo-tolerant profile search ranked by relevance + followers.
 */
export const searchProfiles = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const page = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(toInt(req.query.limit, 20), 50);
    if (!query) throw new ApiError(400, "Search query 'q' is required");

    const blockedUsers = req.blockedUsers || [];

    if (isTypesenseEnabled) {
        try {
            const r = await tsSearchProfiles({ q: query, blockedUserIds: blockedUsers, page, perPage: limit });
            if (r) {
                const users = r.docs.map((d) => ({
                    _id: d.id,
                    username: d.username,
                    fullName: d.fullName || null,
                    profileImageUrl: d.profileImageUrl || null,
                    bio: d.bio || null,
                    location: d.location || null,
                    isBusinessProfile: !!d.isBusinessProfile,
                    isBlueTickVerified: !!d.isBlueTickVerified,
                    isBusinessVerified: !!d.isBusinessVerified,
                    businessName: d.businessName || null,
                    businessCategory: d.businessCategory || null,
                    followersCount: d.followersCount || 0,
                }));
                return res.status(200).json(new ApiResponse(200, {
                    users,
                    pagination: { page: r.page, limit, total: r.found, totalPages: Math.ceil(r.found / limit) },
                }, 'Profile search results'));
            }
        } catch (err) {
            console.error('searchProfiles: Typesense failed, falling back to Mongo:', err.message);
        }
    }

    // Mongo fallback — normalized to the same user shape as the Typesense path.
    const rx = new RegExp(escapeRegex(query), 'i');
    const filter = {
        $or: [{ username: rx }, { fullName: rx }, { bio: rx }, { location: rx }],
        accountStatus: 'active',
        _id: { $nin: blockedUsers },
    };
    const [rows, total] = await Promise.all([
        User.find(filter)
            .skip((page - 1) * limit)
            .limit(limit)
            .select('username fullName profileImageUrl bio location isBusinessProfile isBlueTickVerified')
            .lean(),
        User.countDocuments(filter),
    ]);
    const users = rows.map((u) => ({
        _id: u._id,
        username: u.username,
        fullName: u.fullName || null,
        profileImageUrl: u.profileImageUrl || null,
        bio: u.bio || null,
        location: u.location || null,
        isBusinessProfile: !!u.isBusinessProfile,
        isBlueTickVerified: !!u.isBlueTickVerified,
        isBusinessVerified: false,
        businessName: null,
        businessCategory: null,
        followersCount: 0,
    }));
    return res.status(200).json(new ApiResponse(200, {
        users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Profile search results'));
});

/**
 * GET /api/v1/users/search/products?q=...&category=&brand=&minPrice=&maxPrice=&city=&country=&lat=&lng=&radius=&sort=&page=&limit=
 * Fast product search with filters, facets and optional geo.
 */
export const searchProducts = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const page = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(toInt(req.query.limit, 20), 50);

    const filters = {
        category: req.query.category || undefined,
        subcategory: req.query.subcategory || undefined,
        brand: req.query.brand || undefined,
        city: req.query.city || undefined,
        country: req.query.country || undefined,
        minPrice: toFloat(req.query.minPrice),
        maxPrice: toFloat(req.query.maxPrice),
    };
    const lat = toFloat(req.query.lat), lng = toFloat(req.query.lng);
    const geo = (Number.isFinite(lat) && Number.isFinite(lng))
        ? { lat, lng, radiusKm: toFloat(req.query.radius) || 25 }
        : null;

    if (isTypesenseEnabled) {
        try {
            const r = await tsSearchContent({
                q: query,
                contentType: 'product',
                filters,
                geo,
                page,
                perPage: limit,
                sortBy: req.query.sort || 'relevance',
            });
            if (r) {
                return res.status(200).json(new ApiResponse(200, {
                    products: r.products,
                    facets: r.facets,
                    pagination: { page: r.page, limit, total: r.found, totalPages: Math.ceil(r.found / limit) },
                }, 'Product search results'));
            }
        } catch (err) {
            console.error('searchProducts: Typesense failed, falling back to Mongo:', err.message);
        }
    }

    // Mongo fallback (no facets/typo tolerance) — same product-card shape + privacy guard.
    const filter = { contentType: 'product', ...PUBLIC_POST_FILTER };
    if (query) {
        const rx = new RegExp(escapeRegex(query), 'i');
        filter.$or = [
            { 'customization.product.name': rx },
            { 'customization.product.brand': rx },
            { 'customization.product.category': rx },
            { 'customization.product.tags': rx },
            { caption: rx },
        ];
    }
    if (filters.category) filter['customization.product.category'] = filters.category;
    if (filters.brand) filter['customization.product.brand'] = filters.brand;
    if (Number.isFinite(filters.minPrice) || Number.isFinite(filters.maxPrice)) {
        filter['customization.product.price'] = {};
        if (Number.isFinite(filters.minPrice)) filter['customization.product.price'].$gte = filters.minPrice;
        if (Number.isFinite(filters.maxPrice)) filter['customization.product.price'].$lte = filters.maxPrice;
    }
    const [posts, total] = await Promise.all([
        Post.find(filter).skip((page - 1) * limit).limit(limit)
            .select('customization.product media userId contentType').lean(),
        Post.countDocuments(filter),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        products: posts.map(postToProductCard),
        facets: [],
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Product search results'));
});
