import Chat from '../models/chat.models.js';
import Message from '../models/message.models.js';
import Follower from '../models/follower.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadBufferToBunny } from '../utils/bunny.js';
import mongoose from 'mongoose';
import socketManager from '../config/socket.js';
import { sendPushNotification } from './pushNotification.controllers.js';
import { User } from '../models/user.models.js';
import { ChatPubSub, NotificationPubSub, LiveFeaturesPubSub } from '../utils/pubsub.utils.js';
import notificationCache from '../utils/notificationCache.utils.js';
import { redisClient } from '../config/redis.config.js';
import { getPrivacyFilteredStatus } from '../middlewares/messaging-privacy.middleware.js';
import { calculateMessageStatus } from '../utils/messageStatus.utils.js';

// Helper function to safely emit socket events
const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for chat ${chatId}`);
    }
};

const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for user ${userId}`);
    }
};

// Check if user follows another user
const checkFollowStatus = async (followerId, userId) => {
    const followRelation = await Follower.findOne({
        followerId,
        userId
    });

    return !!followRelation;
};

// Create a new chat (1-on-1 or group)
export const createChat = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { participants, chatType = 'direct', groupName, groupDescription, productContext } = req.body;

    if (!participants || !Array.isArray(participants) || participants.length < 2) {
        throw new ApiError(400, 'At least two participants required');
    }

    // Ensure current user is included in participants
    if (!participants.includes(currentUserId.toString())) {
        participants.push(currentUserId.toString());
    }

    // Validate participants exist and convert to ObjectIds
    const validParticipants = participants
        .filter(p => mongoose.Types.ObjectId.isValid(p))
        .map(p => new mongoose.Types.ObjectId(p)); // ✅ Convert to ObjectIds

    if (validParticipants.length !== participants.length) {
        throw new ApiError(400, 'Invalid participant IDs');
    }

    // Validate chat type constraints
    if (chatType === 'direct' && validParticipants.length !== 2) {
        throw new ApiError(400, 'Direct chats must have exactly 2 participants');
    }

    if (chatType === 'group' && validParticipants.length < 3) {
        throw new ApiError(400, 'Group chats must have at least 3 participants');
    }

    // ✅ FIXED: Sort participants as ObjectIds for consistent ordering
    validParticipants.sort((a, b) => a.toString().localeCompare(b.toString()));


    // Prevent duplicate 1-on-1 chats
    if (chatType === 'direct') {
        // ✅ IMPROVED: More robust duplicate detection for direct chats
        const existingChat = await Chat.findOne({
            chatType: 'direct',
            participants: { $all: validParticipants, $size: 2 }
        });


        if (existingChat) {
            // ✅ FIX: Check if follow status has changed since chat was created
            const otherUserId = validParticipants.find(id => id.toString() !== currentUserId.toString());
            const recipientFollowsSender = await checkFollowStatus(otherUserId, currentUserId);

            // If recipient no longer follows sender AND chat is currently active,
            // convert it to a request
            if (!recipientFollowsSender && existingChat.status === 'active') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId; // Update creator to current requester
            }
            // If recipient now follows sender AND chat is currently requested,
            // convert it to active (auto-accept)
            else if (recipientFollowsSender && existingChat.status === 'requested') {
                existingChat.status = 'active';
            }
            // If chat was declined, allow re-requesting
            else if (existingChat.status === 'declined') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId; // Update to new requester
            }

            // Before returning, make sure we're not showing deleted messages
            // Get the latest non-deleted message
            const lastMessage = await Message.findOne({
                chatId: existingChat._id,
                isDeleted: { $ne: true }
            }).sort({ timestamp: -1 });

            // Get the correct message count first
            const messageCount = await Message.countDocuments({
                chatId: existingChat._id,
                isDeleted: { $ne: true }
            });

            if (lastMessage) {
                existingChat.lastMessage = {
                    sender: lastMessage.sender,
                    message: lastMessage.message,
                    timestamp: lastMessage.timestamp
                };
                existingChat.lastMessageId = lastMessage._id;
                existingChat.lastMessageAt = lastMessage.timestamp;
            } else {
                // No non-deleted messages exist - clear all message-related fields
                existingChat.lastMessage = {};
                existingChat.lastMessageId = null;
                existingChat.lastMessageAt = existingChat.createdAt; // Reset to chat creation time
            }

            // Update stats in the same save operation
            if (!existingChat.stats) {
                existingChat.stats = {};
            }
            existingChat.stats.totalMessages = messageCount;
            existingChat.stats.totalParticipants = existingChat.participants.length;

            // Single save operation
            await existingChat.save();

            // Now populate and return
            const populatedChat = await Chat.findById(existingChat._id)
                .populate('participants', 'username fullName profileImageUrl')
                .populate('createdBy', 'username fullName profileImageUrl');

            // Add unread count for the current user
            const unreadCount = await Message.countDocuments({
                chatId: existingChat._id,
                isDeleted: { $ne: true },
                readBy: { $ne: currentUserId }
            });
            populatedChat.unreadCount = unreadCount;

            return res.status(200).json(
                new ApiResponse(200, populatedChat, 'Existing chat found')
            );
        }
    }

    const chatData = {
        participants: validParticipants,
        chatType,
        createdBy: currentUserId
    };

    // For direct chats, check if recipient follows sender to determine if chat should be a request
    if (chatType === 'direct' && validParticipants.length === 2) {
        const otherUserId = validParticipants.find(id => id.toString() !== currentUserId.toString());

        // Check if the recipient follows the sender
        const recipientFollowsSender = await checkFollowStatus(otherUserId, currentUserId);

        // If recipient doesn't follow sender, mark as requested chat
        if (!recipientFollowsSender) {
            chatData.status = 'requested';
        }
    }

    if (chatType === 'group') {
        if (!groupName) {
            throw new ApiError(400, 'Group name is required for group chats');
        }
        chatData.groupName = groupName;
        chatData.groupDescription = groupDescription;
        chatData.admins = [currentUserId];
    }

    // 🏷️ Add product context if provided (for business/product chats)
    if (productContext) {
        chatData.productContext = productContext;
    }

    const chat = await Chat.create(chatData);
    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    return res.status(201).json(
        new ApiResponse(201, populatedChat, 'Chat created successfully')
    );
});

