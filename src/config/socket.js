import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { User } from '../models/user.models.js';
import { redisPubSub, redisPublisher, redisClient } from './redis.config.js';
import mongoose from 'mongoose';

class SocketManager {
    constructor() {
        this.io = null;
        this.connectedUsers = new Map(); // userId -> socketId
        this.userSockets = new Map(); // socketId -> userId
        this.chatRooms = new Map(); // chatId -> Set of socketIds
    }

    async initialize(server) {
        try {
            const allowedOrigins = [
                "https://p0k804os4c4scowcg488800c.194.164.151.15.sslip.io",
                "https://findernate.com",
                "https://www.findernate.com",
                "https://apis.findernate.com",
                "http://localhost:3000",
                "http://localhost:3001",
                "http://localhost:4000",
                "https://localhost:4000",
                "http://127.0.0.1:3000",
                "http://127.0.0.1:3001",
                "http://127.0.0.1:4000",
                "https://z0n8vrlt-4000.inc1.devtunnels.ms",
                 /^https?:\/\/[\w-]+\.194\.164\.151\.15\.sslip\.io$/
            ];

            // Allow all local network IPs for development
            if (process.env.NODE_ENV === 'development') {
                allowedOrigins.push(/^http:\/\/192\.168\.\d+\.\d+:4000$/);
            }

            this.io = new Server(server, {
                cors: {
                    origin: function (origin, callback) {
                        if (!origin) {
                            return callback(null, true);
                        }

                        // Check exact match first
                        if (allowedOrigins.includes(origin)) {
                            return callback(null, true);
                        }

                        // Check regex patterns (for local network IPs)
                        const regexPatterns = allowedOrigins.filter(pattern => pattern instanceof RegExp);
                        for (const pattern of regexPatterns) {
                            if (pattern.test(origin)) {
                                return callback(null, true);
                            }
                        }

                        console.warn(`Socket.IO CORS blocked origin: ${origin}`);
                        callback(new Error("Not allowed by CORS"));
                    },
                    methods: ["GET", "POST"],
                    credentials: true
                },
                // Add these options for better compatibility with nginx/reverse proxies
                transports: ['polling', 'websocket'],  // Try polling first, then upgrade to websocket
                allowEIO3: true,
                pingTimeout: 60000,
                pingInterval: 25000,
                connectTimeout: 45000,
                path: '/socket.io/',
                upgradeTimeout: 30000,  // Add upgrade timeout
                allowUpgrades: true     // Allow protocol upgrades
            });

            // Wait for Redis connections to be ready before setting up adapter
            await Promise.all([
                this.waitForRedisReady(redisPubSub),
                this.waitForRedisReady(redisPublisher)
            ]);

            // Setup Redis adapter for multi-instance scaling
            this.io.adapter(createAdapter(redisPubSub, redisPublisher));

            // Make socket.io globally available for notifications
            global.io = this.io;

            // Add process identification for debugging
            const PROCESS_ID = process.env.INSTANCE_ID || process.env.pm_id || `process-${process.pid}`;

            // Authentication middleware
            this.io.use(async (socket, next) => {
                try {
                    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

                    if (!token) {
                        return next(new Error('Authentication error: Token required'));
                    }

                    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
                    const user = await User.findById(decoded._id).select('-password');

                    if (!user) {
                        return next(new Error('Authentication error: User not found'));
                    }

                    socket.userId = user._id.toString();
                    socket.user = user;
                    next();
                } catch (error) {
                    next(new Error('Authentication error: Invalid token'));
                }
            });

            this.setupEventHandlers();
        } catch (error) {
            console.error('Failed to initialize Socket.IO:', error);
            this.io = null;
        }
    }

