import Chat from '../../models/chat.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import socketManager from '../../config/socket.js';
import { getPrivacyFilteredStatus } from '../../middlewares/messaging-privacy.middleware.js';
import { safeEmitToChat } from './helpers.js';
import { uploadBufferToBunny } from '../../utils/bunny.js';

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

/**
 * Set or replace a group's image.
 *
 * The Chat model has always had a `groupImage` field but nothing could write
 * to it, so groups were stuck with the generic placeholder. Restricted to
 * group admins — any participant being able to change the picture everyone
 * sees is a small but real abuse vector.
 *
 * Send `multipart/form-data` with a `groupImage` file, or JSON
 * `{ "groupImage": null }` to clear it.
 */
export const updateGroupImage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats have a group image');
    }

    const isAdmin = (chat.admins || []).some(a => String(a) === String(currentUserId))
        || String(chat.createdBy) === String(currentUserId);
    if (!isAdmin) {
        throw new ApiError(403, 'Only group admins can change the group image');
    }

    //* Explicit removal: { groupImage: null } with no file attached.
    if (!req.file) {
        if (req.body?.groupImage === null || req.body?.groupImage === 'null' || req.body?.groupImage === '') {
            chat.groupImage = undefined;
            await chat.save();
            safeEmitToChat(chatId, 'group_image_updated', { chatId, groupImage: null, updatedBy: currentUserId });
            return res.status(200).json(new ApiResponse(200, { groupImage: null }, 'Group image removed'));
        }
        throw new ApiError(400, 'No image supplied');
    }

    if (!String(req.file.mimetype || '').startsWith('image/')) {
        throw new ApiError(400, 'Group image must be an image file');
    }

    const uploaded = await uploadBufferToBunny(
        req.file.buffer,
        'chat-groups',
        req.file.originalname,
        req.file.mimetype,
    );

    chat.groupImage = uploaded.secure_url;
    await chat.save();

    //* Tell everyone in the room, so open clients update without a refetch.
    safeEmitToChat(chatId, 'group_image_updated', {
        chatId,
        groupImage: chat.groupImage,
        updatedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName,
        },
    });

    return res.status(200).json(
        new ApiResponse(200, { chatId, groupImage: chat.groupImage }, 'Group image updated successfully')
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