// Get all chats for a user
export const getUserChats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { page = 1, limit = 20, chatStatus = 'active' } = req.query;

    // Ensure currentUserId is properly formatted as ObjectId
    const userObjectId = new mongoose.Types.ObjectId(currentUserId);

    const pageNum = parseInt(page) || 1;
    const pageLimit = Math.min(parseInt(limit) || 20, 50); // Max 50 chats per request
    const skip = (pageNum - 1) * pageLimit;

    // Check cache first
    const cacheKey = `chats:user:${currentUserId}:status:${chatStatus}:page:${pageNum}:limit:${pageLimit}`;
    try {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.status(200).json(JSON.parse(cachedData));
        }
    } catch (cacheError) {
        console.error('Cache read error:', cacheError);
        // Continue without cache
    }

    // Filter by chat status (active or requested)
    const statusFilter = ['active', 'requested'].includes(chatStatus) ? chatStatus : 'active';

    // ✅ FIXED: Different filtering logic based on requested status
    let chatFilter;

    if (statusFilter === 'requested') {
        // Show chats where:
        // 1. Status is 'requested' AND
        // 2. Current user is NOT the creator (they are the recipient)
        chatFilter = {
            participants: { $in: [userObjectId] },
            status: 'requested',
            createdBy: { $ne: userObjectId } // Only show requests sent TO this user
        };
    } else {
        // Show active chats OR requests sent BY this user
        chatFilter = {
            participants: { $in: [userObjectId] },
            $or: [
                { status: 'active' },
                { status: 'requested', createdBy: userObjectId } // Show requests sent BY this user
            ]
        };
    }

    // Only log in development for debugging
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
    }

    const [chats, total] = await Promise.all([
        Chat.find(chatFilter)
            .sort({ lastMessageAt: -1 })
            .skip(skip)
            .limit(pageLimit)
            .lean(),
        Chat.countDocuments(chatFilter)
    ]);

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
    }

    // Additional security check: Double-verify each chat contains the current user
    const secureChats = chats.filter(chat =>
        chat.participants.some(participantId =>
            participantId.toString() === currentUserId.toString()
        )
    );

    // ✅ DEDUPLICATION: Remove duplicate direct chats (keep most recent based on lastMessageAt)
    const deduplicatedChats = [];
    const seenParticipants = new Map();

    for (const chat of secureChats) {
        if (chat.chatType === 'direct' && chat.participants.length === 2) {
            // Create a unique key for this participant pair
            const participantKey = chat.participants
                .map(p => p.toString())
                .sort()
                .join(',');

            const existingChat = seenParticipants.get(participantKey);

            if (!existingChat) {
                // First chat with this participant pair - keep it
                seenParticipants.set(participantKey, chat);
                deduplicatedChats.push(chat);
            } else {
                // Duplicate found - keep the one with more recent activity
                const existingTimestamp = existingChat.lastMessageAt?.getTime() || existingChat.createdAt?.getTime() || 0;
                const currentTimestamp = chat.lastMessageAt?.getTime() || chat.createdAt?.getTime() || 0;

                if (currentTimestamp > existingTimestamp) {
                    // Replace with newer chat
                    const indexToReplace = deduplicatedChats.indexOf(existingChat);
                    if (indexToReplace !== -1) {
                        deduplicatedChats[indexToReplace] = chat;
                        seenParticipants.set(participantKey, chat);
                    }
                }
                // Only log duplicates once to avoid spam
                if (process.env.NODE_ENV === 'development' && !global._chatDuplicatesWarned) {
                    global._chatDuplicatesWarned = true;
                }
            }
        } else {
            // Group chats or non-standard chats - keep all
            deduplicatedChats.push(chat);
        }
    }

    // Only log security issues in development
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
        if (chats.length !== secureChats.length) {
            console.warn(`Security filter removed ${chats.length - secureChats.length} unauthorized chats for user ${currentUserId}`);
        }

        if (secureChats.length !== deduplicatedChats.length && !global._chatDuplicatesWarned) {
            console.warn(`⚠️ Deduplication removed ${secureChats.length - deduplicatedChats.length} duplicate chats. Run: node src/scripts/cleanupDuplicateChats.js`);
            global._chatDuplicatesWarned = true;
        }
    }

    // Get all chat IDs from deduplicated chats
    const chatIds = deduplicatedChats.map(chat => chat._id);

    // For each chat, find the last non-deleted message (excluding messages deleted for this user)
    const lastMessagesPromises = chatIds.map(chatId =>
        Message.findOne({
            chatId,
            $and: [
                { deletedForEveryone: { $ne: true } },
                { 'deletedFor.userId': { $ne: userObjectId } }
            ]
        })
            .sort({ timestamp: -1 })
            .populate('sender', 'username fullName profileImageUrl')
    );

    const lastMessages = await Promise.all(lastMessagesPromises);

    // Create a map for quick lookup
    const lastMessageMap = lastMessages.reduce((acc, message, index) => {
        if (message) {
            acc[chatIds[index].toString()] = {
                message,
                lastMessage: {
                    sender: message.sender,
                    message: message.message,
                    timestamp: message.timestamp
                }
            };
        }
        return acc;
    }, {});

    // Get unread counts AND message counts in a single aggregation
    const chatStats = await Message.aggregate([
        {
            $match: {
                chatId: { $in: chatIds },
                $and: [
                    { deletedForEveryone: { $ne: true } },
                    { 'deletedFor.userId': { $ne: userObjectId } }
                ]
            }
        },
        {
            $group: {
                _id: '$chatId',
                totalMessages: { $sum: 1 },
                unreadCount: {
                    $sum: {
                        $cond: [
                            { $not: { $in: [userObjectId, '$readBy'] } },
                            1,
                            0
                        ]
                    }
                }
            }
        }
    ]);

    // Create maps for quick lookup
    const unreadCountMap = {};
    const messageCountMap = {};

    chatStats.forEach(item => {
        const chatIdStr = item._id.toString();
        unreadCountMap[chatIdStr] = item.unreadCount;
        messageCountMap[chatIdStr] = item.totalMessages;
    });

    // Populate the chats with participants
    const populatedChatsPromise = Promise.all(deduplicatedChats.map(async (chat) => {
        const chatWithUsers = await Chat.populate(chat, [
            { path: 'participants', select: 'username fullName profileImageUrl accountStatus isDeleted' },
            { path: 'createdBy', select: 'username fullName profileImageUrl' }
        ]);

        // For direct chats, hide if the other participant is banned or deleted
        if (chatWithUsers.chatType === 'direct') {
            const otherParticipant = chatWithUsers.participants.find(
                p => p._id.toString() !== currentUserId.toString()
            );
            if (otherParticipant && (otherParticipant.isDeleted || otherParticipant.accountStatus !== 'active')) {
                return null; // Will be filtered out below
            }
        }

        // Strip admin-only fields before sending to client
        // NOTE: p may be a Mongoose document (not lean), so use explicit field access
        // instead of spread — spreading Mongoose docs can miss schema path getters
        chatWithUsers.participants = chatWithUsers.participants.map(p => ({
            _id: p._id,
            username: p.username,
            fullName: p.fullName,
            profileImageUrl: p.profileImageUrl || null
        }));

        // Update lastMessage with non-deleted message if available
        const chatId = chat._id.toString();
        let needsDbUpdate = false;

        if (lastMessageMap[chatId]) {
            const latestMessage = lastMessageMap[chatId].message;
            chatWithUsers.lastMessage = lastMessageMap[chatId].lastMessage;
            chatWithUsers.lastMessageId = latestMessage._id;

            // Check if database needs updating
            if (!chat.lastMessageId ||
                chat.lastMessageId.toString() !== latestMessage._id.toString() ||
                !chat.lastMessage?.message) {
                needsDbUpdate = true;
            }
        } else {
            chatWithUsers.lastMessage = {};
            chatWithUsers.lastMessageId = null;
            chatWithUsers.lastMessageAt = chat.createdAt;

            // Check if database needs clearing
            if (chat.lastMessageId ||
                (chat.lastMessage && Object.keys(chat.lastMessage).length > 0)) {
                needsDbUpdate = true;
            }
        }

        // Update database if needed to maintain consistency
        if (needsDbUpdate) {
            const updateData = lastMessageMap[chatId] ? {
                lastMessage: lastMessageMap[chatId].lastMessage,
                lastMessageId: lastMessageMap[chatId].message._id,
                lastMessageAt: lastMessageMap[chatId].message.timestamp
            } : {
                lastMessage: {},
                lastMessageId: null,
                lastMessageAt: chat.createdAt
            };

            // Update without waiting to avoid slowing down the response
            Chat.findByIdAndUpdate(chat._id, updateData).catch(err =>
                console.error('Failed to update chat metadata:', err)
            );
        }

        // Add message count stats from aggregation (no extra query needed)
        if (!chatWithUsers.stats) {
            chatWithUsers.stats = {};
        }
        chatWithUsers.stats.totalMessages = messageCountMap[chatId] || 0;
        chatWithUsers.stats.totalParticipants = chatWithUsers.participants.length;

        // Add unread count from aggregation
        chatWithUsers.unreadCount = unreadCountMap[chatId] || 0;

        return chatWithUsers;
    }));

    // Filter out nulls (chats with banned/deleted participants)
    const populatedChats = (await populatedChatsPromise).filter(Boolean);

    // Update total count to reflect deduplication
    const deduplicatedTotal = deduplicatedChats.length;
    const actualTotal = total; // Keep original total for pagination logic

    // Auto-join user to all their active chat rooms for real-time updates
    if (socketManager.isReady()) {
        const userSocketId = socketManager.connectedUsers.get(currentUserId.toString());
        if (userSocketId) {
            const io = socketManager.io;
            const socket = io.sockets.sockets.get(userSocketId);
            if (socket) {
                populatedChats.forEach(chat => {
                    if (!chat) return;
                    const chatId = chat._id.toString();
                    socket.join(`chat:${chatId}`);
                    socket.chatRooms = socket.chatRooms || new Set();
                    socket.chatRooms.add(chatId);
                });
            }
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            chats: populatedChats,
            chatStatus: statusFilter,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(actualTotal / pageLimit),
                totalChats: actualTotal,
                deduplicatedChatsReturned: deduplicatedTotal, // Add this for debugging
                hasNextPage: pageNum < Math.ceil(actualTotal / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Chats fetched successfully')
    );
});

