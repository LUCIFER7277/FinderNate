import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { User } from '../../models/user.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { uploadBufferToBunny } from '../../utils/bunny.js';
import socketManager from '../../config/socket.js';
import { sendPushNotification } from '../pushNotification.controllers.js';
import notificationCache from '../../utils/notificationCache.utils.js';
import { redisClient } from '../../config/redis.config.js';
import { calculateMessageStatus } from '../../utils/messageStatus.utils.js';
import { safeEmitToChat } from './helpers.js';

export const getChatMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 50;
    const skip = (pageNum - 1) * pageLimit;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    if (socketManager.isReady()) {
        const userSocketId = socketManager.connectedUsers.get(currentUserId.toString());
        if (userSocketId) {
            const io = socketManager.io;
            const socket = io.sockets.sockets.get(userSocketId);
            if (socket) {
                socket.join(`chat:${chatId}`);
                socket.chatRooms = socket.chatRooms || new Set();
                socket.chatRooms.add(chatId);
            }
        }
    }

    if (chat.status === 'requested') {
        if (chat.createdBy.toString() !== currentUserId.toString()) {
            return res.status(200).json(
                new ApiResponse(200, {
                    messages: [],
                    chatStatus: 'requested',
                    requestedBy: chat.createdBy,
                    pagination: {
                        currentPage: 1,
                        totalPages: 0,
                        totalMessages: 0,
                        hasNextPage: false,
                        hasPrevPage: false
                    }
                }, 'Chat request pending acceptance')
            );
        }
    } else if (chat.status === 'declined') {
        throw new ApiError(403, 'This chat request has been declined');
    }

    const messageQuery = {
        chatId,
        $and: [
            { deletedForEveryone: { $ne: true } },
            { 'deletedFor.userId': { $ne: currentUserId } }
        ]
    };

    const [messages, totalMessages] = await Promise.all([
        Message.find(messageQuery)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pageLimit)
            .select('sender message messageType mediaUrl fileName fileSize duration timestamp readBy replyTo reactions deletedForEveryone productReference linkPreview checkoutDetails isEdited isForwarded forwardedFrom isPinned deliveryStatus fontStyle waveform')
            .populate('sender', 'username fullName profileImageUrl')
            .populate({
                path: 'replyTo',
                select: 'message sender timestamp',
                populate: {
                    path: 'sender',
                    select: 'username fullName'
                }
            })
            .lean(),
        Message.countDocuments(messageQuery)
    ]);

    const processedMessages = messages.map(msg => {
        if (msg.deletedForEveryone) {
            return {
                ...msg,
                message: '',
                mediaUrl: null,
                fileName: null,
                fileSize: null,
                deletedForEveryone: true,
                deletedForEveryoneAt: msg.deletedForEveryoneAt
            };
        }
        return msg;
    });

    if (pageNum === 1 && processedMessages.length > 0) {
        const latestNonDeletedMessage = processedMessages.find(msg => !msg.deletedForEveryone);

        if (latestNonDeletedMessage) {
            if (!chat.lastMessageId ||
                (latestNonDeletedMessage._id.toString() !== chat.lastMessageId.toString())) {
                chat.lastMessage = {
                    sender: latestNonDeletedMessage.sender._id,
                    message: latestNonDeletedMessage.message,
                    timestamp: latestNonDeletedMessage.timestamp
                };
                chat.lastMessageId = latestNonDeletedMessage._id;
                await chat.save();
            }
        }
    }

    const messagesWithStatus = processedMessages.map(msg => {
        if (msg.sender._id.toString() === currentUserId.toString()) {
            return {
                ...msg,
                status: calculateMessageStatus(msg, chat.participants)
            };
        }
        return msg;
    });

    return res.status(200).json(
        new ApiResponse(200, {
            messages: messagesWithStatus.reverse(),
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalMessages / pageLimit),
                totalMessages,
                hasNextPage: pageNum < Math.ceil(totalMessages / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Messages fetched successfully')
    );
});

