import Follower from "../models/follower.models.js";
import FollowRequest from "../models/followRequest.models.js";
import { User } from "../models/user.models.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { createFollowNotification } from "./notification.controllers.js";
import { redisClient, RedisKeys, FOLLOW_LIST_MAX } from "../config/redis.config.js";
import { addBadgesToUsers } from "../utils/userBadge.utils.js";
import { invalidateViewableUsersCache } from "../middlewares/privacy.middleware.js";
import {
    getFollowStatus,
    onUserFollowed,
    onUserUnfollowed,
    getFollowersCount,
    getFollowingCount,
} from "../utils/followEngagement.utils.js";

// Follow a user (with privacy support)
export const followUser = asyncHandler(async (req, res) => {
    try{

        const requesterId = req.user._id;
        const { userId } = req.body; // userId to follow
        
        if (requesterId.toString() === userId) {
            throw new ApiError(400, "You cannot follow yourself");
    }
    
    // Check follow status: Redis first ('1'/'0'), DB fallback on miss or Redis down
    const alreadyFollowing = await getFollowStatus(requesterId, userId);
    if (alreadyFollowing) throw new ApiError(400, "Already following");
    
    // Check if there's ANY existing follow request (pending, rejected, or approved)
    const existingRequest = await FollowRequest.findOne({
        requesterId,
        recipientId: userId
    });

    // If there's a pending request, inform the user
    if (existingRequest && existingRequest.status === 'pending') {
        throw new ApiError(400, "Follow request already sent");
    }
    
    // Get the user to follow
    const targetUser = await User.findById(userId).select('username fullName profileImageUrl privacy');
    if (!targetUser) throw new ApiError(404, "User not found");
    
    // If target user has public account, follow immediately
    if (targetUser.privacy === 'public') {
        // Delete any old follow request records (rejected or approved)
        if (existingRequest) {
            await FollowRequest.findByIdAndDelete(existingRequest._id);
        }
        
        // All Redis ops (lists, sets, counts) happen atomically in one pipeline.
        const result = await onUserFollowed(requesterId, userId);
        
        let newFollowersCount, newFollowingCount;
        
        if (!result.ok) {
            // Redis is down — write directly to DB and read fresh counts from DB.
            await Follower.create({ userId, followerId: requesterId });
            await User.findByIdAndUpdate(userId, { $addToSet: { followers: requesterId } });
            await User.findByIdAndUpdate(requesterId, { $addToSet: { following: userId } });
            try {
                [newFollowersCount, newFollowingCount] = await Promise.all([
                    Follower.countDocuments({ userId }),
                    Follower.countDocuments({ followerId: requesterId }),
                ]);
            } catch { /* counts remain undefined → null in response */ }
        } else {
            newFollowersCount = result.followersCount;
            newFollowingCount = result.followingCount;
        }
        
        // Notification + cache invalidation fire-and-forget
        createFollowNotification({ recipientId: userId, sourceUserId: requesterId })?.catch(() => {});
        invalidateViewableUsersCache(requesterId)?.catch(() => {});
        invalidateViewableUsersCache(userId)?.catch(() => {});
        
        return res.status(200).json(new ApiResponse(200, {
            followedUser: {
                _id: userId,
                username: targetUser.username,
                fullName: targetUser.fullName,
                profileImageUrl: targetUser.profileImageUrl
            },
            isFollowing: true,
            isPending: false,
            followersCount: newFollowersCount ?? null,
            followingCount: newFollowingCount ?? null,
            timestamp: new Date()
        }, "Followed successfully"));
    }

    // If target user has private account, create or update follow request
    if (existingRequest) {
        // Update the existing request to pending (if it was rejected before)
        existingRequest.status = 'pending';
        existingRequest.createdAt = new Date();
        await existingRequest.save();
    } else {
        // Create new follow request
        await FollowRequest.create({ requesterId, recipientId: userId });
    }
    
    // Create notification for follow request
    await createFollowNotification({ recipientId: userId, sourceUserId: requesterId, isRequest: true });
    
    res.status(200).json(new ApiResponse(200, {
        targetUser: {
            _id: userId,
            username: targetUser.username,
            fullName: targetUser.fullName,
            profileImageUrl: targetUser.profileImageUrl
        },
        isFollowing: false,
        isPending: true,
        timestamp: new Date()
    }, "Follow request sent"));
}
catch(error){
    console.log(error)
    return res.status(error.statusCode || 500).json(new ApiResponse(error.statusCode || 500, null, error.message || "An error occurred"));
}
});

