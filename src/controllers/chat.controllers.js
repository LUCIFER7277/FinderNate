import Chat from '../models/chat.models.js';
import Message from '../models/message.models.js';
import Follower from '../models/follower.models.js';
import { ApiError } from '../utlis/ApiError.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { asyncHandler } from '../utlis/asyncHandler.js';
import { uploadBufferToBunny } from '../utlis/bunny.js';
import mongoose from 'mongoose';
import socketManager from '../config/socket.js';
import { sendPushNotification } from './pushNotification.controllers.js';
import { User } from '../models/user.models.js';
import { ChatPubSub, NotificationPubSub, LiveFeaturesPubSub } from '../utlis/pubsub.utils.js';
import notificationCache from '../utlis/notificationCache.utils.js';
import { redisClient } from '../config/redis.config.js';

// Helper function to safely emit socket events
const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for chat ${chatId}`);
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
    const { participants, chatType = 'direct', groupName, groupDescription } = req.body;

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

    console.log('💬 Create Chat Debug - Current User:', currentUserId);
    console.log('💬 Create Chat Debug - Valid Participants:', validParticipants.map(p => p.toString()));

    // Prevent duplicate 1-on-1 chats
    if (chatType === 'direct') {
        // ✅ IMPROVED: More robust duplicate detection for direct chats
        const existingChat = await Chat.findOne({
            chatType: 'direct',
            participants: { $all: validParticipants, $size: 2 }
        });

        console.log('💬 Create Chat Debug - Existing chat found:', !!existingChat);

        if (existingChat) {
            // ✅ FIX: Check if follow status has changed since chat was created
            const otherUserId = validParticipants.find(id => id.toString() !== currentUserId.toString());
            const recipientFollowsSender = await checkFollowStatus(otherUserId, currentUserId);

            // If recipient no longer follows sender AND chat is currently active,
            // convert it to a request
            if (!recipientFollowsSender && existingChat.status === 'active') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId; // Update creator to current requester
                console.log('💬 Chat converted to requested - recipient unfollowed sender');
            }
            // If recipient now follows sender AND chat is currently requested,
            // convert it to active (auto-accept)
            else if (recipientFollowsSender && existingChat.status === 'requested') {
                existingChat.status = 'active';
                console.log('💬 Chat auto-accepted - recipient now follows sender');
            }
            // If chat was declined, allow re-requesting
            else if (existingChat.status === 'declined') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId; // Update to new requester
                console.log('💬 Chat request re-sent after decline');
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
        console.log('💬 Chat Debug - User:', currentUserId);
        console.log('💬 Chat Debug - Status filter:', statusFilter);
        console.log('💬 Chat Debug - Chat filter:', JSON.stringify(chatFilter, null, 2));
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
        console.log('💬 Chat Debug - Chats found:', chats.length);
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
                    console.log(`⚠️ Duplicate chat detected for participants ${participantKey}. Run cleanup script: node src/scripts/cleanupDuplicateChats.js`);
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

    // For each chat, find the last non-deleted message
    const lastMessagesPromises = chatIds.map(chatId =>
        Message.findOne({
            chatId,
            isDeleted: { $ne: true }
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
                isDeleted: { $ne: true }
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
            { path: 'participants', select: 'username fullName profileImageUrl' },
            { path: 'createdBy', select: 'username fullName profileImageUrl' }
        ]);

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

    const populatedChats = await populatedChatsPromise;

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
                    const chatId = chat._id.toString();
                    socket.join(`chat:${chatId}`);
                    socket.chatRooms = socket.chatRooms || new Set();
                    socket.chatRooms.add(chatId);
                });
                console.log(`✅ Auto-joined user ${currentUserId} to ${populatedChats.length} chat rooms`);
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
                console.log(`✅ Auto-joined user ${currentUserId} to chat:${chatId}`);
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

    // Get messages with pagination using Message model
    const [messages, totalMessages] = await Promise.all([
        Message.find({
            chatId,
            isDeleted: { $ne: true } // Exclude deleted messages
        })
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pageLimit)
            .select('sender message messageType mediaUrl fileName fileSize duration timestamp readBy replyTo reactions')
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
        Message.countDocuments({
            chatId,
            isDeleted: { $ne: true } // Exclude deleted messages when counting
        })
    ]);

    // If this is the first page, update chat's last message if needed
    if (pageNum === 1 && messages.length > 0) {
        const latestMessage = messages[0];

        // Update chat's last message if it's out of sync
        if (!chat.lastMessageId ||
            (latestMessage._id.toString() !== chat.lastMessageId.toString())) {

            chat.lastMessage = {
                sender: latestMessage.sender._id,
                message: latestMessage.message,
                timestamp: latestMessage.timestamp
            };
            chat.lastMessageId = latestMessage._id;
            await chat.save();
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            messages: messages.reverse(), // Reverse to get chronological order
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

    // Create message data object
    const messageData = {
        chatId,
        sender: currentUserId,
        message: finalMessage,
        messageType, // ✅ Use the actual messageType from request
        timestamp: new Date(),
        readBy: [currentUserId],
        replyTo: replyTo || null
    };

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
            console.log(`✅ Invalidated caches for ${participantIds.length} participants`);
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

    if (messageIds && Array.isArray(messageIds)) {
        // Mark specific messages as read
        await Message.updateMany(
            {
                _id: { $in: messageIds },
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId }
            }
        );
    } else {
        // Mark all unread messages in the chat as read
        await Message.updateMany(
            {
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId }
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

// Delete a message
export const deleteMessage = asyncHandler(async (req, res) => {
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

    // Soft delete the message
    message.deletedAt = new Date();
    message.originalMessage = message.message; // Store original for potential restoration
    message.message = '[Message deleted]';
    message.isDeleted = true;

    await message.save();

    // Update chat metadata after any message deletion
    // Find the most recent non-deleted message
    const remainingLastMessage = await Message.findOne({
        chatId,
        isDeleted: { $ne: true }
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

    // Emit real-time event for message deletion
    safeEmitToChat(chatId, 'message_deleted', {
        chatId,
        messageId,
        deletedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Message deleted successfully')
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

// Get online status of users
export const getOnlineStatus = asyncHandler(async (req, res) => {
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

    // Rest of the function remains the same
    const onlineStatus = {};
    userIds.forEach(userId => {
        onlineStatus[userId] = socketManager.isReady() ? socketManager.isUserOnline(userId) : false;
    });

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