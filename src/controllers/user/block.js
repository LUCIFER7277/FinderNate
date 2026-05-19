import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Block from "../../models/block.models.js";
import Follower from "../../models/follower.models.js";
import { invalidateBlockedUsersCache } from "../../middlewares/blocking.middleware.js";

const blockUser = asyncHandler(async (req, res) => {
    const { blockedUserId, reason } = req.body;
    const blockerId = req.user._id;

    if (!blockedUserId) {
        throw new ApiError(400, "User ID to block is required");
    }

    if (blockerId.toString() === blockedUserId) {
        throw new ApiError(400, "You cannot block yourself");
    }

    const userToBlock = await User.findById(blockedUserId);
    if (!userToBlock) {
        throw new ApiError(404, "User to block not found");
    }

    const existingBlock = await Block.findOne({ blockerId, blockedId: blockedUserId });
    if (existingBlock) {
        throw new ApiError(409, "User is already blocked");
    }

    const block = await Block.create({
        blockerId,
        blockedId: blockedUserId,
        reason: reason || null
    });

    await invalidateBlockedUsersCache(blockerId, blockedUserId);

    await Follower.findOneAndDelete({ followerId: blockerId, followingId: blockedUserId });
    await Follower.findOneAndDelete({ followerId: blockedUserId, followingId: blockerId });

    return res.status(200).json(
        new ApiResponse(200, { block }, "User blocked successfully")
    );
});

const unblockUser = asyncHandler(async (req, res) => {
    const { blockedUserId } = req.body;
    const blockerId = req.user._id;

    if (!blockedUserId) {
        throw new ApiError(400, "User ID to unblock is required");
    }

    const existingBlock = await Block.findOne({ blockerId, blockedId: blockedUserId });
    if (!existingBlock) {
        throw new ApiError(404, "User is not blocked");
    }

    await Block.findByIdAndDelete(existingBlock._id);
    await invalidateBlockedUsersCache(blockerId, blockedUserId);

    return res.status(200).json(
        new ApiResponse(200, null, "User unblocked successfully")
    );
});

const getBlockedUsers = asyncHandler(async (req, res) => {
    const blockerId = req.user._id;

    const blockedUsers = await Block.find({ blockerId })
        .populate('blockedId', 'fullName username profileImageUrl')
        .sort({ createdAt: -1 });

    const formattedBlockedUsers = blockedUsers.map(block => ({
        blockedUserId: block.blockedId._id,
        fullName: block.blockedId.fullName,
        username: block.blockedId.username,
        profileImageUrl: block.blockedId.profileImageUrl,
        blockedAt: block.createdAt,
        reason: block.reason
    }));

    return res.status(200).json(
        new ApiResponse(200, { blockedUsers: formattedBlockedUsers }, "Blocked users retrieved successfully")
    );
});

const checkIfUserBlocked = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const currentUserId = req.user._id;

    if (!userId) {
        throw new ApiError(400, "User ID is required");
    }

    const block = await Block.findOne({
        $or: [
            { blockerId: currentUserId, blockedId: userId },
            { blockerId: userId, blockedId: currentUserId }
        ]
    });

    const isBlocked = !!block;

    return res.status(200).json(
        new ApiResponse(200, { isBlocked }, "Block status checked successfully")
    );
});

export {
    blockUser,
    unblockUser,
    getBlockedUsers,
    checkIfUserBlocked,
};