// Unfollow a user or cancel follow request
export const unfollowUser = asyncHandler(async (req, res) => {
    try{

        const requesterId = req.user._id;
        const { userId } = req.body; // userId to unfollow
        
        // Check follow status: Redis first, DB fallback on miss or Redis down
        const isFollowing = await getFollowStatus(requesterId, userId);
        
        if (isFollowing) {
        // All Redis ops (lists, sets, counts) happen atomically in one pipeline.
        const result = await onUserUnfollowed(requesterId, userId);
        
        const unfollowedUser = await User.findById(userId).select('username fullName profileImageUrl');

        let newFollowersCount, newFollowingCount;
        
        if (!result.ok) {
            // Redis is down — write directly to DB and read fresh counts from DB.
            await Follower.findOneAndDelete({ userId, followerId: requesterId });
            await User.findByIdAndUpdate(userId, { $pull: { followers: requesterId } });
            await User.findByIdAndUpdate(requesterId, { $pull: { following: userId } });
            try {
                [newFollowersCount, newFollowingCount] = await Promise.all([
                    Follower.countDocuments({ userId }),
                    Follower.countDocuments({ followerId: requesterId }),
                ]);
            } catch { /* counts remain undefined → null in response */ }
        } else {
            newFollowersCount = result.followersCount;
            newFollowingCount = result.followingCount;
        }
        
        // Cache invalidation fire-and-forget
        invalidateViewableUsersCache(requesterId).catch(() => {});
        invalidateViewableUsersCache(userId).catch(() => {});
        
        return res.status(200).json(new ApiResponse(200, {
            unfollowedUser: {
                _id: userId,
                username: unfollowedUser.username,
                fullName: unfollowedUser.fullName,
                profileImageUrl: unfollowedUser.profileImageUrl
            },
            isFollowing: false,
            isPending: false,
            followersCount: newFollowersCount ?? null,
            followingCount: newFollowingCount ?? null,
            timestamp: new Date()
        }, "Unfollowed successfully"));
    }
    
    // Check if there's a pending follow request to cancel
    const followRequest = await FollowRequest.findOneAndDelete({
        requesterId,
        recipientId: userId,
        status: 'pending'
    });

    if (followRequest) {
        const targetUser = await User.findById(userId).select('username fullName profileImageUrl');
        
        return res.status(200).json(new ApiResponse(200, {
            targetUser: {
                _id: userId,
                username: targetUser.username,
                fullName: targetUser.fullName,
                profileImageUrl: targetUser.profileImageUrl
            },
            isFollowing: false,
            isPending: false,
            timestamp: new Date()
        }, "Follow request cancelled"));
    }

    throw new ApiError(400, "Not following this user and no pending request found");
}
catch(error){
    console.log(error)
    return res.status(error.statusCode || 500).json(new ApiResponse(error.statusCode || 500, null, error.message || "An error occurred"));
}
});

