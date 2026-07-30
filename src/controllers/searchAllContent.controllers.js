import Post from '../models/userPost.models.js';
import Reel from '../models/reels.models.js';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import SearchSuggestion from '../models/searchSuggestion.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { getCoordinates } from '../utils/getCoordinates.js';
import { filterBusinessPostsByPaymentPlan } from '../utils/businessPlan.utils.js';
import { addBadgesToNestedUsers, addBadgesToUsers } from '../utils/userBadge.utils.js';
import { batchIsLikedByUser, batchGetLikedByUsers, batchGetLikesCount,batchSharedCount } from '../utils/postEngagement.utils.js';
import { getLikedByPreview } from '../utils/likedByPreview.utils.js';
import { getFollowingIdSet, getPendingFollowRequestIdSet } from '../utils/followEngagement.utils.js';

export const searchAllContent = async (req, res) => {
    try {
        const {
            q,
            contentType,
            postType,
            startDate,
            endDate,
            coordinates,
            distance,
            near,
            page = 1,
            limit = 20
        } = req.query;

        // Get blocked users from middleware
        const blockedUsers = req.blockedUsers || [];

        if (!q) throw new ApiError(400, "Search query 'q' is required");

        // Track search keyword if it's 3+ characters
        if (q.trim().length >= 3) {
            const normalizedKeyword = q.trim().toLowerCase();
            try {
                const existingSuggestion = await SearchSuggestion.findOne({
                    keyword: normalizedKeyword
                });


                if (existingSuggestion) {
                    existingSuggestion.searchCount += 1;
                    existingSuggestion.lastSearched = new Date();
                    await existingSuggestion.save();
                } else {
                    await SearchSuggestion.create({
                        keyword: normalizedKeyword,
                        searchCount: 1,
                        lastSearched: new Date()
                    });
                }
            } catch (error) {

            }
        }

        //* Tags are stored WITHOUT a leading '#' — the model's extractHashtags
        //* strips it, and the composer writes bare words into
        //* customization.*.tags. Building the regex from the raw query meant a
        //* "#coffee" search could never match the tag "coffee", which is exactly
        //* what the user sees on a post card ('#' there is a display prefix).
        //* So: strip '#' once, up front, and keep a separate literal regex for
        //* finding "#coffee" written inline in caption/description text.
        //* Escaping also matters — the raw query used to go straight into
        //* new RegExp(), so a query like "a(" threw and 500'd the search.
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rawQuery = String(q).trim();
        const isHashtagQuery = rawQuery.startsWith('#');
        const term = rawQuery.replace(/^#+/, '').trim();
        if (!term) {
            return res.status(400).json(new ApiResponse(400, null, "Search query 'q' is required"));
        }
        const safeTerm = escapeRegex(term);
        const searchRegex = new RegExp(safeTerm, 'i');                 // '#'-free
        const hashtagLiteralRegex = new RegExp(`#${safeTerm}`, 'i');   // "#foo" in prose
        const tagExactRegex = new RegExp(`^${safeTerm}$`, 'i');        // whole tag
        const skip = (page - 1) * limit;

        // 🔍 Parse postType (can be comma-separated)
        let postTypeArray = [];
        if (postType) {
            postTypeArray = postType.split(',').map(type => type.trim());
        }

        // 🔎 Enhanced Post filters for comprehensive search
        const basePostFilters = {
            $or: [
                // Caption and description search
                { caption: searchRegex },
                { description: searchRegex },

                // Hashtag search — hashtags are stored without the '#'
                { hashtags: searchRegex },
                { caption: hashtagLiteralRegex },
                { description: hashtagLiteralRegex },

                // Business information search
                { 'customization.business.businessName': searchRegex },
                { 'customization.business.category': searchRegex },
                { 'customization.business.subcategory': searchRegex },
                { 'customization.business.businessType': searchRegex },
                { 'customization.business.tags': searchRegex },
                { 'customization.business.description': searchRegex },

                // Product information search
                { 'customization.product.name': searchRegex },
                { 'customization.product.category': searchRegex },
                { 'customization.product.subcategory': searchRegex },
                { 'customization.product.description': searchRegex },
                { 'customization.product.tags': searchRegex },
                { 'customization.product.brand': searchRegex },

                // Service information search
                { 'customization.service.name': searchRegex },
                { 'customization.service.category': searchRegex },
                { 'customization.service.subcategory': searchRegex },
                { 'customization.service.description': searchRegex },
                { 'customization.service.tags': searchRegex },

                // Normal/tweet post tags — omitted before, so tags added to an
                // ordinary post were unsearchable by any query at all.
                { 'customization.normal.tags': searchRegex },

                // Location-based search
                { 'customization.normal.location.name': searchRegex },
                { 'customization.normal.location.address': searchRegex },
                { 'customization.normal.location.city': searchRegex },
                { 'customization.normal.location.state': searchRegex },
                { 'customization.normal.location.country': searchRegex },
                { 'customization.product.location.name': searchRegex },
                { 'customization.product.location.address': searchRegex },
                { 'customization.product.location.city': searchRegex },
                { 'customization.product.location.state': searchRegex },
                { 'customization.product.location.country': searchRegex },
                { 'customization.service.location.name': searchRegex },
                { 'customization.service.location.address': searchRegex },
                { 'customization.service.location.city': searchRegex },
                { 'customization.service.location.state': searchRegex },
                { 'customization.service.location.country': searchRegex },
                { 'customization.business.location.name': searchRegex },
                { 'customization.business.location.address': searchRegex },
                { 'customization.business.location.city': searchRegex },
                { 'customization.business.location.state': searchRegex },
                { 'customization.business.location.country': searchRegex },
            ],
            contentType: { $in: ['normal', 'service', 'product', 'business'] },
            'settings.privacy': { $ne: 'private' }  // Never show private posts in search results
        };

        //* An explicit '#' means the user wants a TAG search, not a keyword
        //* search — "#coffee" should return posts tagged coffee, not every
        //* caption that happens to mention coffee. Bare "coffee" keeps the
        //* broad behaviour above.
        if (isHashtagQuery) {
            basePostFilters.$or = [
                { hashtags: tagExactRegex },
                { 'customization.normal.tags': tagExactRegex },
                { 'customization.product.tags': tagExactRegex },
                { 'customization.service.tags': tagExactRegex },
                { 'customization.business.tags': tagExactRegex },
                { caption: hashtagLiteralRegex },
                { description: hashtagLiteralRegex },
            ];
        }

        // Filter by contentType
        if (contentType && contentType !== 'reel') {
            basePostFilters.contentType = contentType;
        }

        // Filter by postType if provided
        if (postTypeArray.length > 0) {
            basePostFilters.postType = { $in: postTypeArray };
        }

        // 📅 Date filtering
        if (startDate || endDate) {
            basePostFilters.createdAt = {};
            if (startDate) basePostFilters.createdAt.$gte = new Date(startDate);
            if (endDate) basePostFilters.createdAt.$lte = new Date(endDate);
        }

        // 📍 Location filtering
        let lng, lat;
        let useLocationFilter = false;
        if (coordinates && distance) {
            [lng, lat] = coordinates.split('|').map(Number);
            useLocationFilter = true;
        } else if (near && distance) {
            const geo = await getCoordinates(near);
            if (geo && geo.longitude && geo.latitude) {
                lng = geo.longitude;
                lat = geo.latitude;
                useLocationFilter = true;
            } else {
                return res.status(400).json(new ApiResponse(400, null, `Could not resolve coordinates for place: ${near}`));
            }
        }

        if (useLocationFilter) {
            const geoFilter = {
                $geoWithin: {
                    $centerSphere: [[lng, lat], distance / 6371]
                }
            };

            basePostFilters.$or = basePostFilters.$or.map(condition => ({
                $and: [
                    condition,
                    {
                        $or: [
                            { 'customization.normal.location.coordinates': geoFilter },
                            { 'customization.service.location.coordinates': geoFilter },
                            { 'customization.product.location.coordinates': geoFilter },
                            { 'customization.business.location.coordinates': geoFilter },
                        ]
                    }
                ]
            }));
        }

        // Enhanced user search (excluding blocked users)
        const matchingUsers = await User.find({
            $or: [
                { username: searchRegex },
                { fullName: searchRegex },
                { fullNameLower: searchRegex },
                { bio: searchRegex },
                { location: searchRegex },
                { address: searchRegex }
            ],
            _id: { $nin: blockedUsers }
        }).select('_id');

        const matchingUserIds = matchingUsers.map(user => user._id);

        // Enhanced business search (excluding blocked users)
        const matchingBusinesses = await Business.find({
            $or: [
                { category: searchRegex },
                { subcategory: searchRegex },
                { businessName: searchRegex },
                { businessType: searchRegex },
                { tags: searchRegex },
                { description: searchRegex },
                { email: searchRegex },
                { phoneNumber: searchRegex },
                { website: searchRegex },
                { 'location.name': searchRegex },
                { 'location.address': searchRegex },
                { 'location.city': searchRegex },
                { 'location.state': searchRegex },
                { 'location.country': searchRegex }
            ],
            userId: { $nin: blockedUsers }
        }).select('userId');

        const businessUserIds = matchingBusinesses.map(business => business.userId);

        //* Author-based widening is deliberately skipped for a '#' query —
        //* otherwise "#coffee" would drag in every post by a user named
        //* "coffee_shop", which is not a hashtag result.
        if (!isHashtagQuery) {
            // Add username search to post filters
            if (matchingUserIds.length > 0) {
                basePostFilters.$or.push({ userId: { $in: matchingUserIds } });
            }

            // Add business category search to post filters
            if (businessUserIds.length > 0) {
                basePostFilters.$or.push({ userId: { $in: businessUserIds } });
            }
        }

        // 📄 Fetch Posts (excluding blocked users)
        const rawPosts = await Post.find({
            ...basePostFilters,
            userId: { $nin: blockedUsers }
        })
            .populate('userId', 'username profileImageUrl bio location isBusinessProfile')
            .lean();

        // Get active payment plan user IDs and business user IDs for prioritization
        const activePaymentPlanUserIds = await Business.find({
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId').lean();
        const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));

        const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
        const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

        //* This used to hide the WHOLE post — any contentType — the moment its
        //* author was an unpaid business account. filterBusinessPostsByPaymentPlan
        //* (already used a few lines down for reels) only hides product/service/
        //* business LISTINGS from an unpaid business; ordinary photos, tweets and
        //* reels stay visible, matching the home feed's own rule that normal
        //* content from every account always shows. The gap meant an unpaid
        //* business's own hashtags never matched their own posts in search: the
        //* post rendered on the home feed with a clickable "#tag", but that same
        //* tag's search silently filtered the post back out.
        const finalPosts = await filterBusinessPostsByPaymentPlan(rawPosts);

        const scoredPosts = finalPosts.map(post => {
            const userId = post.userId?._id || post.userId;
            const userIdStr = userId ? userId.toString() : null;
            const isBusiness = userIdStr && businessUserIdsSet.has(userIdStr);
            const hasActivePlan = userIdStr && activePlanUserIdsSet.has(userIdStr);
            
            const engagement = post.engagement || {};
            const score =
                (engagement.likes || 0) * 1 +
                (engagement.comments || 0) * 0.7 +
                (engagement.views || 0) * 0.5 +
                (engagement.shares || 0) * 0.5;

            let base = 0;
            switch (post.contentType) {
                case 'product': base = 1.5; break;
                case 'service': base = 1.2; break;
                case 'business': base = 1.0; break;
                case 'normal': base = 0.8; break;
            }
            
            // Boost score for paid business posts
            if (isBusiness && hasActivePlan) {
                base += 2.0; // Significant boost for paid business posts
            }

            return {
                ...post,
                _score: base + score + (new Date(post.createdAt).getTime() / 10000000000000),
                _type: 'post'
            };
        });

        // 📥 Enhanced Reel Search
        let scoredReels = [];
        if (!contentType || contentType === 'reel') {
            const reelFilters = {
                $or: [
                    // Caption and description search
                    { caption: searchRegex },
                    { description: searchRegex },

                    // Hashtag search for reels — stored without the '#'
                    { hashtags: searchRegex },
                    { caption: hashtagLiteralRegex },
                    { description: hashtagLiteralRegex },

                    // Music and audio search
                    { 'audio.title': searchRegex },
                    { 'audio.artist': searchRegex },

                    // Location search for reels
                    { 'location.name': searchRegex },
                    { 'location.city': searchRegex },
                    { 'location.state': searchRegex },
                    { 'location.country': searchRegex }
                ],
                userId: { $nin: blockedUsers },
                isPublic: true  // Never show private reels in search results
            };

            // Add username search to reel filters
            if (matchingUserIds.length > 0) {
                reelFilters.$or.push({ userId: { $in: matchingUserIds } });
            }

            // Add business category search to reel filters
            if (businessUserIds.length > 0) {
                reelFilters.$or.push({ userId: { $in: businessUserIds } });
            }

            if (postTypeArray.length > 0) {
                reelFilters.postType = { $in: postTypeArray };
            }

            if (startDate || endDate) {
                reelFilters.createdAt = {};
                if (startDate) reelFilters.createdAt.$gte = new Date(startDate);
                if (endDate) reelFilters.createdAt.$lte = new Date(endDate);
            }

            const rawReels = await Reel.find(reelFilters)
                .populate('userId', 'username profileImageUrl bio location isBusinessProfile')
                .lean();

            // Filter out unpaid business reels
            const filteredReels = await filterBusinessPostsByPaymentPlan(rawReels);
            
            // Get active payment plan user IDs for reels
            const reelActivePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));
            const reelBusinessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

            scoredReels = filteredReels.map(reel => {
                const userId = reel.userId?._id || reel.userId;
                const userIdStr = userId ? userId.toString() : null;
                const isBusiness = userIdStr && reelBusinessUserIdsSet.has(userIdStr);
                const hasActivePlan = userIdStr && reelActivePlanUserIdsSet.has(userIdStr);
                
                const engagement = reel.engagement || {};
                const score =
                    (engagement.likes || 0) * 1 +
                    (engagement.comments || 0) * 0.7 +
                    (engagement.views || 0) * 1.5 +
                    (engagement.shares || 0) * 0.5;

                let baseScore = 2;
                // Boost score for paid business reels
                if (isBusiness && hasActivePlan) {
                    baseScore += 2.0; // Significant boost for paid business reels
                }

                return {
                    ...reel,
                    _score: baseScore + score + (new Date(reel.createdAt).getTime() / 10000000000000),
                    _type: 'reel'
                };
            });
        }

        //  Merge + sort
        const combinedContent = [...scoredPosts, ...scoredReels]
            .sort((a, b) => b._score - a._score);

        const paginatedContent = combinedContent.slice(skip, skip + limit);

        // 👥 Enhanced User Search
        const users = await User.find({
            $or: [
                // Basic user information
                { username: searchRegex },
                { fullName: searchRegex },
                { fullNameLower: searchRegex },
                { bio: searchRegex },
                { location: searchRegex },
                { address: searchRegex },
                { email: searchRegex }
            ],
            _id: { $nin: blockedUsers }
        })
            .limit(limit)
            .select('username fullName profileImageUrl bio location isBusinessProfile')
            .lean();

        // Also find users through business category and subcategory search
        const businessUsersByCategory = await Business.find({
            $or: [
                { category: searchRegex },
                { subcategory: searchRegex },
                { businessName: searchRegex },
                { businessType: searchRegex },
                { tags: searchRegex }
            ],
            userId: { $nin: blockedUsers }
        })
            .populate('userId', 'username fullName profileImageUrl bio location isBusinessProfile')
            .limit(limit)
            .lean();

        // Combine user results, avoiding duplicates
        const allUserIds = new Set();
        const allUsers = [];

        // Add direct user search results
        users.forEach(user => {
            if (!allUserIds.has(user._id.toString())) {
                allUserIds.add(user._id.toString());
                allUsers.push(user);
            }
        });

        // Add business category search results
        businessUsersByCategory.forEach(business => {
            if (business.userId && !allUserIds.has(business.userId._id.toString())) {
                allUserIds.add(business.userId._id.toString());
                allUsers.push(business.userId);
            }
        });

        // Limit the combined results
        const limitedUsers = allUsers.slice(0, limit);

        // Fetch posts for each user found and include business information
        const usersWithPosts = await Promise.all(limitedUsers.map(async (user) => {
            const userPosts = await Post.find({ userId: user._id })
                .sort({ createdAt: -1 })
                .limit(10) // Limit to 10 recent posts per user
                .lean();

            const userReels = await Reel.find({ userId: user._id })
                .sort({ createdAt: -1 })
                .limit(5) // Limit to 5 recent reels per user
                .lean();

            // Check if user has a business profile
            const businessProfile = await Business.findOne({ userId: user._id })
                .select('businessName category subcategory businessType tags isVerified rating')
                .lean();

            return {
                ...user,
                business: businessProfile,
                posts: userPosts,
                reels: userReels,
                totalPosts: await Post.countDocuments({ userId: user._id }),
                totalReels: await Reel.countDocuments({ userId: user._id })
            };
        }));

        // Stitch isLikedBy + likedBy (max 20 from Redis Hash) into search results
        const currentUserId = req.user?._id?.toString() ?? null;
        const contentIds = paginatedContent.map(item => item._id);
        const [likedSet, likedByMap, searchLikeCountMap, sharedCountMap, followingSet, requestedSet] = await Promise.all([
            currentUserId ? batchIsLikedByUser(req.user._id, contentIds) : Promise.resolve(new Set()),
            batchGetLikedByUsers(contentIds),
            batchGetLikesCount(paginatedContent),
            batchSharedCount(paginatedContent),
            //* Follow state was never resolved here at all — the field simply
            //* was not in the response, so every client defaulted it to false
            //* and drew "Follow" on authors the viewer already follows.
            //* Resolved live, per-viewer, exactly as getHomeFeed does: it
            //* changes the instant someone taps Follow, so a cached value would
            //* be stale immediately.
            getFollowingIdSet(currentUserId),
            getPendingFollowRequestIdSet(currentUserId)
        ]);

        const stitchedContent = paginatedContent.map(item => {
            const idStr = item._id.toString();
            const likedByUsers = likedByMap.get(idStr) || [];
            const preview = getLikedByPreview(likedByUsers, currentUserId);
            //* userId is populated on these results, so the author id may be
            //* either the populated document or a raw ObjectId depending on
            //* the branch that produced the item.
            const author = item.userId;
            const authorId = author ? (author._id ?? author).toString() : null;
            return {
                ...item,
                engagement: {
                    ...item.engagement,
                    likes: searchLikeCountMap.get(idStr) ?? item.engagement?.likes ?? 0,
                    shares: sharedCountMap.get(idStr) ?? item.engagement?.shares ?? 0

                },
                isLikedBy: likedSet.has(idStr),
                isFollowing: !!authorId && followingSet.has(authorId),
                isFollowRequested: !!authorId && requestedSet.has(authorId),
                likedBy: likedByUsers,
                likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
            };
        });

        // Add badges to posts/reels in search results
        const contentWithBadges = await addBadgesToNestedUsers(stitchedContent);

        // Add badges to user search results
        {/* console.log('[BADGE DEBUG searchAllContent] Before addBadgesToUsers:', usersWithPosts.map(u => ({
            username: u.username,
            _id: u._id,
            hasSubscriptionBadge: !!u.subscriptionBadge
        }))); */}
        const usersWithBadges = await addBadgesToUsers(usersWithPosts);
       {/* console.log('[BADGE DEBUG searchAllContent] After addBadgesToUsers:', usersWithBadges.map(u => ({
            username: u.username,
            _id: u._id,
            subscriptionBadge: u.subscriptionBadge
        }))); */}

        return res.status(200).json(
            new ApiResponse(200, {
                results: contentWithBadges,
                users: usersWithBadges,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: combinedContent.length,
                    totalPages: Math.ceil(combinedContent.length / limit)
                }
            }, "Search results retrieved successfully")
        );

    } catch (error) {
        console.error(error);
        throw new ApiError(500, "Search failed");
    }
};
