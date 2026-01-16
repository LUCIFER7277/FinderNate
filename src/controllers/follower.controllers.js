import Follower from "../models/follower.models.js";
import FollowRequest from "../models/followRequest.models.js";
import { User } from "../models/user.models.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { ApiError } from "../utlis/ApiError.js";
import { createFollowNotification } from "./notification.controllers.js";
import { redisClient } from "../config/redis.config.js";

// Follow a user (with privacy support)
export const followUser = asyncHandler(async (req, res) => {
    const requesterId = req.user._id;
    const { userId } = req.body; // userId to follow

    if (requesterId.toString() === userId) {
        throw new ApiError(400, "You cannot follow yourself");
    }

    // Check if already following
    const existingFollow = await Follower.findOne({ userId, followerId: requesterId });
    if (existingFollow) throw new ApiError(400, "Already following");

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

        await Follower.create({ userId, followerId: requesterId });

        // Update User model arrays
        await User.findByIdAndUpdate(userId, { $addToSet: { followers: requesterId } });
        await User.findByIdAndUpdate(requesterId, { $addToSet: { following: userId } });

        // Create notification
        await createFollowNotification({ recipientId: userId, sourceUserId: requesterId });

        // Invalidate caches
        const { invalidateViewableUsersCache } = await import('../middlewares/privacy.middleware.js');
        await invalidateViewableUsersCache(requesterId);
        await invalidateViewableUsersCache(userId);

        // Invalidate following cache
        await redisClient.del(`following:${requesterId}`);

        return res.status(200).json(new ApiResponse(200, {
            followedUser: {
                _id: userId,
                username: targetUser.username,
                fullName: targetUser.fullName,
                profileImageUrl: targetUser.profileImageUrl
            },
            isFollowing: true,
            isPending: false,
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
});

// Unfollow a user or cancel follow request
export const unfollowUser = asyncHandler(async (req, res) => {
    const requesterId = req.user._id;
    const { userId } = req.body; // userId to unfollow

    // Check if currently following
    const followRelation = await Follower.findOneAndDelete({ userId, followerId: requesterId });

    if (followRelation) {
        // Update User model arrays
        await User.findByIdAndUpdate(userId, { $pull: { followers: requesterId } });
        await User.findByIdAndUpdate(requesterId, { $pull: { following: userId } });

        // Get the unfollowed user's info to return in response
        const unfollowedUser = await User.findById(userId).select('username fullName profileImageUrl');

        // Invalidate caches
        const { invalidateViewableUsersCache } = await import('../middlewares/privacy.middleware.js');
        await invalidateViewableUsersCache(requesterId);
        await invalidateViewableUsersCache(userId);

        // Invalidate following cache
        await redisClient.del(`following:${requesterId}`);

        return res.status(200).json(new ApiResponse(200, {
            unfollowedUser: {
                _id: userId,
                username: unfollowedUser.username,
                fullName: unfollowedUser.fullName,
                profileImageUrl: unfollowedUser.profileImageUrl
            },
            isFollowing: false,
            isPending: false,
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
});

// Get followers of a user
export const getFollowers = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const followers = await Follower.find({ userId }).populate("followerId", "username profileImageUrl fullName isVerified bio");
    res.status(200).json(new ApiResponse(200, followers.map(f => f.followerId).filter(user => user !== null), "Followers fetched successfully"));
});

// Get following of a user
export const getFollowing = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const following = await Follower.find({ followerId: userId }).populate("userId", "username profileImageUrl fullName isVerified bio");
    res.status(200).json(new ApiResponse(200, following.map(f => f.userId).filter(user => user !== null), "Following fetched successfully"));
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

    // Create the follow relationship
    await Follower.create({ userId: recipientId, followerId: requesterId });

    // Update User model arrays
    await User.findByIdAndUpdate(recipientId, { $addToSet: { followers: requesterId } });
    await User.findByIdAndUpdate(requesterId, { $addToSet: { following: recipientId } });

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

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            requester: req.requesterId,
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

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            recipient: req.recipientId,
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