    setupEventHandlers() {
        this.io.on('connection', async (socket) => {
            // Store user connection locally AND in Redis for cross-process access
            this.connectedUsers.set(socket.userId, socket.id);
            this.userSockets.set(socket.id, socket.userId);

            // Track user's chat rooms for cleanup on disconnect
            socket.chatRooms = new Set();

            // Update lastSeenAt in database when user comes online
            try {
                await User.findByIdAndUpdate(socket.userId, {
                    lastSeenAt: new Date()
                });
            } catch (err) {
                console.error('Error updating lastSeenAt on connect:', err);
            }

            // Store in Redis with 24-hour expiry (auto-cleanup for stale connections)
            const PROCESS_ID = process.env.INSTANCE_ID || process.env.pm_id || `process-${process.pid}`;
            redisClient.hset('fn:online_users', socket.userId, JSON.stringify({
                socketId: socket.id,
                processId: PROCESS_ID,
                connectedAt: new Date().toISOString()
            })).catch(err => console.error('Redis user tracking error:', err));

            // Set TTL on online users hash key (24 hours)
            redisClient.expire('fn:online_users', 86400).catch(err =>
                console.error('Redis TTL error:', err)
            );

            // Join user to their personal room
            const userRoom = `user_${socket.userId}`;
            socket.join(userRoom);

            // Auto-join user to all their active chat rooms for real-time messaging
            (async () => {
                try {
                    const Chat = (await import('../models/chat.models.js')).default;
                    const activeChats = await Chat.find({
                        participants: socket.userId,
                        status: { $in: ['active', 'requested'] }
                    })
                        .select('_id')
                        .limit(50) // Limit to prevent overload
                        .lean();

                    activeChats.forEach(chat => {
                        const chatRoom = `chat:${chat._id}`;
                        socket.join(chatRoom);
                        socket.chatRooms.add(chat._id.toString());
                    });

                } catch (error) {
                    console.error(`❌ Error auto-joining chat rooms for user ${socket.userId}:`, error);
                }
            })();

            // Note: No Redis pattern subscriptions needed - Socket.IO rooms handle routing

            // Handle joining chat rooms
            socket.on('join_chat', (chatId) => {
                socket.join(`chat:${chatId}`);
                socket.chatRooms.add(chatId); // Track for cleanup
            });

            // Handle leaving chat rooms
            socket.on('leave_chat', (chatId) => {
                socket.leave(`chat:${chatId}`);
                socket.chatRooms.delete(chatId); // Remove from tracking
            });

            // Handle typing events
            socket.on('typing_start', (data) => {
                const { chatId } = data;

                // Emit to chat room - Socket.IO adapter syncs across processes
                socket.to(`chat:${chatId}`).emit('user_typing', {
                    userId: socket.userId,
                    username: socket.user.username,
                    fullName: socket.user.fullName,
                    chatId
                });
            });

            socket.on('typing_stop', (data) => {
                const { chatId } = data;
                socket.to(`chat:${chatId}`).emit('user_stopped_typing', {
                    userId: socket.userId,
                    chatId
                });
            });

            // Handle message events
            socket.on('send_message', (data) => {
                const { chatId, message, messageType = 'text', replyTo } = data;

                // Emit to all users in the chat (except sender)
                socket.to(`chat:${chatId}`).emit('new_message', {
                    chatId,
                    message: {
                        sender: {
                            _id: socket.userId,
                            username: socket.user.username,
                            fullName: socket.user.fullName,
                            profileImageUrl: socket.user.profileImageUrl
                        },
                        message,
                        messageType,
                        replyTo,
                        timestamp: new Date()
                    }
                });
            });

            // Handle message read events
            socket.on('mark_read', (data) => {
                const { chatId, messageIds } = data;

                // Emit to message senders that their messages were read
                socket.to(`chat:${chatId}`).emit('messages_read', {
                    chatId,
                    readBy: {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName
                    },
                    messageIds
                });
            });

            // Handle message delivery confirmation
            socket.on('confirm_delivery', async (data) => {
                const { messageIds } = data;
                const userId = socket.userId;

                try {
                    const Message = (await import('../models/message.models.js')).default;

                    // Update delivery status to 'delivered' using positional operator $
                    await Message.updateMany(
                        {
                            _id: { $in: messageIds },
                            'deliveryStatus.userId': userId,
                            'deliveryStatus.status': 'sent'
                        },
                        {
                            $set: {
                                'deliveryStatus.$.status': 'delivered',
                                'deliveryStatus.$.deliveredAt': new Date()
                            }
                        }
                    );

                    // Notify senders that messages were delivered
                    const messages = await Message.find({ _id: { $in: messageIds } })
                        .select('sender chatId')
                        .lean();

                    // Group by sender and emit to each unique sender
                    const senderMap = new Map();
                    messages.forEach(msg => {
                        const senderId = msg.sender.toString();
                        if (!senderMap.has(senderId)) {
                            senderMap.set(senderId, []);
                        }
                        senderMap.get(senderId).push(msg._id);
                    });

                    senderMap.forEach((msgIds, senderId) => {
                        socket.to(`user_${senderId}`).emit('messages_delivered', {
                            messageIds: msgIds,
                            deliveredTo: {
                                _id: userId,
                                username: socket.user.username,
                                fullName: socket.user.fullName
                            },
                            deliveredAt: new Date()
                        });
                    });
                } catch (error) {
                    console.error('Error confirming delivery:', error);
                }
            });

            // Handle message deletion
            // NOTE: It's recommended to use HTTP API (DELETE /chats/:chatId/messages/:messageId) instead
            // This socket event is kept for backward compatibility
            socket.on('delete_message', (data) => {
                const { chatId, messageId, deleteType = 'for_everyone' } = data;

                if (deleteType === 'for_me') {
                    // Only emit to the user who deleted it
                    socket.emit('message_deleted_for_me', {
                        chatId,
                        messageId
                    });
                } else {
                    // Emit to all participants in the chat
                    socket.to(`chat:${chatId}`).emit('message_deleted_for_everyone', {
                        chatId,
                        messageId,
                        deletedBy: {
                            _id: socket.userId,
                            username: socket.user.username,
                            fullName: socket.user.fullName
                        }
                    });
                }
            });

            // Handle message restoration
            socket.on('restore_message', (data) => {
                const { chatId, messageId, restoredMessage } = data;

                socket.to(`chat:${chatId}`).emit('message_restored', {
                    chatId,
                    messageId,
                    restoredMessage,
                    restoredBy: {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName
                    }
                });
            });

            // ===== ENHANCED MESSAGING EVENTS =====

            // Handle message reaction events (real-time sync)
            socket.on('add_reaction', (data) => {
                const { chatId, messageId, emoji, reaction } = data;
                
                socket.to(`chat:${chatId}`).emit('message_reaction_added', {
                    chatId,
                    messageId,
                    emoji,
                    reaction: reaction || {
                        emoji,
                        userId: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName,
                        profileImageUrl: socket.user.profileImageUrl,
                        createdAt: new Date()
                    }
                });
            });

            socket.on('remove_reaction', (data) => {
                const { chatId, messageId, emoji } = data;
                
                socket.to(`chat:${chatId}`).emit('message_reaction_removed', {
                    chatId,
                    messageId,
                    emoji,
                    userId: socket.userId
                });
            });

            // Handle message edit events (real-time sync)
            socket.on('edit_message', (data) => {
                const { chatId, messageId, newContent, editedAt, originalContent } = data;
                
                socket.to(`chat:${chatId}`).emit('message_edited', {
                    chatId,
                    messageId,
                    newContent,
                    editedAt: editedAt || new Date(),
                    editedBy: {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName
                    },
                    originalContent
                });
            });

            // Handle message forward events (real-time notification)
            socket.on('forward_message', (data) => {
                const { targetChatIds, originalMessage, newMessages } = data;
                
                // Emit to each target chat
                targetChatIds.forEach((targetChatId, index) => {
                    socket.to(`chat:${targetChatId}`).emit('message_forwarded', {
                        chatId: targetChatId,
                        originalMessage,
                        newMessage: newMessages?.[index],
                        forwardedBy: {
                            _id: socket.userId,
                            username: socket.user.username,
                            fullName: socket.user.fullName,
                            profileImageUrl: socket.user.profileImageUrl
                        },
                        timestamp: new Date()
                    });
                });
            });

            // Handle message pin events (real-time sync)
            socket.on('pin_message', (data) => {
                const { chatId, messageId, isPinned, pinnedMessage } = data;
                
                socket.to(`chat:${chatId}`).emit('message_pin_toggled', {
                    chatId,
                    messageId,
                    isPinned,
                    pinnedMessage,
                    pinnedBy: isPinned ? {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName
                    } : null,
                    timestamp: new Date()
                });
            });

            // Handle voice message recording notification (optional UX enhancement)
            socket.on('recording_voice', (data) => {
                const { chatId, isRecording } = data;
                
                socket.to(`chat:${chatId}`).emit('user_recording_voice', {
                    chatId,
                    userId: socket.userId,
                    username: socket.user.username,
                    fullName: socket.user.fullName,
                    isRecording,
                    timestamp: new Date()
                });
            });

            // ===== END ENHANCED MESSAGING EVENTS =====

            // Handle online status
            socket.on('set_online_status', (status) => {
                socket.to(`user_${socket.userId}`).emit('user_status_changed', {
                    userId: socket.userId,
                    status,
                    timestamp: new Date()
                });
            });

            // 🚀 NEW: Handle request for initial unread counts (alternative to HTTP polling)
            socket.on('request_unread_counts', async () => {
                try {
                    const notificationCache = (await import('../utils/notificationCache.utils.js')).default;
                    const counts = await notificationCache.getUnreadCounts(socket.userId);

                    socket.emit('unread_counts_updated', {
                        unreadNotifications: counts.unreadNotifications,
                        unreadMessages: counts.unreadMessages,
                        timestamp: new Date().toISOString(),
                        fromCache: counts.fromCache
                    });
                } catch (error) {
                    console.error('Error fetching unread counts via socket:', error);
                    socket.emit('unread_counts_error', {
                        error: 'Failed to fetch unread counts',
                        timestamp: new Date().toISOString()
                    });
                }
            });

            // ===== CALL SIGNALING EVENTS =====
            //
            // CALL FLOW WITH ZEGOCLOUD:
            // 1. Caller -> HTTP POST /calls/initiate -> Server saves call + generates ZegoCloud tokens
            // 2. Server -> Socket 'incoming_call' (with ZegoCloud room + token) -> Receiver
            // 3. Receiver -> HTTP PATCH /calls/:callId/accept -> Server updates DB
            // 4. Server -> Socket 'call_accepted' -> Caller
            // 5. Both clients connect to ZegoCloud using room ID and tokens from HTTP responses
            // 6. ZegoCloud SDK handles all audio/video streaming
            // 7. Either user -> HTTP PATCH /calls/:callId/end -> Server updates DB
            // 8. Server -> Socket 'call_ended' -> Other participants
            //
            // Note: These socket events are OPTIONAL for backwards compatibility
            // Clients should rely on HTTP endpoints for call state management

            // OPTIONAL: Handle call acceptance signaling (for real-time UI updates)
            // Main logic is in HTTP PATCH /api/v1/calls/:callId/accept
            socket.on('call_accept', async (data) => {
                const { callId, callerId } = data;

                // Real-time notification only - HTTP endpoint handles DB update
                this.emitToUser(callerId, 'call_accepted', {
                    callId,
                    acceptedBy: {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName,
                        profileImageUrl: socket.user.profileImageUrl
                    },
                    timestamp: new Date()
                });

            });

            // OPTIONAL: Handle call decline signaling (for real-time UI updates)
            // Main logic is in HTTP PATCH /api/v1/calls/:callId/decline
            socket.on('call_decline', (data) => {
                const { callId, callerId } = data;

                // Real-time notification only - HTTP endpoint handles DB update
                this.emitToUser(callerId, 'call_declined', {
                    callId,
                    declinedBy: {
                        _id: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName,
                        profileImageUrl: socket.user.profileImageUrl
                    },
                    timestamp: new Date()
                });
            });

            // OPTIONAL: Handle call end signaling (for real-time UI updates)
            // Main logic is in HTTP PATCH /api/v1/calls/:callId/end
            socket.on('call_end', (data) => {
                const { callId, participants, endReason = 'normal' } = data;

                // Real-time notification only - HTTP endpoint handles DB update
                participants
                    .filter(participantId => participantId !== socket.userId)
                    .forEach(participantId => {
                        this.emitToUser(participantId, 'call_ended', {
                            callId,
                            endedBy: {
                                _id: socket.userId,
                                username: socket.user.username,
                                fullName: socket.user.fullName,
                                profileImageUrl: socket.user.profileImageUrl
                            },
                            endReason,
                            timestamp: new Date()
                        });
                    });
            });


            // Handle disconnect
            socket.on('disconnect', async () => {
                const userId = socket.userId;

                // Clean up local tracking
                if (userId) {
                    this.connectedUsers.delete(userId);
                }
                this.userSockets.delete(socket.id);

                // Clean up all chat rooms the user was in
                if (socket.chatRooms && socket.chatRooms.size > 0) {
                    socket.chatRooms.forEach(chatId => {
                        socket.leave(`chat:${chatId}`);
                    });
                    socket.chatRooms.clear();
                }

                // Remove from Redis cross-process tracking
                if (userId) {
                    // Update lastSeenAt in database when user goes offline
                    try {
                        await User.findByIdAndUpdate(userId, {
                            lastSeenAt: new Date()
                        });
                    } catch (err) {
                        console.error('Error updating lastSeenAt on disconnect:', err);
                    }

                    redisClient.hdel('fn:online_users', userId)
                        .catch(err => console.error('Redis user removal error:', err));

                    // Emit offline status to relevant users with lastSeenAt
                    this.emitUserOffline(userId);
                }

                // 🚨 CRITICAL: End all active calls for the disconnected user
                // This prevents "already in a call" errors after disconnection
                if (!userId) {
                    console.warn('Socket disconnected without userId, skipping call cleanup');
                    return;
                }

                try {
                    const Call = (await import('../models/call.models.js')).default;

                    // Find all active calls where this user is a participant
                    const activeCalls = await Call.find({
                        participants: userId,
                        status: { $in: ['initiated', 'ringing', 'connecting', 'active'] }
                    }).select('_id participants'); // Only get IDs for efficiency

                    if (activeCalls.length > 0) {

                        for (const call of activeCalls) {
                            const callId = call._id;
                            const session = await mongoose.startSession();

                            try {
                                await session.withTransaction(async () => {
                                    // Re-fetch call within transaction to get latest state
                                    const callToUpdate = await Call.findById(callId).session(session);

                                    if (!callToUpdate) {
                                        console.warn(`Call ${callId} not found, skipping`);
                                        return;
                                    }

                                    // Skip if already ended (race condition protection)
                                    if (['ended', 'declined', 'missed', 'failed'].includes(callToUpdate.status)) {
                                        return;
                                    }

                                    // Update call status - following same pattern as endCall controller
                                    callToUpdate.status = 'ended';
                                    callToUpdate.endedAt = new Date();
                                    callToUpdate.endReason = 'network_error';
                                    callToUpdate.endedBy = userId;

                                    // If call was never started, set startedAt to endedAt for duration calculation
                                    if (!callToUpdate.startedAt) {
                                        callToUpdate.startedAt = callToUpdate.endedAt;
                                    }

                                    await callToUpdate.save({ session });
                                });
                            } catch (callError) {
                                console.error(`❌ Error ending call ${callId} on disconnect:`, callError);
                                // Continue with other calls even if one fails
                            } finally {
                                // Always end session
                                await session.endSession().catch(err =>
                                    console.error(`Error ending session for call ${callId}:`, err)
                                );
                            }

                            // Fetch populated call data after transaction to get correct duration and notify participants
                            try {
                                const populatedCall = await Call.findById(callId)
                                    .populate('participants', 'username fullName profileImageUrl')
                                    .populate('initiator', 'username fullName profileImageUrl');

                                if (!populatedCall) {
                                    console.warn(`Call ${callId} not found after transaction, skipping notification`);
                                    continue;
                                }

                                // Skip notification if call is not in ended state (might have been ended by another process)
                                if (populatedCall.status !== 'ended') {
                                    continue;
                                }

                                // Get other participants (excluding the disconnected user)
                                const participantIds = populatedCall.participants.map(p => p._id.toString());
                                const otherParticipants = participantIds.filter(id => id !== userId);

                                // Notify other participants via socket
                                if (otherParticipants.length > 0) {
                                    otherParticipants.forEach(participantId => {
                                        this.emitToUser(participantId, 'call_ended', {
                                            callId: callId.toString(),
                                            endedBy: {
                                                _id: userId,
                                                username: socket.user?.username || 'User',
                                                fullName: socket.user?.fullName || 'User',
                                                profileImageUrl: socket.user?.profileImageUrl
                                            },
                                            endReason: 'network_error',
                                            duration: populatedCall.duration || 0,
                                            timestamp: new Date()
                                        });
                                    });
                                }
                            } catch (notificationError) {
                                console.error(`❌ Error notifying participants about call ${callId} ending:`, notificationError);
                                // Continue with other calls even if notification fails
                            }
                        }
                    }
                } catch (error) {
                    console.error(`❌ Error handling call cleanup on disconnect for user ${userId}:`, error);
                    // Don't block disconnect cleanup if call ending fails
                }

            });
        });
    }

