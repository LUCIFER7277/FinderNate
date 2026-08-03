import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { User } from '../models/user.models.js';
import { redisPubSub, redisPublisher, redisClient } from './redis.config.js';
import mongoose from 'mongoose';

// How long a user may be gone before their active calls are torn down. Mobile
// clients disconnect constantly (screen lock, network handoff, backgrounding)
// and reconnect within a couple of seconds — ending the call immediately turned
// every one of those into a dropped call.
const CALL_DISCONNECT_GRACE_MS = 20 * 1000;

// Per-socket chat authorization cache. Positive results are kept for the life of
// the connection; denials expire so a chat created mid-session is not blocked.
const CHAT_ACCESS_CACHE_LIMIT = 200;
const CHAT_ACCESS_DENY_TTL_MS = 30 * 1000;

// Upper bounds on client-supplied arrays so one emit cannot fan out unboundedly
const MAX_MESSAGE_IDS = 200;
const MAX_FORWARD_TARGETS = 20;

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

                    // Mirror the HTTP guard (auth.middleware.js:61-71) — a deleted,
                    // banned or deactivated account must not hold a real-time
                    // connection either, otherwise moderation stops at REST.
                    if (user.isDeleted) {
                        return next(new Error('Authentication error: Account deleted'));
                    }

                    if (user.accountStatus === 'banned') {
                        return next(new Error('Authentication error: Account banned'));
                    }

                    if (user.accountStatus === 'deactivated') {
                        return next(new Error('Authentication error: Account deactivated'));
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

    /**
     * Client payloads are untrusted — only ever hand Mongoose a real ObjectId string.
     * @param {*} value - candidate id from a socket payload
     * @returns {boolean}
     */
    isValidId(value) {
        return typeof value === 'string' && value.length === 24 && mongoose.Types.ObjectId.isValid(value);
    }

    /**
     * Load a chat only if the given user is one of its participants.
     * @returns {Promise<Object|null>} the chat (_id + admins) or null when not a member
     */
    async loadChatForUser(chatId, userId) {
        if (!this.isValidId(chatId)) {
            return null;
        }

        try {
            const Chat = (await import('../models/chat.models.js')).default;
            return await Chat.findOne({ _id: chatId, participants: userId })
                .select('_id admins')
                .lean();
        } catch (error) {
            console.error(`Error loading chat ${chatId} for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * Authorization gate for every chat-scoped socket event. Without this a socket
     * could emit into `chat:<anyId>` — socket.to() does not require membership.
     * Results are cached per socket so an open chat costs at most one lookup, and
     * denials are cached too so a hostile client cannot turn emits into DB load.
     */
    async isChatParticipant(socket, chatId) {
        if (!this.isValidId(chatId)) {
            return false;
        }

        // Rooms are only joined after this same check, so membership implies access
        if (socket.chatRooms?.has(chatId)) {
            return true;
        }

        if (!socket.chatAccess) {
            socket.chatAccess = new Map();
        }

        const cached = socket.chatAccess.get(chatId);
        if (cached && (cached.allowed || Date.now() - cached.at < CHAT_ACCESS_DENY_TTL_MS)) {
            return cached.allowed;
        }

        // Bound the cache — a client emitting random ids must not grow it forever
        if (socket.chatAccess.size >= CHAT_ACCESS_CACHE_LIMIT) {
            socket.chatAccess.clear();
        }

        const chat = await this.loadChatForUser(chatId, socket.userId);
        socket.chatAccess.set(chatId, { allowed: Boolean(chat), at: Date.now() });
        return Boolean(chat);
    }

    /**
     * Load a message only if it belongs to the given chat AND the user is allowed to
     * act on it — mirrors the HTTP rules in message.deletion.controllers.js:32-35
     * (sender or chat admin) and message.features.controllers.js:131-140 (sender only).
     */
    async loadOwnMessage(chat, messageId, userId, allowAdmin = true) {
        if (!this.isValidId(messageId)) {
            return null;
        }

        try {
            const Message = (await import('../models/message.models.js')).default;
            const message = await Message.findOne({ _id: messageId, chatId: chat._id })
                .select('sender')
                .lean();

            if (!message) {
                return null;
            }

            if (message.sender?.toString() === userId) {
                return message;
            }

            const isAdmin = (chat.admins || []).some(adminId => adminId?.toString() === userId);
            return (allowAdmin && isAdmin) ? message : null;
        } catch (error) {
            console.error(`Error loading message ${messageId} for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * Load a call only if the given user is one of its participants. Recipients are
     * then taken from the stored document, never from the client payload.
     */
    async loadCallForUser(callId, userId) {
        if (!this.isValidId(callId)) {
            return null;
        }

        try {
            const Call = (await import('../models/call.models.js')).default;
            return await Call.findOne({ _id: callId, participants: userId })
                .select('_id participants initiator')
                .lean();
        } catch (error) {
            console.error(`Error loading call ${callId} for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * Does this user still have another live socket anywhere in the fleet?
     * fetchSockets() goes through the Redis adapter, so other instances count too.
     */
    async hasOtherSockets(userId, excludeSocketId) {
        if (!this.io) {
            return false;
        }

        const userRoom = `user_${userId}`;

        // Cheap local check first — no adapter round-trip when the user is still
        // connected to this instance
        const localRoom = this.io.sockets.adapter.rooms.get(userRoom);
        if (localRoom && Array.from(localRoom).some(socketId => socketId !== excludeSocketId)) {
            return true;
        }

        try {
            const sockets = await this.io.in(userRoom).fetchSockets();
            return sockets.some(remoteSocket => remoteSocket.id !== excludeSocketId);
        } catch (error) {
            console.error(`Error checking remaining sockets for user ${userId}:`, error);
            return false;
        }
    }

    setupEventHandlers() {
        this.io.on('connection', async (socket) => {
            // Every listener below is registered through this wrapper. Socket.IO does
            // not wrap listener invocation, so a throw inside one escapes as an
            // uncaughtException — and index.js exits the process on those. One
            // malformed emit would otherwise take the whole backend down.
            const on = (event, handler) => {
                socket.on(event, async (...args) => {
                    try {
                        await handler(...args);
                    } catch (error) {
                        console.error(`❌ Socket '${event}' handler error (user ${socket.userId}):`, error);
                    }
                });
            };

            // Store user connection locally AND in Redis for cross-process access
            this.connectedUsers.set(socket.userId, socket.id);
            this.userSockets.set(socket.id, socket.userId);

            // Track user's chat rooms for cleanup on disconnect
            socket.chatRooms = new Set();

            // Update lastSeenAt in database when user comes online.
            // Not awaited: awaiting here delayed listener registration below, so
            // events the client emits immediately on connect (join_chat) were lost.
            User.findByIdAndUpdate(socket.userId, {
                lastSeenAt: new Date()
            }).catch(err => console.error('Error updating lastSeenAt on connect:', err));

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
                        .sort({ updatedAt: -1 }) // most recently active first — unsorted, the 50 cap dropped users' newest chats
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

            // Handle joining chat rooms — the caller must actually be a participant,
            // otherwise any logged-in account could subscribe to any conversation
            on('join_chat', async (chatId) => {
                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed) {
                    console.warn(`Blocked join_chat from user ${socket.userId} for chat ${typeof chatId === 'string' ? chatId : typeof chatId}`);
                    return;
                }

                socket.join(`chat:${chatId}`);
                socket.chatRooms.add(chatId); // Track for cleanup
            });

            // Handle leaving chat rooms
            on('leave_chat', (chatId) => {
                if (typeof chatId !== 'string') {
                    return;
                }

                socket.leave(`chat:${chatId}`);
                socket.chatRooms.delete(chatId); // Remove from tracking
            });

            // Handle typing events
            on('typing_start', async (data) => {
                const { chatId } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed) {
                    return;
                }

                // Emit to chat room - Socket.IO adapter syncs across processes
                socket.to(`chat:${chatId}`).emit('user_typing', {
                    userId: socket.userId,
                    username: socket.user.username,
                    fullName: socket.user.fullName,
                    chatId
                });
            });

            on('typing_stop', async (data) => {
                const { chatId } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed) {
                    return;
                }

                socket.to(`chat:${chatId}`).emit('user_stopped_typing', {
                    userId: socket.userId,
                    chatId
                });
            });

            // Handle message events
            on('send_message', async (data) => {
                const { chatId, message, messageType = 'text', replyTo } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed) {
                    return;
                }

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
            on('mark_read', async (data) => {
                const { chatId, messageIds } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed || !Array.isArray(messageIds)) {
                    return;
                }

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
            on('confirm_delivery', async (data) => {
                const { messageIds } = data || {};
                const userId = socket.userId;

                // Only real ids, and a bounded number of them
                const ids = Array.isArray(messageIds)
                    ? messageIds.filter(id => this.isValidId(id)).slice(0, MAX_MESSAGE_IDS)
                    : [];

                if (ids.length === 0) {
                    return;
                }

                try {
                    const Message = (await import('../models/message.models.js')).default;

                    // Update delivery status to 'delivered' using positional operator $
                    await Message.updateMany(
                        {
                            _id: { $in: ids },
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

                    // Notify senders that messages were delivered. Scoped to messages
                    // actually addressed to this user so arbitrary ids cannot be probed.
                    const messages = await Message.find({
                        _id: { $in: ids },
                        'deliveryStatus.userId': userId
                    })
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
            on('delete_message', async (data) => {
                const { chatId, messageId, deleteType = 'for_everyone' } = data || {};

                if (deleteType === 'for_me') {
                    const allowed = await this.isChatParticipant(socket, chatId);
                    if (!allowed || !this.isValidId(messageId)) {
                        return;
                    }

                    // Only emit to the user who deleted it
                    socket.emit('message_deleted_for_me', {
                        chatId,
                        messageId
                    });
                    return;
                }

                // Same rule as the HTTP delete: participant, and sender or chat admin.
                // Without it any account could erase any message on both clients' screens.
                const chat = await this.loadChatForUser(chatId, socket.userId);
                if (!chat) {
                    return;
                }

                const message = await this.loadOwnMessage(chat, messageId, socket.userId);
                if (!message) {
                    return;
                }

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
            });

            // Handle message restoration
            on('restore_message', async (data) => {
                const { chatId, messageId, restoredMessage } = data || {};

                const chat = await this.loadChatForUser(chatId, socket.userId);
                if (!chat) {
                    return;
                }

                const message = await this.loadOwnMessage(chat, messageId, socket.userId);
                if (!message) {
                    return;
                }

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
            on('add_reaction', async (data) => {
                const { chatId, messageId, emoji, reaction } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed || !this.isValidId(messageId)) {
                    return;
                }

                socket.to(`chat:${chatId}`).emit('message_reaction_added', {
                    chatId,
                    messageId,
                    emoji,
                    // Identity always comes from the socket, never from the payload,
                    // so a reaction cannot be attributed to someone else
                    reaction: {
                        ...(reaction && typeof reaction === 'object' ? reaction : {}),
                        emoji,
                        userId: socket.userId,
                        username: socket.user.username,
                        fullName: socket.user.fullName,
                        profileImageUrl: socket.user.profileImageUrl,
                        createdAt: reaction?.createdAt || new Date()
                    }
                });
            });

            on('remove_reaction', async (data) => {
                const { chatId, messageId, emoji } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed || !this.isValidId(messageId)) {
                    return;
                }

                socket.to(`chat:${chatId}`).emit('message_reaction_removed', {
                    chatId,
                    messageId,
                    emoji,
                    userId: socket.userId
                });
            });

            // Handle message edit events (real-time sync)
            on('edit_message', async (data) => {
                const { chatId, messageId, newContent, editedAt, originalContent } = data || {};

                if (typeof newContent !== 'string' || newContent.trim().length === 0) {
                    return;
                }

                // Same rule as the HTTP edit: only the sender may rewrite a message.
                // Relaying this unchecked let anyone rewrite any line on both screens.
                const chat = await this.loadChatForUser(chatId, socket.userId);
                if (!chat) {
                    return;
                }

                const message = await this.loadOwnMessage(chat, messageId, socket.userId, false);
                if (!message) {
                    return;
                }

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
            on('forward_message', async (data) => {
                const { targetChatIds, originalMessage, newMessages } = data || {};

                if (!Array.isArray(targetChatIds)) {
                    return;
                }

                // Emit to each target chat the sender actually belongs to
                const targets = targetChatIds.slice(0, MAX_FORWARD_TARGETS);

                for (let index = 0; index < targets.length; index++) {
                    const targetChatId = targets[index];

                    const allowed = await this.isChatParticipant(socket, targetChatId);
                    if (!allowed) {
                        continue;
                    }

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
                }
            });

            // Handle message pin events (real-time sync)
            on('pin_message', async (data) => {
                const { chatId, messageId, isPinned, pinnedMessage } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed || !this.isValidId(messageId)) {
                    return;
                }

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
            on('recording_voice', async (data) => {
                const { chatId, isRecording } = data || {};

                const allowed = await this.isChatParticipant(socket, chatId);
                if (!allowed) {
                    return;
                }

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
            on('set_online_status', (status) => {
                if (typeof status !== 'string') {
                    return;
                }

                socket.to(`user_${socket.userId}`).emit('user_status_changed', {
                    userId: socket.userId,
                    status,
                    timestamp: new Date()
                });
            });

            // 🚀 NEW: Handle request for initial unread counts (alternative to HTTP polling)
            on('request_unread_counts', async () => {
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
            on('call_accept', async (data) => {
                const { callId } = data || {};

                // The emitter must be a participant, and the recipient is taken from
                // the stored call — a client-supplied id could target any user
                const call = await this.loadCallForUser(callId, socket.userId);
                if (!call) {
                    return;
                }

                const callerId = call.initiator?.toString();
                if (!callerId || callerId === socket.userId) {
                    return;
                }

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
            on('call_decline', async (data) => {
                const { callId } = data || {};

                const call = await this.loadCallForUser(callId, socket.userId);
                if (!call) {
                    return;
                }

                const callerId = call.initiator?.toString();
                if (!callerId || callerId === socket.userId) {
                    return;
                }

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
            on('call_end', async (data) => {
                const { callId, endReason = 'normal' } = data || {};

                // The emitter must be a participant of the call, and the recipients
                // come from the stored document — the client's `participants` array
                // let any account tear down any other user's call UI
                const call = await this.loadCallForUser(callId, socket.userId);
                if (!call) {
                    return;
                }

                const reason = typeof endReason === 'string' ? endReason : 'normal';

                // Real-time notification only - HTTP endpoint handles DB update
                (call.participants || [])
                    .map(participantId => participantId?.toString())
                    .filter(participantId => participantId && participantId !== socket.userId)
                    .forEach(participantId => {
                        this.emitToUser(participantId, 'call_ended', {
                            callId,
                            endedBy: {
                                _id: socket.userId,
                                username: socket.user.username,
                                fullName: socket.user.fullName,
                                profileImageUrl: socket.user.profileImageUrl
                            },
                            endReason: reason,
                            timestamp: new Date()
                        });
                    });
            });


            // Handle disconnect
            on('disconnect', async () => {
                const userId = socket.userId;

                // Captured before the rooms are cleared so the offline notice can be
                // scoped to the people this user actually talks to
                const joinedChatRooms = socket.chatRooms ? Array.from(socket.chatRooms) : [];

                this.userSockets.delete(socket.id);

                // Clean up all chat rooms the user was in
                if (socket.chatRooms && socket.chatRooms.size > 0) {
                    socket.chatRooms.forEach(chatId => {
                        socket.leave(`chat:${chatId}`);
                    });
                    socket.chatRooms.clear();
                }

                if (!userId) {
                    console.warn('Socket disconnected without userId, skipping presence and call cleanup');
                    return;
                }

                // The same account can hold several sockets (phone + web). Only treat
                // it as gone — and only touch its calls — once the last one has left.
                const stillConnected = await this.hasOtherSockets(userId, socket.id);
                if (stillConnected) {
                    return;
                }

                // Clean up local tracking (only if this socket is the one recorded)
                if (this.connectedUsers.get(userId) === socket.id) {
                    this.connectedUsers.delete(userId);
                }

                // Update lastSeenAt in database when user goes offline
                try {
                    await User.findByIdAndUpdate(userId, {
                        lastSeenAt: new Date()
                    });
                } catch (err) {
                    console.error('Error updating lastSeenAt on disconnect:', err);
                }

                // Remove from Redis cross-process tracking
                redisClient.hdel('fn:online_users', userId)
                    .catch(err => console.error('Redis user removal error:', err));

                // Emit offline status to relevant users with lastSeenAt
                this.emitUserOffline(userId, joinedChatRooms)
                    .catch(err => console.error('Error emitting user offline:', err));

                // 🚨 End all active calls for the disconnected user, so they do not
                // hit "already in a call" later — but only after a grace period, and
                // only if they have not reconnected. Mobile sockets drop on every
                // screen lock and network handoff; ending immediately killed live calls.
                const endedByProfile = {
                    _id: userId,
                    username: socket.user?.username || 'User',
                    fullName: socket.user?.fullName || 'User',
                    profileImageUrl: socket.user?.profileImageUrl
                };

                const cleanupTimer = setTimeout(() => {
                    this.hasOtherSockets(userId, socket.id)
                        .then(reconnected => {
                            if (reconnected) {
                                return null;
                            }
                            return this.endActiveCallsForUser(userId, endedByProfile);
                        })
                        .catch(error => console.error(`❌ Error handling call cleanup on disconnect for user ${userId}:`, error));
                }, CALL_DISCONNECT_GRACE_MS);

                if (typeof cleanupTimer.unref === 'function') {
                    cleanupTimer.unref();
                }
            });
        });
    }

    /**
     * End every call the user is still listed as active in, and tell the other
     * participants. Called from the disconnect path after the reconnect grace period.
     * @param {string} userId
     * @param {Object} endedByProfile - identity snapshot for the 'call_ended' payload
     */
    async endActiveCallsForUser(userId, endedByProfile) {
        try {
            const Call = (await import('../models/call.models.js')).default;

            // Find all active calls where this user is a participant
            const activeCalls = await Call.find({
                participants: userId,
                status: { $in: ['initiated', 'ringing', 'connecting', 'active'] }
            }).select('_id participants'); // Only get IDs for efficiency

            if (activeCalls.length === 0) {
                return;
            }

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
                                endedBy: endedByProfile,
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
        } catch (error) {
            console.error(`❌ Error handling call cleanup on disconnect for user ${userId}:`, error);
            // Don't block disconnect cleanup if call ending fails
        }
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
            // ioredis v5 returns {} (not null) for missing keys
            if (!onlineUsers || Object.keys(onlineUsers).length === 0) return [];
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

    emitGlobal(event, data) {
        if (this.io) {
            this.io.emit(event, data);
        } else {
            console.warn(`Socket.IO not initialized, skipping emitGlobal for event: ${event}`);
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

    /**
     * Tell the people who care that a user went offline.
     * @param {string} userId
     * @param {string[]} chatRoomIds - chats the user was in; presence is only sent there.
     *   Broadcasting to every connected socket cost O(all sockets) per disconnect and
     *   told the whole platform when any account went offline.
     */
    async emitUserOffline(userId, chatRoomIds = []) {
        if (!this.io) {
            console.warn('Socket.IO not initialized, skipping emitUserOffline');
            return;
        }

        const rooms = Array.from(new Set(
            (Array.isArray(chatRoomIds) ? chatRoomIds : [])
                .filter(chatId => typeof chatId === 'string' && chatId.length > 0)
                .map(chatId => `chat:${chatId}`)
        ));

        // io.to([]) would broadcast to everyone — nothing to do if there is no audience
        if (rooms.length === 0) {
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
        // Emit to the user's chat rooms only — the participants who display presence
        this.io.to(rooms).emit('user_offline', {
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
