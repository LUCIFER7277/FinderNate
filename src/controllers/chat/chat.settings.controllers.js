import Chat from '../../models/chat.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import socketManager from '../../config/socket.js';
import { getPrivacyFilteredStatus } from '../../middlewares/messaging-privacy.middleware.js';
import { safeEmitToChat } from './helpers.js';

export const updateChatTheme = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { themeColor } = req.body;

    if (!themeColor) {
        throw new ApiError(400, 'Theme color is required');
    }

    if (!/^#[0-9A-F]{6}$/i.test(themeColor)) {
        throw new ApiError(400, 'Invalid color format. Use hex color code (e.g., #DBB42C)');
    }

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    chat.themeColor = themeColor;
    await chat.save();

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    safeEmitToChat(chatId, 'chat_theme_updated', {
        chatId,
        themeColor,
        updatedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedChat, 'Chat theme updated successfully')
    );
});

export const startTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    safeEmitToChat(chatId, 'user_typing', {
        userId: currentUserId,
        username: req.user.username,
        fullName: req.user.fullName,
        chatId
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Typing indicator started')
    );
});

export const stopTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    safeEmitToChat(chatId, 'user_stopped_typing', {
        userId: currentUserId,
        chatId
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Typing indicator stopped')
    );
});

export const getOnlineStatus = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    let userIds = req.query.userIds;

    if (typeof userIds === 'string') {
        if (userIds.includes(',')) {
            userIds = userIds.split(',');
        } else {
            userIds = [userIds];
        }
    }

    if (!userIds || !Array.isArray(userIds)) {
        throw new ApiError(400, "User IDs array is required");
    }

    const onlineStatus = {};

    for (const userId of userIds) {
        const status = await getPrivacyFilteredStatus(
            currentUserId,
            userId,
            socketManager.isUserOnline.bind(socketManager)
        );
        onlineStatus[userId] = status;
    }

    return res.status(200).json(
        new ApiResponse(200, { onlineStatus }, 'Online status fetched successfully')
    );
});