    // Utility methods

    // Check if user is online across all PM2 processes
    async isUserOnline(userId) {
        try {
            const userInfo = await redisClient.hget('fn:online_users', userId);
            return userInfo !== null;
        } catch (error) {
            console.error('Error checking user online status:', error);
            return false;
        }
    }

    // Get all online users across processes
    async getAllOnlineUsers() {
        try {
            const onlineUsers = await redisClient.hgetall('fn:online_users');
            return Object.keys(onlineUsers).map(userId => ({
                userId,
                ...JSON.parse(onlineUsers[userId])
            }));
        } catch (error) {
            console.error('Error getting online users:', error);
            return [];
        }
    }

    emitToUser(userId, event, data) {
        if (!this.io) {
            console.warn('Socket.IO not initialized, skipping emitToUser');
            return;
        }

        const roomName = `user_${userId}`;

        // Get all sockets in the user's room for debugging
        const socketsInRoom = this.io.sockets.adapter.rooms.get(roomName);
        const socketCount = socketsInRoom ? socketsInRoom.size : 0;


        // Emit to user's personal room (works across all PM2 processes via Redis adapter)
        // Use volatile emit for better performance (doesn't queue if client is offline)
        // For critical call events, we want immediate delivery
        if (['incoming_call', 'call_accepted', 'call_declined', 'call_ended', 'call_status_update'].includes(event)) {
            // For call events, use regular emit to ensure delivery
            this.io.to(roomName).emit(event, data);
        } else {
            // For other events, use volatile emit
            this.io.to(roomName).volatile.emit(event, data);
        }


        // Warn if no sockets are connected (user might be offline)
        if (socketCount === 0) {
            console.warn(`⚠️ No active socket connections for user ${userId} - event may not be delivered`);
        }
    }

