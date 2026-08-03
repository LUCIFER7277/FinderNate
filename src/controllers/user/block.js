import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Block from "../../models/block.models.js";
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

    // Blocking HIDES, it does not unfollow.
    //
    // There were two Follower.findOneAndDelete calls here keyed on
    // `followingId`, a field that does not exist on FollowerSchema (it is
    // `userId`), so under Mongoose 8 — where strictQuery defaults to false and
    // the unknown key is passed straight to MongoDB — they matched nothing and
    // deleted nothing. Restoring them to the right field name would have been
    // the wrong fix: severing the follow makes the block irreversible in
    // practice, because after unblocking neither side follows the other any
    // more and a private account's posts and stories never come back. The
    // Block row alone is what hides the content, and removing it is what
    // brings it back.

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

    // Belt and braces: a duplicate row in the same direction (possible for
    // records written before the unique index existed) would keep every
    // read path filtering this pair out and make the unblock look ignored.
    await Block.deleteMany({ blockerId, blockedId: blockedUserId });

    await invalidateBlockedUsersCache(blockerId, blockedUserId);

    // The OTHER direction is a separate row and is not ours to remove — if
    // they blocked us too, content stays hidden both ways and the client
    // should say so rather than leaving the user to wonder why nothing
    // reappeared.
    const stillBlockedByThem = await Block.exists({
        blockerId: blockedUserId,
        blockedId: blockerId
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            { unblocked: true, blockedByThem: !!stillBlockedByThem },
            stillBlockedByThem
                ? "User unblocked. They have also blocked you, so their content stays hidden."
                : "User unblocked successfully"
        )
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
