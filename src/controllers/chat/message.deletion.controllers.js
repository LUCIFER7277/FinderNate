import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import notificationCache from '../../utils/notificationCache.utils.js';
import { redisClient } from '../../config/redis.config.js';
import { safeEmitToChat, safeEmitToUser } from './helpers.js';

export const deleteMessageForEveryone = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    if (message.sender.toString() !== currentUserId.toString() &&
        !chat.admins?.includes(currentUserId)) {
        throw new ApiError(403, 'Not authorized to delete this message');
    }

    const messageAge = Date.now() - new Date(message.timestamp).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (messageAge > twentyFourHours) {
        throw new ApiError(400, 'Cannot delete messages older than 24 hours. Use "Delete for Me" instead.');
    }

    message.deletedForEveryone = true;
    message.deletedForEveryoneAt = new Date();
    message.deletedAt = new Date();
    message.originalMessage = message.message;
    message.message = '[Message deleted]';
    message.isDeleted = true;

    await message.save();

    const remainingLastMessage = await Message.findOne({
        chatId,
        $and: [
            { deletedForEveryone: { $ne: true } },
            { isDeleted: { $ne: true } }
        ]
    }).sort({ timestamp: -1 });

    if (remainingLastMessage) {
        chat.lastMessage = {
            sender: remainingLastMessage.sender,
            message: remainingLastMessage.message,
            timestamp: remainingLastMessage.timestamp
        };
        chat.lastMessageId = remainingLastMessage._id;
        chat.lastMessageAt = remainingLastMessage.timestamp;
    } else {
        chat.lastMessage = {};
        chat.lastMessageId = null;
        chat.lastMessageAt = chat.createdAt;
    }

    const messageCount = await Message.countDocuments({
        chatId,
        isDeleted: { $ne: true }
    });

    if (!chat.stats) {
        chat.stats = {};
    }
    chat.stats.totalMessages = messageCount;

    await chat.save();

    safeEmitToChat(chatId, 'message_deleted_for_everyone', {
        chatId,
        messageId,
        deletedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        },
        deletedAt: message.deletedForEveryoneAt.toISOString()
    });

    (async () => {
        try {
            const participantIds = chat.participants.map(p => p.toString());
            await notificationCache.invalidateMultipleUsersCache(participantIds, 'message');

            const cacheInvalidations = [];
            for (const participantId of participantIds) {
                for (let page = 1; page <= 3; page++) {
                    const activeKey = `chats:user:${participantId}:status:active:page:${page}:limit:20`;
                    const requestedKey = `chats:user:${participantId}:status:requested:page:${page}:limit:20`;
                    cacheInvalidations.push(
                        redisClient.del(activeKey),
                        redisClient.del(requestedKey)
                    );
                }
            }
            await Promise.all(cacheInvalidations);
        } catch (cacheError) {
            console.error('Error invalidating caches after message deletion:', cacheError);
        }
    })();

    return res.status(200).json(
        new ApiResponse(200, {}, 'Message deleted for everyone successfully')
    );
});

export const deleteMessageForMe = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    const alreadyDeleted = message.deletedFor.some(
        del => del.userId.toString() === currentUserId.toString()
    );

    if (alreadyDeleted) {
        throw new ApiError(400, 'Message already deleted for you');
    }

    message.deletedFor.push({
        userId: currentUserId,
        deletedAt: new Date()
    });

    await message.save();

    safeEmitToUser(currentUserId, 'message_deleted_for_me', {
        chatId,
        messageId
    });

    (async () => {
        try {
            await notificationCache.invalidateMessageCache(currentUserId.toString());

            const cacheInvalidations = [];
            for (let page = 1; page <= 3; page++) {
                const activeKey = `chats:user:${currentUserId}:status:active:page:${page}:limit:20`;
                const requestedKey = `chats:user:${currentUserId}:status:requested:page:${page}:limit:20`;
                cacheInvalidations.push(
                    redisClient.del(activeKey),
                    redisClient.del(requestedKey)
                );
            }
            await Promise.all(cacheInvalidations);
        } catch (cacheError) {
            console.error('Error invalidating caches after personal message deletion:', cacheError);
        }
    })();

    return res.status(200).json(
        new ApiResponse(200, {}, 'Message deleted for you successfully')
    );
});

export const restoreMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId,
        isDeleted: true
    });

    if (!message) {
        throw new ApiError(404, 'Deleted message not found');
    }

    if (message.sender.toString() !== currentUserId.toString() &&
        !chat.admins?.includes(currentUserId)) {
        throw new ApiError(403, 'Not authorized to restore this message');
    }

    const timeLimit = 24 * 60 * 60 * 1000;
    if (Date.now() - message.deletedAt.getTime() > timeLimit) {
        throw new ApiError(400, 'Message restoration time limit exceeded (24 hours)');
    }

    message.isDeleted = false;
    message.deletedAt = null;
    message.message = message.originalMessage || message.message;
    message.originalMessage = null;

    await message.save();

    const populatedMessage = await Message.findById(message._id)
        .populate('sender', 'username fullName profileImageUrl')
        .populate({
            path: 'replyTo',
            select: 'message sender timestamp',
            populate: {
                path: 'sender',
                select: 'username fullName'
            }
        })
        .lean();

    safeEmitToChat(chatId, 'message_restored', {
        chatId,
        messageId,
        restoredMessage: populatedMessage,
        restoredBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedMessage, 'Message restored successfully')
    );
});