    emitToChat(chatId, event, data) {
        if (this.io) {
            this.io.to(`chat:${chatId}`).emit(event, data);
        } else {
            console.warn(`Socket.IO not initialized, skipping emitToChat for chat ${chatId}, event: ${event}`);
        }
    }

    emitToUsers(userIds, event, data) {
        if (!this.io) {
            console.warn('Socket.IO not initialized, skipping emitToUsers');
            return;
        }
        userIds.forEach(userId => {
            this.emitToUser(userId, event, data);
        });
    }

    async emitUserOffline(userId) {
        if (!this.io) {
            console.warn('Socket.IO not initialized, skipping emitUserOffline');
            return;
        }
        // Get user's last seen timestamp
        let lastSeenAt = new Date();
        try {
            const user = await User.findById(userId).select('lastSeenAt').lean();
            if (user?.lastSeenAt) {
                lastSeenAt = user.lastSeenAt;
            }
        } catch (err) {
            console.error('Error fetching lastSeenAt for offline emit:', err);
        }
        // Emit to all users who might be interested in this user's status
        this.io.emit('user_offline', {
            userId,
            timestamp: new Date(),
            lastSeenAt
        });
    }

    // Check if user is online in current process only (legacy method)
    isUserOnlineLocal(userId) {
        return this.connectedUsers.has(userId);
    }

    getOnlineUsers() {
        return Array.from(this.connectedUsers.keys());
    }

    isReady() {
        return this.io !== null;
    }

    /**
     * Wait for a Redis instance to be ready
     * @param {Redis} redisInstance - Redis instance to wait for
     * @returns {Promise} - Promise that resolves when Redis is ready
     */
    async waitForRedisReady(redisInstance) {
        if (redisInstance.status === 'ready') {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Redis connection timeout'));
            }, 10000); // 10 second timeout

            redisInstance.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });

            redisInstance.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    // Removed: Pattern subscriptions no longer needed
    // Socket.IO rooms and Redis adapter handle all routing automatically
}

export default new SocketManager(); 
