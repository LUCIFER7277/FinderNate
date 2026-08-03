import mongoose from 'mongoose';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import Post from '../models/userPost.models.js';
import SearchSuggestion from '../models/searchSuggestion.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTypesenseEnabled } from '../config/typesense.config.js';
import { getBlockedUsersFilter } from '../middlewares/blocking.middleware.js';
import {
    instantSearch as tsInstantSearch,
    searchProfiles as tsSearchProfiles,
    searchContent as tsSearchContent,
} from '../services/typesense/index.js';

/* --------------------------------- helpers -------------------------------- */

/**
 * Blocked-user ids for this request, whichever way the route was wired.
 *
 * /search/instant and /search/profiles run getBlockedUsers, so req.blockedUsers
 * is already there. /search/products does NOT — and the controller ignored
 * blocking entirely, so a blocked seller's products stayed in the results even
 * though the same person's profile was correctly filtered out of the profile
 * search two lines away. Reuses the existing cached helper rather than adding a
 * second definition of "blocked".
 */
const resolveBlockedUsers = async (req) => {
    if (Array.isArray(req.blockedUsers)) return req.blockedUsers;
    const userId = req.user?._id;
    if (!userId) return [];
    const filter = await getBlockedUsersFilter(userId);
    return filter?._id?.$nin || [];
};

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
 * whether or not Typesense is up. Seller fields are filled when the caller joined the
 * author into `_author` (searchProducts does); the cheap typeahead fallback does not,
 * and leaves them null.
 */
const postToProductCard = (p) => {
    const prod = p.customization?.product || {};
    const author = Array.isArray(p._author) ? p._author[0] : p._author;
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
        username: author?.username || null,
        userProfileImageUrl: author?.profileImageUrl || null,
        contentType: p.contentType || null,
    };
};

/**
 * Typesense answered, but with nothing.
 *
 * The read helpers return null only when the integration is switched off; a
 * live-but-EMPTY collection answers `found: 0` and the controllers used to hand
 * that straight back as "no results". Nothing keeps the index populated on its
 * own — `ensureCollections()` creates the collections empty at boot and the
 * backfill/sync scripts are run by hand — so an un-backfilled or half-synced
 * deployment reported "no products" for every query while the same products sat
 * in MongoDB, reachable by the fallback two lines below. Treating an empty
 * engine result as "ask MongoDB too" costs one extra query on genuinely empty
 * searches and removes that whole class of silent blank screen.
 */
const isEmptyTsResult = (r) => !r || !r.found;

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
    // Empty on BOTH sides means the index has nothing to say — see isEmptyTsResult.
    if (!data || (data.users.length === 0 && data.products.length === 0)) {
        data = await mongoInstantFallback(query, blockedUsers, limit);
    }

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
            if (!isEmptyTsResult(r)) {
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

    const blockedUsers = await resolveBlockedUsers(req);

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
                blockedUserIds: blockedUsers,
            });
            if (!isEmptyTsResult(r)) {
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
    //* $match inside an aggregation does NOT run mongoose's caster, so a blocked
    //* id left as a string would compare unequal to every ObjectId and quietly
    //* exclude nobody. Cast up front; countDocuments below is happy either way.
    const blockedObjectIds = blockedUsers
        .map((id) => {
            try { return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id; }
            catch { return null; }
        })
        .filter(Boolean);
    const filter = { contentType: 'product', ...PUBLIC_POST_FILTER, userId: { $nin: blockedObjectIds } };
    const rx = query ? new RegExp(escapeRegex(query), 'i') : null;
    if (rx) {
        filter.$or = [
            { 'customization.product.name': rx },
            { 'customization.product.brand': rx },
            { 'customization.product.category': rx },
            { 'customization.product.subcategory': rx },
            { 'customization.product.tags': rx },
            { 'customization.product.description': rx },
            { caption: rx },
        ];
    }
    if (filters.category) filter['customization.product.category'] = filters.category;
    if (filters.subcategory) filter['customization.product.subcategory'] = filters.subcategory;
    if (filters.brand) filter['customization.product.brand'] = filters.brand;
    // Parity with the Typesense clauses above — these were accepted as query
    // params and then silently dropped whenever Typesense was unavailable.
    if (filters.city) filter['customization.product.location.city'] = filters.city;
    if (filters.country) filter['customization.product.location.country'] = filters.country;
    if (Number.isFinite(filters.minPrice) || Number.isFinite(filters.maxPrice)) {
        filter['customization.product.price'] = {};
        if (Number.isFinite(filters.minPrice)) filter['customization.product.price'].$gte = filters.minPrice;
        if (Number.isFinite(filters.maxPrice)) filter['customization.product.price'].$lte = filters.maxPrice;
    }

    // Sort mirrors the Typesense sortMap. `relevance` has no _text_match here, so
    // it is approximated with a name/brand/tag hit ranked above a caption-only or
    // description-only hit. Without this the fallback returned natural collection
    // order — for "shirt" that meant whatever happened to be inserted first, which
    // read as "product search is broken" on any environment without Typesense.
    const sortKey = req.query.sort || 'relevance';
    const relevanceStage = rx
        ? [{
            $addFields: {
                _relevance: {
                    $switch: {
                        branches: [
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.name', ''] }, regex: rx } }, then: 4 },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.brand', ''] }, regex: rx } }, then: 3 },
                            {
                                case: {
                                    $gt: [{
                                        $size: {
                                            $filter: {
                                                input: { $ifNull: ['$customization.product.tags', []] },
                                                as: 't',
                                                cond: { $regexMatch: { input: '$$t', regex: rx } },
                                            }
                                        }
                                    }, 0]
                                }, then: 3
                            },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.category', ''] }, regex: rx } }, then: 2 },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.subcategory', ''] }, regex: rx } }, then: 2 },
                        ],
                        default: 1,
                    }
                }
            }
        }]
        : [{ $addFields: { _relevance: 0 } }];

    const sortStage = {
        price_asc: { 'customization.product.price': 1 },
        price_desc: { 'customization.product.price': -1 },
        newest: { createdAt: -1 },
        popular: { 'engagement.likes': -1, createdAt: -1 },
    }[sortKey] || { _relevance: -1, 'engagement.likes': -1, createdAt: -1 };

    const [posts, total] = await Promise.all([
        Post.aggregate([
            { $match: filter },
            ...relevanceStage,
            { $sort: sortStage },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            //* Join the seller so this path returns the SAME card as Typesense.
            //* It was skipped as "not cheap", but it runs after $limit — at most
            //* `limit` lookups — and without it every product card rendered with
            //* a blank seller name whenever Typesense was unavailable.
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: '_author',
                    pipeline: [{ $project: { username: 1, profileImageUrl: 1 } }],
                }
            },
            { $project: { 'customization.product': 1, media: 1, userId: 1, contentType: 1, _author: 1 } },
        ]),
        Post.countDocuments(filter),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        products: posts.map(postToProductCard),
        facets: [],
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Product search results'));
});