// Accept a chat request
export const acceptChatRequest = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Find the chat and verify it's a request to the current user
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId,
        status: 'requested'
    });

    if (!chat) {
        throw new ApiError(404, 'Chat request not found or already processed');
    }

    // Ensure current user is receiving the request, not sending it
    const otherUserId = chat.participants.find(p => p.toString() !== currentUserId.toString());
    if (chat.createdBy.toString() === currentUserId.toString()) {
        throw new ApiError(400, 'You cannot accept your own chat request');
    }

    // Update chat status to active
    chat.status = 'active'
    await chat.save();

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    // Notify the other user via socket
    safeEmitToChat(chatId, 'chat_request_accepted', {
        chatId,
        acceptedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        },
        chat: populatedChat
    });

    return res.status(200).json(
        new ApiResponse(200, populatedChat, 'Chat request accepted successfully')
    );
});

// Decline a chat request
export const declineChatRequest = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Find the chat and verify it's a request to the current user
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId,
        status: 'requested'
    });

    if (!chat) {
        throw new ApiError(404, 'Chat request not found or already processed');
    }

    // Ensure current user is receiving the request, not sending it
    const otherUserId = chat.participants.find(p => p.toString() !== currentUserId.toString());
    if (chat.createdBy.toString() === currentUserId.toString()) {
        throw new ApiError(400, 'You cannot decline your own chat request');
    }

    // Option 1: Mark chat as declined
    chat.status = 'declined';
    await chat.save();

    // Option 2 (alternative): Delete the chat completely
    // await Chat.deleteOne({ _id: chatId });

    // Notify the other user via socket
    safeEmitToChat(chatId, 'chat_request_declined', {
        chatId,
        declinedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, { chatId }, 'Chat request declined successfully')
    );
});