// Get followers of a user (Redis-first, paginated)
export const getFollowers = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    // ── Total count from Redis (falls back to DB automatically) ──────────────
    const totalCount = await getFollowersCount(userId);

    // ── Build the unified cached ID list: temp SET union LIST, newest-first ──
    let cachedIds = [];
    try {
        const [tempIds, listIds] = await Promise.all([
            redisClient.smembers(RedisKeys.followersTemp(userId)),
            redisClient.lrange(RedisKeys.userFollowers(userId), 0, FOLLOW_LIST_MAX - 1),
        ]);
        // Temp IDs first (most recent, not yet in DB), then list IDs, deduped
        const seen = new Set();
        for (const id of [...tempIds, ...listIds]) {
            if (!seen.has(id)) { seen.add(id); cachedIds.push(id); }
        }
    } catch {
        cachedIds = [];
    }

    let followerUsers = [];

    if (page === 1) {
        // Page 1: serve up to `limit` from cached IDs first, then fill from DB
        const cachedSlice = cachedIds.slice(0, limit);
        const fromCacheCount = cachedSlice.length;
        const remainderNeeded = limit - fromCacheCount;

        // Fetch cached users from User collection (preserves newest-first order)
        let cachedUsers = [];
        if (cachedSlice.length > 0) {
            const userDocs = await User.find({ _id: { $in: cachedSlice } })
                .select('username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            // Re-sort to match cachedSlice order
            const userMap = new Map(userDocs.map(u => [u._id.toString(), u]));
            cachedUsers = cachedSlice.map(id => userMap.get(id)).filter(Boolean);
        }

        // Fill remainder from DB, excluding all cached IDs
        let dbUsers = [];
        if (remainderNeeded > 0) {
            const dbFollowers = await Follower.find({
                userId,
                followerId: { $nin: cachedIds },
            })
                .sort({ createdAt: -1 })
                .limit(remainderNeeded)
                .populate('followerId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            dbUsers = dbFollowers.map(f => f.followerId).filter(Boolean);
        }

        followerUsers = [...cachedUsers, ...dbUsers];
    } else {
        // Page 2+: all from DB, skip records already shown on page 1, exclude cached IDs
        const page1Shown = Math.min(cachedIds.length, limit);
        const dbAlreadyShownOnPage1 = limit - page1Shown; // how many DB records page 1 consumed
        const dbSkip = dbAlreadyShownOnPage1 + (page - 2) * limit;

        const dbFollowers = await Follower.find({
            userId,
            followerId: { $nin: cachedIds },
        })
            .sort({ createdAt: -1 })
            .skip(dbSkip)
            .limit(limit)
            .populate('followerId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
            .lean();

        followerUsers = dbFollowers.map(f => f.followerId).filter(Boolean);
    }

    const followersWithBadges = await addBadgesToUsers(followerUsers);
    const hasMore = page * limit < totalCount;

    res.status(200).json(new ApiResponse(200, {
        followers: followersWithBadges,
        totalCount,
        page,
        limit,
        hasMore,
    }, "Followers fetched successfully"));
});

// Get following of a user (Redis-first, paginated)
export const getFollowing = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    // ── Total count from Redis (falls back to DB automatically) ──────────────
    const totalCount = await getFollowingCount(userId);

    // ── Build the unified cached ID list: temp SET union LIST, newest-first ──
    let cachedIds = [];
    try {
        const [tempIds, listIds] = await Promise.all([
            redisClient.smembers(RedisKeys.followingTemp(userId)),
            redisClient.lrange(RedisKeys.userFollowing(userId), 0, FOLLOW_LIST_MAX - 1),
        ]);
        const seen = new Set();
        for (const id of [...tempIds, ...listIds]) {
            if (!seen.has(id)) { seen.add(id); cachedIds.push(id); }
        }
    } catch {
        cachedIds = [];
    }

    let followingUsers = [];

    if (page === 1) {
        const cachedSlice = cachedIds.slice(0, limit);
        const fromCacheCount = cachedSlice.length;
        const remainderNeeded = limit - fromCacheCount;

        // Fetch cached users from User collection
        let cachedUsers = [];
        if (cachedSlice.length > 0) {
            const userDocs = await User.find({ _id: { $in: cachedSlice } })
                .select('username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            const userMap = new Map(userDocs.map(u => [u._id.toString(), u]));
            cachedUsers = cachedSlice.map(id => userMap.get(id)).filter(Boolean);
        }

        // Fill remainder from DB — for following, the Follower record has followerId=userId
        let dbUsers = [];
        if (remainderNeeded > 0) {
            const dbFollowing = await Follower.find({
                followerId: userId,
                userId: { $nin: cachedIds },
            })
                .sort({ createdAt: -1 })
                .limit(remainderNeeded)
                .populate('userId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            dbUsers = dbFollowing.map(f => f.userId).filter(Boolean);
        }

        followingUsers = [...cachedUsers, ...dbUsers];
    } else {
        const page1Shown = Math.min(cachedIds.length, limit);
        const dbAlreadyShownOnPage1 = limit - page1Shown;
        const dbSkip = dbAlreadyShownOnPage1 + (page - 2) * limit;

        const dbFollowing = await Follower.find({
            followerId: userId,
            userId: { $nin: cachedIds },
        })
            .sort({ createdAt: -1 })
            .skip(dbSkip)
            .limit(limit)
            .populate('userId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
            .lean();

        followingUsers = dbFollowing.map(f => f.userId).filter(Boolean);
    }

    const followingWithBadges = await addBadgesToUsers(followingUsers);
    const hasMore = page * limit < totalCount;

    res.status(200).json(new ApiResponse(200, {
        following: followingWithBadges,
        totalCount,
        page,
        limit,
        hasMore,
    }, "Following fetched successfully"));
});

// Approve follow request
export const approveFollowRequest = asyncHandler(async (req, res) => {
    const recipientId = req.user._id;
    const { requesterId } = req.body;

    // Find and update the follow request
    const followRequest = await FollowRequest.findOneAndUpdate(
        { requesterId, recipientId, status: 'pending' },
        { status: 'approved' },
        { new: true }
    );

    if (!followRequest) {
        throw new ApiError(404, "Follow request not found");
    }

    // All Redis ops (lists, sets, counts) happen atomically in one pipeline.
    // requesterId is now following recipientId.
    const result = await onUserFollowed(requesterId, recipientId);

    if (!result.ok) {
        // Redis is down — fall back to direct DB write.
        await Follower.create({ userId: recipientId, followerId: requesterId });
        await User.findByIdAndUpdate(recipientId, { $addToSet: { followers: requesterId } });
        await User.findByIdAndUpdate(requesterId, { $addToSet: { following: recipientId } });
    }

    // Create notification for approval
    await createFollowNotification({ recipientId: requesterId, sourceUserId: recipientId, isApproval: true });

    // Get requester info
    const requester = await User.findById(requesterId).select('username fullName profileImageUrl');

    res.status(200).json(new ApiResponse(200, {
        requester: {
            _id: requesterId,
            username: requester.username,
            fullName: requester.fullName,
            profileImageUrl: requester.profileImageUrl
        },
        isApproved: true,
        timestamp: new Date()
    }, "Follow request approved"));
});

// Reject follow request
export const rejectFollowRequest = asyncHandler(async (req, res) => {
    const recipientId = req.user._id;
    const { requesterId } = req.body;

    // Find and update the follow request
    const followRequest = await FollowRequest.findOneAndUpdate(
        { requesterId, recipientId, status: 'pending' },
        { status: 'rejected' },
        { new: true }
    );

    if (!followRequest) {
        throw new ApiError(404, "Follow request not found");
    }

    // Get requester info
    const requester = await User.findById(requesterId).select('username fullName profileImageUrl');

    res.status(200).json(new ApiResponse(200, {
        requester: {
            _id: requesterId,
            username: requester.username,
            fullName: requester.fullName,
            profileImageUrl: requester.profileImageUrl
        },
        isRejected: true,
        timestamp: new Date()
    }, "Follow request rejected"));
});

// Get pending follow requests for the current user
export const getPendingFollowRequests = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const requests = await FollowRequest.find({
        recipientId: userId,
        status: 'pending'
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('requesterId', 'username fullName profileImageUrl');

    const totalRequests = await FollowRequest.countDocuments({
        recipientId: userId,
        status: 'pending'
    });

    // Add badges to requesters
    const requestsWithBadges = await addBadgesToUsers(requests.map(req => req.requesterId));
    const requestersMap = new Map(requestsWithBadges.map(user => [user._id.toString(), user]));

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            requester: requestersMap.get(req.requesterId._id.toString()) || req.requesterId,
            timestamp: req.createdAt
        })),
        pagination: {
            totalRequests,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / limit),
            requestsPerPage: parseInt(limit)
        }
    }, "Pending follow requests retrieved"));
});

// Get sent follow requests for the current user
export const getSentFollowRequests = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const requests = await FollowRequest.find({
        requesterId: userId,
        status: 'pending'
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('recipientId', 'username fullName profileImageUrl');

    const totalRequests = await FollowRequest.countDocuments({
        requesterId: userId,
        status: 'pending'
    });

    // Add badges to recipients
    const recipientsWithBadges = await addBadgesToUsers(requests.map(req => req.recipientId));
    const recipientsMap = new Map(recipientsWithBadges.map(user => [user._id.toString(), user]));

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            recipient: recipientsMap.get(req.recipientId._id.toString()) || req.recipientId,
            timestamp: req.createdAt
        })),
        pagination: {
            totalRequests,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / limit),
            requestsPerPage: parseInt(limit)
        }
    }, "Sent follow requests retrieved"));
});