export const addMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const body = req.body || {};
    const message = body.message;
    const messageType = body.messageType || 'text';
    const replyTo = body.replyTo;
    const mediaFile = req.file;

    const productReference = (messageType === 'contact_seller' && body.productReference) ? (
        typeof body.productReference === 'string'
            ? JSON.parse(body.productReference)
            : body.productReference
    ) : null;

    if ((!message || message.trim().length === 0) && !mediaFile) {
        throw new ApiError(400, 'Message content or media file is required');
    }

    const finalMessage = message && message.trim().length > 0
        ? message.trim()
        : mediaFile
            ? `📎 ${mediaFile.originalname}`
            : '';

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    if (chat.status === 'requested') {
        if (chat.createdBy.toString() !== currentUserId.toString()) {
            throw new ApiError(403, 'You must accept the chat request before sending messages');
        }
    } else if (chat.status === 'declined') {
        throw new ApiError(403, 'This chat request has been declined');
    }

    const recipients = chat.participants.filter(
        p => p.toString() !== currentUserId.toString()
    );

    const messageData = {
        chatId,
        sender: currentUserId,
        message: finalMessage,
        messageType,
        timestamp: new Date(),
        readBy: [currentUserId],
        replyTo: replyTo || null,
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        }))
    };

    if (productReference) {
        messageData.productReference = productReference;
    }

    if (mediaFile) {
        // Per-type size limits
        const CHAT_MEDIA_LIMITS = {
            audio: 6 * 1024 * 1024,   // 6 MB
            video: 50 * 1024 * 1024,  // 50 MB
            file: 7 * 1024 * 1024,    // 7 MB  (documents)
            image: 10 * 1024 * 1024,  // 10 MB (images)
        };

        let detectedCategory;
        if (mediaFile.mimetype.startsWith('image/')) {
            detectedCategory = 'image';
        } else if (mediaFile.mimetype.startsWith('video/')) {
            detectedCategory = 'video';
        } else if (mediaFile.mimetype.startsWith('audio/')) {
            detectedCategory = 'audio';
        } else {
            detectedCategory = 'file';
        }

        const sizeLimit = CHAT_MEDIA_LIMITS[detectedCategory];
        if (mediaFile.size > sizeLimit) {
            const limitMB = sizeLimit / (1024 * 1024);
            throw new ApiError(400, `${detectedCategory.charAt(0).toUpperCase() + detectedCategory.slice(1)} file too large. Maximum allowed size is ${limitMB} MB`);
        }

        const folderMap = {
            image: 'chat_images',
            video: 'chat_videos',
            audio: 'chat_audio',
            file: 'chat_files',
        };

        try {
            const uploadResult = await uploadBufferToBunny(
                mediaFile.buffer,
                folderMap[detectedCategory],
                mediaFile.originalname,
                mediaFile.mimetype
            );
            messageData.mediaUrl = uploadResult.secure_url;
            messageData.fileName = mediaFile.originalname;
            messageData.fileSize = mediaFile.size;

            if (uploadResult.duration) {
                messageData.duration = uploadResult.duration;
            }

            if (messageType === 'text') {
                const categoryToMsgType = {
                    image: 'image',
                    video: 'video',
                    audio: 'audio',
                    file: 'file',
                };
                messageData.messageType = categoryToMsgType[detectedCategory];
            }
        } catch (uploadError) {
            throw new ApiError(500, `Failed to upload media file: ${uploadError.message}`);
        }
    }

    const newMessage = await Message.create(messageData);

    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: currentUserId,
        message: finalMessage,
        messageType: messageData.messageType,
        timestamp: new Date()
    };
    chat.lastMessageId = newMessage._id;
    await chat.save();

    const populatedMessage = await Message.findById(newMessage._id)
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

    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    (async () => {
        try {
            const otherParticipants = chat.participants.filter(
                participantId => participantId.toString() !== currentUserId.toString()
            );

            if (otherParticipants.length > 0) {
                const sender = await User.findById(currentUserId).select('username fullName');
                const senderName = sender?.fullName || sender?.username || 'Unknown User';

                const notificationData = {
                    title: `New message from ${senderName}`,
                    body: messageType === 'text'
                        ? finalMessage.length > 50 ? finalMessage.substring(0, 50) + '...' : finalMessage
                        : `Sent ${messageType === 'image' ? 'an image' : messageType === 'video' ? 'a video' : messageType === 'audio' ? 'an audio' : 'a file'}`,
                    chatId: chatId,
                    messageId: newMessage._id.toString(),
                    senderId: currentUserId.toString(),
                    url: `/chats?chatId=${chatId}`
                };

                await sendPushNotification(otherParticipants, notificationData);
            }
        } catch (pushError) {
            console.error('Error sending push notification:', pushError);
        }
    })();

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
            console.error('Error invalidating caches:', cacheError);
        }
    })();

    return res.status(201).json(
        new ApiResponse(201, populatedMessage, 'Message sent successfully')
    );
});

export const markMessagesRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { messageIds } = req.body;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const currentTime = new Date();

    if (messageIds && Array.isArray(messageIds)) {
        await Message.updateMany(
            {
                _id: { $in: messageIds },
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId },
                $set: {
                    'deliveryStatus.$[elem].status': 'seen',
                    'deliveryStatus.$[elem].seenAt': currentTime
                }
            },
            {
                arrayFilters: [{ 'elem.userId': currentUserId }]
            }
        );
    } else {
        await Message.updateMany(
            {
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId },
                $set: {
                    'deliveryStatus.$[elem].status': 'seen',
                    'deliveryStatus.$[elem].seenAt': currentTime
                }
            },
            {
                arrayFilters: [{ 'elem.userId': currentUserId }]
            }
        );
    }

    safeEmitToChat(chatId, 'messages_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

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
        console.error('Error invalidating message cache:', cacheError);
    }

    return res.status(200).json(
        new ApiResponse(200, {}, 'Messages marked as read')
    );
});

export const markChatAsRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const result = await Message.updateMany(
        {
            chatId,
            readBy: { $ne: currentUserId },
            isDeleted: { $ne: true }
        },
        {
            $addToSet: { readBy: currentUserId }
        }
    );

    safeEmitToChat(chatId, 'chat_marked_as_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

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
        console.error('Error invalidating message cache:', cacheError);
    }

    return res.status(200).json(
        new ApiResponse(200, {
            updatedCount: result.modifiedCount
        }, 'Chat marked as read')
    );
});

export const searchMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { query, page = 1, limit = 20 } = req.query;

    if (!query || query.trim().length === 0) {
        throw new ApiError(400, 'Search query is required');
    }

    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (pageNum - 1) * pageLimit;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const [searchResults, totalResults] = await Promise.all([
        Message.find({
            chatId,
            message: { $regex: query, $options: 'i' },
            isDeleted: { $ne: true }
        })
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pageLimit)
            .select('sender message messageType timestamp')
            .populate('sender', 'username fullName profileImageUrl')
            .lean(),
        Message.countDocuments({
            chatId,
            message: { $regex: query, $options: 'i' },
            isDeleted: { $ne: true }
        })
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            messages: searchResults,
            query,
            totalResults,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalResults / pageLimit),
                hasNextPage: pageNum < Math.ceil(totalResults / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Search completed successfully')
    );
});