// Get messages for a chat
export const getChatMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 50;
    const skip = (pageNum - 1) * pageLimit;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Auto-join user to chat room for real-time updates
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

    // Check if the chat is a request and not yet accepted
    if (chat.status === 'requested') {
        // If the current user is the recipient (not the creator), they can only see that there's a request
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

    // Build query to exclude deleted messages
    const messageQuery = {
        chatId,
        $and: [
            // Exclude messages deleted for everyone
            { deletedForEveryone: { $ne: true } },
            // Exclude messages deleted for this specific user
            { 'deletedFor.userId': { $ne: currentUserId } }
        ]
    };

    // Get messages with pagination using Message model
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

    // Process messages: hide content for deleted messages (WhatsApp-like behavior)
    const processedMessages = messages.map(msg => {
        if (msg.deletedForEveryone) {
            // Return message with deletion info but hide actual content
            return {
                ...msg,
                message: '', // Clear the message content
                mediaUrl: null, // Clear media
                fileName: null,
                fileSize: null,
                // Keep these for UI to show "This message was deleted"
                deletedForEveryone: true,
                deletedForEveryoneAt: msg.deletedForEveryoneAt
            };
        }
        return msg;
    });

    // If this is the first page, update chat's last message if needed
    // Find the latest non-deleted message for chat preview
    if (pageNum === 1 && processedMessages.length > 0) {
        const latestNonDeletedMessage = processedMessages.find(msg => !msg.deletedForEveryone);

        if (latestNonDeletedMessage) {
            // Update chat's last message if it's out of sync
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

    // Add message status for sender's messages
    const messagesWithStatus = processedMessages.map(msg => {
        // Only add status info if the current user is the sender
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
            messages: messagesWithStatus.reverse(), // Reverse to get chronological order
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

// Add a message to a chat
export const addMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Handle both FormData and JSON body
    const body = req.body || {};
    const message = body.message;
    const messageType = body.messageType || 'text';
    const replyTo = body.replyTo;
    const mediaFile = req.file; // File uploaded via FormData

    // 🏷️ Handle product reference for business/product-related chats
    const productReference = body.productReference ? (
        typeof body.productReference === 'string'
            ? JSON.parse(body.productReference)
            : body.productReference
    ) : null;

    // For media messages, allow empty message if file is present
    if ((!message || message.trim().length === 0) && !mediaFile) {
        throw new ApiError(400, 'Message content or media file is required');
    }

    // Set default message for media files if no message provided
    const finalMessage = message && message.trim().length > 0
        ? message.trim()
        : mediaFile
            ? `📎 ${mediaFile.originalname}`
            : '';

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Check if the chat is a request and not yet accepted
    if (chat.status === 'requested') {
        // Only the recipient (non-creator) is blocked from sending messages
        if (chat.createdBy.toString() !== currentUserId.toString()) {
            throw new ApiError(403, 'You must accept the chat request before sending messages');
        }
    } else if (chat.status === 'declined') {
        throw new ApiError(403, 'This chat request has been declined');
    }

    // Get all recipients (participants except sender)
    const recipients = chat.participants.filter(
        p => p.toString() !== currentUserId.toString()
    );

    // Create message data object
    const messageData = {
        chatId,
        sender: currentUserId,
        message: finalMessage,
        messageType, // ✅ Use the actual messageType from request
        timestamp: new Date(),
        readBy: [currentUserId],
        replyTo: replyTo || null,
        // Initialize delivery status for all recipients
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        }))
    };

    // 🏷️ Add product reference if provided (for business/product chats)
    if (productReference) {
        messageData.productReference = productReference;
    }

    // ✅ Handle file upload if present
    if (mediaFile) {
        try {
            // Upload file to Bunny.net
            const uploadResult = await uploadBufferToBunny(mediaFile.buffer, 'chat_media');

            // Add media fields to message data
            messageData.mediaUrl = uploadResult.secure_url;
            messageData.fileName = mediaFile.originalname;
            messageData.fileSize = mediaFile.size;

            // For videos, try to get duration from Bunny.net response
            if (uploadResult.duration) {
                messageData.duration = uploadResult.duration;
            }

            // Auto-detect message type if not provided
            if (messageType === 'text') {
                if (mediaFile.mimetype.startsWith('image/')) {
                    messageData.messageType = 'image';
                } else if (mediaFile.mimetype.startsWith('video/')) {
                    messageData.messageType = 'video';
                } else if (mediaFile.mimetype.startsWith('audio/')) {
                    messageData.messageType = 'audio';
                } else {
                    messageData.messageType = 'file';
                }
            }
        } catch (uploadError) {
            throw new ApiError(500, `Failed to upload media file: ${uploadError.message}`);
        }
    }

    // Create new message using Message model
    const newMessage = await Message.create(messageData);

    // Update chat's last message info
    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: currentUserId,
        message: finalMessage,
        timestamp: new Date()
    };
    chat.lastMessageId = newMessage._id;

    await chat.save();

    // Populate with selective fields only
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

    // Emit message - Socket.IO Redis adapter handles cross-process sync automatically
    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    // Send push notifications to other participants (fire-and-forget)
    (async () => {
        try {
            const otherParticipants = chat.participants.filter(
                participantId => participantId.toString() !== currentUserId.toString()
            );

            if (otherParticipants.length > 0) {
                // Get sender info for notification
                const sender = await User.findById(currentUserId).select('username fullName');
                const senderName = sender?.fullName || sender?.username || 'Unknown User';

                // Create notification data
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

                // Send push notifications
                await sendPushNotification(otherParticipants, notificationData);
            }
        } catch (pushError) {
            console.error('Error sending push notification:', pushError);
        }
    })();

    // Invalidate caches asynchronously (don't block response)
    (async () => {
        try {
            const participantIds = chat.participants.map(p => p.toString());

            // Invalidate message cache
            await notificationCache.invalidateMultipleUsersCache(participantIds, 'message');

            // Invalidate chat list cache for all participants (so they see updated lastMessage)
            const cacheInvalidations = [];
            for (const participantId of participantIds) {
                // Invalidate both active and requested chat lists (multiple pages)
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

// Mark messages as read
export const markMessagesRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { messageIds } = req.body; // Optional: mark specific messages as read

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const currentTime = new Date();

    if (messageIds && Array.isArray(messageIds)) {
        // Mark specific messages as read and update delivery status
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
        // Mark all unread messages in the chat as read and update delivery status
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

    // Emit real-time event for messages read
    safeEmitToChat(chatId, 'messages_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    // Invalidate message cache for the user who marked messages as read
    try {
        await notificationCache.invalidateMessageCache(currentUserId.toString());

        // Invalidate chat list cache so unread counts update on refresh
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
        // Don't block response if cache invalidation fails
    }

    return res.status(200).json(
        new ApiResponse(200, {}, 'Messages marked as read')
    );
});

// Mark all messages in a chat as read
export const markChatAsRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Update all unread messages in the chat to include current user in readBy array
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

    // Emit real-time event for chat marked as read
    safeEmitToChat(chatId, 'chat_marked_as_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    // Invalidate message cache for the user who marked chat as read
    try {
        await notificationCache.invalidateMessageCache(currentUserId.toString());

        // Invalidate chat list cache so unread counts update on refresh
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
        // Don't block response if cache invalidation fails
    }

    return res.status(200).json(
        new ApiResponse(200, {
            updatedCount: result.modifiedCount
        }, 'Chat marked as read')
    );
});

// Delete a message for everyone (24-hour limit)
export const deleteMessageForEveryone = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message
    const message = await Message.findOne({
        _id: messageId,
        chatId
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    // Only message sender or chat admin can delete
    if (message.sender.toString() !== currentUserId.toString() &&
        !chat.admins?.includes(currentUserId)) {
        throw new ApiError(403, 'Not authorized to delete this message');
    }

    // Check if message is within 24 hours
    const messageAge = Date.now() - new Date(message.timestamp).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    if (messageAge > twentyFourHours) {
        throw new ApiError(400, 'Cannot delete messages older than 24 hours. Use "Delete for Me" instead.');
    }

    // Delete for everyone
    message.deletedForEveryone = true;
    message.deletedForEveryoneAt = new Date();
    message.deletedAt = new Date(); // Keep for backward compatibility
    message.originalMessage = message.message; // Store original for potential restoration
    message.message = '[Message deleted]';
    message.isDeleted = true; // Keep for backward compatibility

    await message.save();

    // Update chat metadata after any message deletion
    // Find the most recent non-deleted message
    const remainingLastMessage = await Message.findOne({
        chatId,
        $and: [
            { deletedForEveryone: { $ne: true } },
            { isDeleted: { $ne: true } }
        ]
    }).sort({ timestamp: -1 });

    if (remainingLastMessage) {
        // Update chat with new last message
        chat.lastMessage = {
            sender: remainingLastMessage.sender,
            message: remainingLastMessage.message,
            timestamp: remainingLastMessage.timestamp
        };
        chat.lastMessageId = remainingLastMessage._id;
        chat.lastMessageAt = remainingLastMessage.timestamp;
    } else {
        // No messages left, clear last message completely
        chat.lastMessage = {};
        chat.lastMessageId = null;
        chat.lastMessageAt = chat.createdAt; // Reset to chat creation time
    }

    // Update message count in stats
    const messageCount = await Message.countDocuments({
        chatId,
        isDeleted: { $ne: true }
    });

    if (!chat.stats) {
        chat.stats = {};
    }
    chat.stats.totalMessages = messageCount;

    await chat.save();

    // Emit real-time event for message deletion for everyone
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

    // Invalidate caches asynchronously (don't block response)
    (async () => {
        try {
            const participantIds = chat.participants.map(p => p.toString());

            // Invalidate message cache for all participants
            await notificationCache.invalidateMultipleUsersCache(participantIds, 'message');

            // Invalidate chat list cache for all participants
            const cacheInvalidations = [];
            for (const participantId of participantIds) {
                // Invalidate both active and requested chat lists (multiple pages)
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

// Delete a message for me only (no time limit)
export const deleteMessageForMe = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message
    const message = await Message.findOne({
        _id: messageId,
        chatId
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    // Check if already deleted for this user
    const alreadyDeleted = message.deletedFor.some(
        del => del.userId.toString() === currentUserId.toString()
    );

    if (alreadyDeleted) {
        throw new ApiError(400, 'Message already deleted for you');
    }

    // Add user to deletedFor array
    message.deletedFor.push({
        userId: currentUserId,
        deletedAt: new Date()
    });

    await message.save();

    // Note: Do NOT update chat's lastMessage - this is a personal deletion
    // Only emit to the user who deleted it
    safeEmitToUser(currentUserId, 'message_deleted_for_me', {
        chatId,
        messageId
    });

    // Invalidate caches for the user who deleted the message
    (async () => {
        try {
            // Invalidate message cache
            await notificationCache.invalidateMessageCache(currentUserId.toString());

            // Invalidate chat list cache so they see updated lastMessage on refresh
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

// Restore a deleted message (admin or sender only)
export const restoreMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the deleted message
    const message = await Message.findOne({
        _id: messageId,
        chatId,
        isDeleted: true
    });

    if (!message) {
        throw new ApiError(404, 'Deleted message not found');
    }

    // Only message sender or chat admin can restore
    if (message.sender.toString() !== currentUserId.toString() &&
        !chat.admins?.includes(currentUserId)) {
        throw new ApiError(403, 'Not authorized to restore this message');
    }

    // Check if restoration is within time limit (24 hours)
    const timeLimit = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    if (Date.now() - message.deletedAt.getTime() > timeLimit) {
        throw new ApiError(400, 'Message restoration time limit exceeded (24 hours)');
    }

    // Restore the message
    message.isDeleted = false;
    message.deletedAt = null;
    message.message = message.originalMessage || message.message;
    message.originalMessage = null;

    await message.save();

    // Populate sender info for response
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

    // Emit real-time event for message restoration
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

// Start typing indicator
export const startTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Emit typing event to chat participants
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

// Stop typing indicator
export const stopTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Emit stop typing event to chat participants
    safeEmitToChat(chatId, 'user_stopped_typing', {
        userId: currentUserId,
        chatId
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Typing indicator stopped')
    );
});

// Get online status of users with privacy filtering
export const getOnlineStatus = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    let userIds = req.query.userIds;

    // Handle different formats of userIds in query
    if (typeof userIds === 'string') {
        // If it's a comma-separated string
        if (userIds.includes(',')) {
            userIds = userIds.split(',');
        }
        // If it's a single value
        else {
            userIds = [userIds];
        }
    }

    if (!userIds || !Array.isArray(userIds)) {
        throw new ApiError(400, "User IDs array is required");
    }

    // Get online status with privacy filtering
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

// Search messages in a chat
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

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Search messages using Message model
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

// Debug endpoint to help diagnose chat visibility issues
export const debugUserChats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;

    // Get all chats without any filtering first
    const allChats = await Chat.find({}).lean();

    // Check which chats the user appears in
    const userChats = allChats.filter(chat =>
        chat.participants.some(p => p.toString() === currentUserId.toString())
    );

    // Find problematic chats
    const invalidDirectChats = allChats.filter(chat =>
        chat.chatType === 'direct' && chat.participants.length !== 2
    );

    const duplicateDirectChats = [];
    const directChatGroups = {};

    allChats.filter(chat => chat.chatType === 'direct').forEach(chat => {
        const sortedParticipants = chat.participants.map(p => p.toString()).sort().join(',');
        if (directChatGroups[sortedParticipants]) {
            directChatGroups[sortedParticipants].push(chat);
        } else {
            directChatGroups[sortedParticipants] = [chat];
        }
    });

    Object.values(directChatGroups).forEach(group => {
        if (group.length > 1) {
            duplicateDirectChats.push(...group);
        }
    });

    return res.status(200).json(
        new ApiResponse(200, {
            currentUserId: currentUserId.toString(),
            totalChatsInSystem: allChats.length,
            userChatsCount: userChats.length,
            // Problem analysis
            invalidDirectChatsCount: invalidDirectChats.length,
            duplicateDirectChatsCount: duplicateDirectChats.length,
            // Detailed problem data
            invalidDirectChats: invalidDirectChats.map(c => ({
                id: c._id,
                participants: c.participants.map(p => p.toString()),
                participantCount: c.participants.length,
                chatType: c.chatType,
                createdAt: c.createdAt
            })),
            duplicateDirectChats: duplicateDirectChats.map(c => ({
                id: c._id,
                participants: c.participants.map(p => p.toString()),
                chatType: c.chatType,
                createdAt: c.createdAt
            })),
            // User's chats
            userChats: userChats.map(c => ({
                id: c._id,
                participants: c.participants.map(p => p.toString()),
                chatType: c.chatType,
                status: c.status,
                isProblematic: (c.chatType === 'direct' && c.participants.length !== 2)
            }))
        }, 'Debug information retrieved')
    );
});

// Cleanup endpoint to fix problematic chats (ADMIN ONLY - be careful!)
export const cleanupProblematicChats = asyncHandler(async (req, res) => {
    const { action = 'analyze' } = req.body; // 'analyze' or 'fix'

    // Find invalid direct chats (more than 2 participants)
    const invalidDirectChats = await Chat.find({
        chatType: 'direct',
        $expr: { $gt: [{ $size: '$participants' }, 2] }
    });

    // Find duplicate direct chats
    const allDirectChats = await Chat.find({ chatType: 'direct' });
    const duplicateGroups = {};

    allDirectChats.forEach(chat => {
        const sortedParticipants = chat.participants.map(p => p.toString()).sort().join(',');
        if (duplicateGroups[sortedParticipants]) {
            duplicateGroups[sortedParticipants].push(chat);
        } else {
            duplicateGroups[sortedParticipants] = [chat];
        }
    });

    const duplicateChatGroups = Object.values(duplicateGroups).filter(group => group.length > 1);
    const duplicateChats = duplicateChatGroups.flat();

    if (action === 'analyze') {
        return res.status(200).json(
            new ApiResponse(200, {
                analysis: {
                    invalidDirectChatsCount: invalidDirectChats.length,
                    duplicateChatGroupsCount: duplicateChatGroups.length,
                    totalDuplicateChats: duplicateChats.length
                },
                invalidDirectChats: invalidDirectChats.map(c => ({
                    id: c._id,
                    participants: c.participants,
                    participantCount: c.participants.length,
                    createdAt: c.createdAt
                })),
                duplicateChatGroups: duplicateChatGroups.map(group => ({
                    participants: group[0].participants,
                    chats: group.map(c => ({
                        id: c._id,
                        createdAt: c.createdAt,
                        lastMessageAt: c.lastMessageAt
                    }))
                }))
            }, 'Problematic chats analyzed')
        );
    }

    if (action === 'fix') {
        const results = {
            invalidChatsConverted: 0,
            duplicateChatsRemoved: 0,
            errors: []
        };

        try {
            // Convert invalid direct chats to group chats
            for (const chat of invalidDirectChats) {
                await Chat.findByIdAndUpdate(chat._id, {
                    chatType: 'group',
                    groupName: `Group Chat ${chat.participants.length} members`
                });
                results.invalidChatsConverted++;
            }

            // Remove duplicate chats (keep the oldest one in each group)
            for (const group of duplicateChatGroups) {
                const sortedGroup = group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                const chatToKeep = sortedGroup[0];
                const chatsToRemove = sortedGroup.slice(1);

                for (const chatToRemove of chatsToRemove) {
                    // Move messages to the chat we're keeping
                    await Message.updateMany(
                        { chatId: chatToRemove._id },
                        { chatId: chatToKeep._id }
                    );

                    // Delete the duplicate chat
                    await Chat.findByIdAndDelete(chatToRemove._id);
                    results.duplicateChatsRemoved++;
                }
            }

        } catch (error) {
            results.errors.push(error.message);
        }

        return res.status(200).json(
            new ApiResponse(200, results, 'Cleanup completed')
        );
    }

    throw new ApiError(400, 'Invalid action. Use "analyze" or "fix"');
});

// Update chat theme color
export const updateChatTheme = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { themeColor } = req.body;

    // Validate themeColor is provided
    if (!themeColor) {
        throw new ApiError(400, 'Theme color is required');
    }

    // Validate hex color format
    if (!/^#[0-9A-F]{6}$/i.test(themeColor)) {
        throw new ApiError(400, 'Invalid color format. Use hex color code (e.g., #DBB42C)');
    }

    // Find the chat and verify user is a participant
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    // Update theme color
    chat.themeColor = themeColor;
    await chat.save();

    // Get populated chat data
    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    // Notify all participants via socket about theme change
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

// ==================== ENHANCED MESSAGING FEATURES ====================

// Add reaction to a message
export const addReaction = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
        throw new ApiError(400, 'Emoji is required');
    }

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message
    const message = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    // Check if user already reacted with this emoji
    const existingReactionIndex = message.reactions.findIndex(
        r => r.user.toString() === currentUserId.toString()
    );

    if (existingReactionIndex !== -1) {
        // Update existing reaction
        message.reactions[existingReactionIndex].emoji = emoji;
        message.reactions[existingReactionIndex].timestamp = new Date();
    } else {
        // Add new reaction
        message.reactions.push({
            user: currentUserId,
            emoji,
            timestamp: new Date()
        });
    }

    await message.save();

    // Populate and return
    const populatedMessage = await Message.findById(messageId)
        .populate('sender', 'username fullName profileImageUrl')
        .populate('reactions.user', 'username fullName profileImageUrl')
        .lean();

    // Emit real-time event
    safeEmitToChat(chatId, 'message_reaction_added', {
        chatId,
        messageId,
        reaction: {
            user: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            emoji,
            timestamp: new Date()
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedMessage, 'Reaction added successfully')
    );
});

// Remove reaction from a message
export const removeReaction = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message and remove the user's reaction
    const message = await Message.findOneAndUpdate(
        {
            _id: messageId,
            chatId
        },
        {
            $pull: { reactions: { user: currentUserId } }
        },
        { new: true }
    ).populate('sender', 'username fullName profileImageUrl')
     .populate('reactions.user', 'username fullName profileImageUrl');

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    // Emit real-time event
    safeEmitToChat(chatId, 'message_reaction_removed', {
        chatId,
        messageId,
        userId: currentUserId.toString()
    });

    return res.status(200).json(
        new ApiResponse(200, message, 'Reaction removed successfully')
    );
});

// Edit a message (within 24 hours)
export const editMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { message: newContent } = req.body;

    if (!newContent || newContent.trim().length === 0) {
        throw new ApiError(400, 'Message content is required');
    }

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message
    const message = await Message.findOne({
        _id: messageId,
        chatId,
        sender: currentUserId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found or you are not the sender');
    }

    // Check if message is within 24 hours
    const messageAge = Date.now() - new Date(message.timestamp).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (messageAge > twentyFourHours) {
        throw new ApiError(400, 'Cannot edit messages older than 24 hours');
    }

    // Store original message if not already stored
    if (!message.originalMessage) {
        message.originalMessage = message.message;
    }

    // Update message
    message.message = newContent.trim();
    message.editedAt = new Date();

    await message.save();

    // Populate and return
    const populatedMessage = await Message.findById(messageId)
        .populate('sender', 'username fullName profileImageUrl')
        .populate('reactions.user', 'username fullName profileImageUrl')
        .lean();

    // Update chat's last message if this was the last message
    if (chat.lastMessageId && chat.lastMessageId.toString() === messageId) {
        chat.lastMessage.message = newContent.trim();
        await chat.save();
    }

    // Emit real-time event
    safeEmitToChat(chatId, 'message_edited', {
        chatId,
        messageId,
        newContent: newContent.trim(),
        editedAt: message.editedAt,
        editedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedMessage, 'Message edited successfully')
    );
});

// Forward a message to another chat
export const forwardMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { targetChatIds } = req.body;

    if (!targetChatIds || !Array.isArray(targetChatIds) || targetChatIds.length === 0) {
        throw new ApiError(400, 'Target chat IDs are required');
    }

    // Verify user is participant in the source chat
    const sourceChat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!sourceChat) {
        throw new ApiError(404, 'Source chat not found or access denied');
    }

    // Find the original message
    const originalMessage = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    }).populate('sender', 'username fullName');

    if (!originalMessage) {
        throw new ApiError(404, 'Message not found');
    }

    const forwardedMessages = [];

    for (const targetChatId of targetChatIds) {
        // Verify user is participant in the target chat
        const targetChat = await Chat.findOne({
            _id: targetChatId,
            participants: currentUserId
        });

        if (!targetChat) {
            continue; // Skip chats where user is not a participant
        }

        // Get all recipients in target chat (participants except sender)
        const recipients = targetChat.participants.filter(
            p => p.toString() !== currentUserId.toString()
        );

        // Create forwarded message
        const forwardedMessage = await Message.create({
            chatId: targetChatId,
            sender: currentUserId,
            message: originalMessage.message,
            messageType: originalMessage.messageType,
            mediaUrl: originalMessage.mediaUrl,
            fileName: originalMessage.fileName,
            fileSize: originalMessage.fileSize,
            duration: originalMessage.duration,
            timestamp: new Date(),
            readBy: [currentUserId],
            deliveryStatus: recipients.map(recipientId => ({
                userId: recipientId,
                status: 'sent',
                deliveredAt: null,
                seenAt: null
            })),
            forwardedFrom: {
                messageId: originalMessage._id,
                chatId: chatId,
                originalSender: originalMessage.sender._id
            }
        });

        // Update target chat's last message
        targetChat.lastMessageAt = new Date();
        targetChat.lastMessage = {
            sender: currentUserId,
            message: originalMessage.message,
            timestamp: new Date()
        };
        targetChat.lastMessageId = forwardedMessage._id;
        await targetChat.save();

        // Populate the message
        const populatedMessage = await Message.findById(forwardedMessage._id)
            .populate('sender', 'username fullName profileImageUrl')
            .lean();

        forwardedMessages.push(populatedMessage);

        // Emit to target chat
        safeEmitToChat(targetChatId, 'new_message', {
            chatId: targetChatId,
            message: {
                ...populatedMessage,
                isForwarded: true
            }
        });
    }

    return res.status(201).json(
        new ApiResponse(201, {
            forwardedCount: forwardedMessages.length,
            messages: forwardedMessages
        }, 'Message forwarded successfully')
    );
});

// Pin/Unpin a message
export const togglePinMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // Find the message
    const message = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    // Initialize pinnedMessages if not exists
    if (!chat.pinnedMessages) {
        chat.pinnedMessages = [];
    }

    const isPinned = chat.pinnedMessages.some(id => id.toString() === messageId);

    if (isPinned) {
        // Unpin
        chat.pinnedMessages = chat.pinnedMessages.filter(id => id.toString() !== messageId);
    } else {
        // Pin (limit to 3 pinned messages)
        if (chat.pinnedMessages.length >= 3) {
            throw new ApiError(400, 'Maximum 3 messages can be pinned. Unpin a message first.');
        }
        chat.pinnedMessages.push(messageId);
    }

    await chat.save();

    // Emit real-time event
    safeEmitToChat(chatId, 'message_pin_toggled', {
        chatId,
        messageId,
        isPinned: !isPinned,
        pinnedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, {
            messageId,
            isPinned: !isPinned,
            pinnedMessages: chat.pinnedMessages
        }, isPinned ? 'Message unpinned successfully' : 'Message pinned successfully')
    );
});

// Get pinned messages in a chat
export const getPinnedMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    // Verify user is participant in the chat
    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    if (!chat.pinnedMessages || chat.pinnedMessages.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, { messages: [] }, 'No pinned messages')
        );
    }

    const pinnedMessages = await Message.find({
        _id: { $in: chat.pinnedMessages },
        deletedForEveryone: { $ne: true }
    })
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    return res.status(200).json(
        new ApiResponse(200, { messages: pinnedMessages }, 'Pinned messages fetched successfully')
    );
}); 