import Call from '../models/call.models.js';
import Chat from '../models/chat.models.js';
import Message from '../models/message.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utlis/ApiError.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { asyncHandler } from '../utlis/asyncHandler.js';
import socketManager from '../config/socket.js';
import hmsService from '../config/hms.config.js';
import mongoose from 'mongoose';
import moment from 'moment';

// Constants for call management
const CALL_TIMEOUT_MINUTES = 2; // Calls timeout after 2 minutes if not answered
const CLEANUP_INTERVAL_MINUTES = 5; // Run cleanup every 5 minutes

// Helper function to safely emit socket events
const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for user ${userId}`);
    }
};

// Helper function to validate ObjectId
const isValidObjectId = (id) => {
    return mongoose.Types.ObjectId.isValid(id);
};

// Helper function to cleanup stale calls
const cleanupStaleCalls = async () => {
    try {
        const timeoutDate = new Date(Date.now() - (CALL_TIMEOUT_MINUTES * 60 * 1000));

        // Find calls that are stuck in initiated/ringing state beyond timeout
        const staleCalls = await Call.find({
            status: { $in: ['initiated', 'ringing'] },
            initiatedAt: { $lt: timeoutDate }
        });

        for (const call of staleCalls) {
            console.log(`🧹 Cleaning up stale call: ${call._id}`);

            // End HMS room if exists
            if (call.hmsRoom?.roomId) {
                await safeHMSOperation(async () => {
                    await hmsService.endRoom(call.hmsRoom.roomId);
                    call.hmsRoom.endedAt = new Date();
                }, `Failed to end HMS room ${call.hmsRoom.roomId} during cleanup`);
            }

            // Update call status
            call.status = 'missed';
            call.endedAt = new Date();
            call.endReason = 'timeout';
            await call.save();

            // Notify participants
            const participantIds = call.participants.map(p => p.toString());
            participantIds.forEach(participantId => {
                safeEmitToUser(participantId, 'call_timeout', {
                    callId: call._id,
                    timestamp: new Date()
                });
            });
        }

        if (staleCalls.length > 0) {
            console.log(`🧹 Cleaned up ${staleCalls.length} stale calls`);
        }
    } catch (error) {
        console.error('❌ Error during call cleanup:', error);
    }
};

// Start cleanup interval
setInterval(cleanupStaleCalls, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

// Helper function to safely execute HMS operations
const safeHMSOperation = async (operation, fallbackMessage) => {
    try {
        return await operation();
    } catch (error) {
        console.warn(`HMS operation failed: ${error.message}. ${fallbackMessage}`);
        return null;
    }
};

// Helper function to check if user has active call
const hasActiveCall = async (userId, session = null) => {
    const query = {
        participants: userId,
        status: { $in: ['initiated', 'ringing', 'connecting', 'active'] }
    };

    const baseQuery = session ?
        Call.findOne(query).session(session) :
        Call.findOne(query);

    return baseQuery.populate('participants', 'username fullName profileImageUrl')
                   .populate('initiator', 'username fullName profileImageUrl');
};

// Helper function to validate chat permissions
const validateChatPermissions = async (chatId, currentUserId, receiverId) => {
    const chat = await Chat.findById(chatId);
    if (!chat) {
        throw new ApiError(404, 'Chat not found');
    }

    const participantIds = chat.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString()) || !participantIds.includes(receiverId)) {
        throw new ApiError(403, 'You can only call users in your chats');
    }

    return chat;
};

// Initiate a call
export const initiateCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { receiverId, chatId, callType } = req.body;

    console.log('🚀 Call initiation request:', { currentUserId, receiverId, chatId, callType });

    // Validate input
    if (!receiverId || !chatId || !callType) {
        console.error('❌ Missing required fields:', { receiverId: !!receiverId, chatId: !!chatId, callType: !!callType });
        throw new ApiError(400, 'Receiver ID, chat ID, and call type are required');
    }

    if (!['voice', 'video'].includes(callType)) {
        console.error('❌ Invalid call type:', callType);
        throw new ApiError(400, 'Call type must be voice or video');
    }

    try {
        // Validate chat permissions
        console.log('🔍 Validating chat permissions...');
        await validateChatPermissions(chatId, currentUserId, receiverId);

        // Check if receiver exists and is online
        console.log('👤 Checking receiver exists...');
        const receiver = await User.findById(receiverId);
        if (!receiver) {
            console.error('❌ Receiver not found:', receiverId);
            throw new ApiError(404, 'Receiver not found');
        }

        // Check if user is trying to call themselves
        if (currentUserId.toString() === receiverId) {
            console.error('❌ User trying to call themselves');
            throw new ApiError(400, 'Cannot call yourself');
        }

        // Use transaction to prevent race conditions
        console.log('💾 Creating call record with transaction...');
        const session = await mongoose.startSession();
        let newCall;

        try {
            await session.withTransaction(async () => {
                // Check if there's already an active call for either user within transaction
                const currentUserActiveCall = await hasActiveCall(currentUserId, session);
                const receiverActiveCall = await hasActiveCall(receiverId, session);

                if (currentUserActiveCall || receiverActiveCall) {
                    const existingCall = currentUserActiveCall || receiverActiveCall;
                    const busyUser = currentUserActiveCall ? 'You are' : 'The recipient is';
                    console.warn('⚠️ User already in call:', { existingCallId: existingCall._id, busyUser });

                    // Create enhanced error with call details
                    const error = new ApiError(409, `${busyUser} already in a call`);
                    error.data = {
                        existingCallId: existingCall._id,
                        existingCall: {
                            _id: existingCall._id,
                            status: existingCall.status,
                            callType: existingCall.callType,
                            initiatedAt: existingCall.initiatedAt,
                            participants: existingCall.participants
                        }
                    };
                    throw error;
                }

                // Create new call record within transaction
                newCall = new Call({
                    participants: [currentUserId, receiverId],
                    initiator: currentUserId,
                    chatId,
                    callType,
                    status: 'initiated'
                });

                await newCall.save({ session });
                console.log('✅ Call record created successfully:', { callId: newCall._id });
            });
        } finally {
            await session.endSession();
        }

        // Create 100ms room for the call with better error handling
        console.log('🏠 Creating HMS room...');
        const hmsRoom = await safeHMSOperation(async () => {
            const room = await hmsService.createRoom(callType, newCall._id.toString(), [currentUserId, receiverId]);

            // Update call with HMS room data
            newCall.hmsRoom = {
                roomId: room.roomId,
                roomCode: room.roomCode,
                enabled: room.enabled,
                createdAt: new Date(room.createdAt)
            };

            // Generate auth tokens for both participants
            const initiatorTokenResponse = await hmsService.generateAuthToken(room.roomId, req.user, 'host');
            const receiverUser = await User.findById(receiverId);
            const receiverTokenResponse = await hmsService.generateAuthToken(room.roomId, receiverUser, 'guest');

            // Extract token strings from response
            const initiatorToken = typeof initiatorTokenResponse === 'string' ? initiatorTokenResponse : initiatorTokenResponse.token;
            const receiverToken = typeof receiverTokenResponse === 'string' ? receiverTokenResponse : receiverTokenResponse.token;

            // Store tokens in the call
            await newCall.addHMSToken(currentUserId, initiatorToken, 'host');
            await newCall.addHMSToken(receiverId, receiverToken, 'guest');

            console.log(`🎉 Created 100ms room ${room.roomId} for call ${newCall._id}`);
            return room;
        }, 'Continuing with WebRTC fallback');

        // Populate the call with user details
        console.log('📋 Populating call details...');
        const populatedCall = await Call.findById(newCall._id)
            .populate('participants', 'username fullName profileImageUrl')
            .populate('initiator', 'username fullName profileImageUrl');

        // Emit call initiation via socket
        console.log('📡 Emitting socket events...');
        if (socketManager.isReady()) {
            const callData = {
                // always send backend-authoritative ID as a string
                callId: newCall._id ? newCall._id.toString() : null,
                chatId,
                callType,
                caller: {
                    _id: currentUserId,
                    username: req.user.username,
                    fullName: req.user.fullName,
                    profileImageUrl: req.user.profileImageUrl
                },
                timestamp: new Date()
            };

            // Include HMS room data if available
            if (newCall.hmsRoom && newCall.hmsRoom.roomId) {
                const receiverToken = newCall.getHMSTokenForUser(receiverId);
                callData.hmsRoom = {
                    roomId: newCall.hmsRoom.roomId,
                    roomCode: newCall.hmsRoom.roomCode,
                    authToken: receiverToken ? receiverToken.token : null
                };
            }

            socketManager.emitToUser(receiverId, 'incoming_call', callData);
        }

        // Create a call message in the chat (non-critical, don't let this fail the call)
        try {
            console.log('💬 Creating call message...');
            const callMessage = new Message({
                chatId,
                sender: currentUserId,
                message: `${callType} call ${callType === 'voice' ? '📞' : '📹'}`,
                messageType: 'text'
            });
            await callMessage.save();
        } catch (messageError) {
            console.warn('⚠️ Failed to create call message (non-critical):', messageError.message);
        }

        console.log('🎉 Call initiated successfully:', { callId: newCall._id });
        // Explicitly include _id to avoid it being removed by toJSON/toObject transforms
        res.status(201).json(
            new ApiResponse(201, {
                _id: populatedCall && populatedCall._id ? populatedCall._id.toString() : null,
                ...populatedCall.toObject()
            }, 'Call initiated successfully')
        );

    } catch (error) {
        console.error('❌ Error in initiateCall:', {
            message: error.message,
            stack: error.stack,
            data: error.data
        });

        // Re-throw the error to be handled by asyncHandler
        throw error;
    }
});

// Accept a call
export const acceptCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');

    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p._id.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Check if call is in the right status
    if (!['initiated', 'ringing'].includes(call.status)) {
        throw new ApiError(400, 'Call cannot be accepted in current status');
    }

    // Update call status with transaction
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // Double-check call is still in valid state
            const freshCall = await Call.findById(callId).session(session);
            if (!['initiated', 'ringing'].includes(freshCall.status)) {
                throw new ApiError(400, 'Call cannot be accepted in current status');
            }

            call.status = 'connecting';
            call.startedAt = new Date();
            await call.save({ session });
        });
    } finally {
        await session.endSession();
    }

    // Emit call acceptance to all participants
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());
    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_accepted', {
            callId,
            acceptedBy: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            timestamp: new Date()
        });
    });

    // Prepare response data with roomID
    const responseData = {
        ...call.toObject(),
        roomID: call.hmsRoom?.roomId || null, // Include roomID from HMS room
        hmsRoom: call.hmsRoom ? {
            roomId: call.hmsRoom.roomId,
            roomCode: call.hmsRoom.roomCode,
            enabled: call.hmsRoom.enabled,
            createdAt: call.hmsRoom.createdAt
        } : null
    };

    // Include user's auth token if available
    if (call.hmsRoom?.roomId) {
        const userToken = call.getHMSTokenForUser(currentUserId);
        if (userToken) {
            responseData.authToken = userToken.token;
            responseData.userRole = userToken.role;
        }
    }

    res.status(200).json(
        new ApiResponse(200, responseData, 'Call accepted successfully')
    );
});

// Decline a call
export const declineCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId);
    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Check if call can be declined
    if (!['initiated', 'ringing'].includes(call.status)) {
        throw new ApiError(400, 'Call cannot be declined in current status');
    }

    // Update call status with transaction
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            call.status = 'declined';
            call.endedAt = new Date();
            call.endReason = 'declined';
            await call.save({ session });
        });
    } finally {
        await session.endSession();
    }

    // Emit call decline to other participants
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());
    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_declined', {
            callId,
            declinedBy: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            timestamp: new Date()
        });
    });

    res.status(200).json(
        new ApiResponse(200, call, 'Call declined successfully')
    );
});

// End a call
export const endCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { endReason = 'normal' } = req.body;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId);
    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Check if call can be ended
    if (call.status === 'ended') {
        throw new ApiError(400, 'Call has already ended');
    }

    // Update call status with transaction
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            call.status = 'ended';
            call.endedAt = new Date();
            call.endReason = endReason;
            await call.save({ session });
        });
    } finally {
        await session.endSession();
    }

    // End 100ms room if it exists (outside transaction for safety)
    if (call.hmsRoom && call.hmsRoom.roomId) {
        await safeHMSOperation(async () => {
            await hmsService.endRoom(call.hmsRoom.roomId);
            call.hmsRoom.endedAt = new Date();
            await call.save();
            console.log(`🏠 Ended 100ms room ${call.hmsRoom.roomId} for call ${call._id}`);
        }, 'HMS room cleanup failed but call ended successfully');
    }

    // Emit call end to other participants
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());
    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_ended', {
            callId,
            endedBy: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            endReason,
            timestamp: new Date()
        });
    });

    res.status(200).json(
        new ApiResponse(200, call, 'Call ended successfully')
    );
});

// Update call status (for WebRTC connection states)
export const updateCallStatus = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { status, metadata } = req.body;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId);
    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Validate status
    const validStatuses = ['connecting', 'active', 'ended', 'failed'];
    if (!validStatuses.includes(status)) {
        throw new ApiError(400, 'Invalid call status');
    }

    // Update call
    call.status = status;
    if (metadata) {
        call.metadata = { ...call.metadata, ...metadata };
    }

    // Set startedAt when call becomes active
    if (status === 'active' && !call.startedAt) {
        call.startedAt = new Date();
    }

    // Set endedAt when call ends
    if (status === 'ended' && !call.endedAt) {
        call.endedAt = new Date();
    }

    await call.save();

    // Emit status update to other participants
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());
    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_status_update', {
            callId,
            status,
            metadata,
            updatedBy: currentUserId,
            timestamp: new Date()
        });
    });

    res.status(200).json(
        new ApiResponse(200, call, 'Call status updated successfully')
    );
});

// Get call history for user
export const getCallHistory = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { page = 1, limit = 20 } = req.query;

    const calls = await Call.getCallHistory(currentUserId, parseInt(limit), parseInt(page));

    // Calculate pagination info
    const totalCalls = await Call.countDocuments({
        participants: currentUserId,
        status: { $in: ['ended', 'declined', 'missed'] }
    });

    const pagination = {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCalls / parseInt(limit)),
        totalCalls,
        hasNextPage: parseInt(page) < Math.ceil(totalCalls / parseInt(limit)),
        hasPrevPage: parseInt(page) > 1
    };

    res.status(200).json(
        new ApiResponse(200, { calls, pagination }, 'Call history fetched successfully')
    );
});

// Get active call for user
export const getActiveCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;

    const activeCall = await Call.getActiveCall(currentUserId);

    res.status(200).json(
        new ApiResponse(200, activeCall, 'Active call fetched successfully')
    );
});

// Get call statistics
export const getCallStats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { days = 30 } = req.query;

    const stats = await Call.getCallStats(currentUserId, parseInt(days));

    res.status(200).json(
        new ApiResponse(200, stats[0] || {}, 'Call statistics fetched successfully')
    );
});

// Store WebRTC session data (for debugging/analytics)
export const storeSessionData = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { sessionData } = req.body;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId);
    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Update session data
    if (!call.sessionData) {
        call.sessionData = {};
    }

    if (sessionData.offer) call.sessionData.offer = sessionData.offer;
    if (sessionData.answer) call.sessionData.answer = sessionData.answer;
    if (sessionData.iceCandidates) {
        if (!call.sessionData.iceCandidates) call.sessionData.iceCandidates = [];
        call.sessionData.iceCandidates.push(...sessionData.iceCandidates);
    }

    await call.save();

    res.status(200).json(
        new ApiResponse(200, null, 'Session data stored successfully')
    );
});

// Generate or refresh 100ms auth token for a call participant
export const getHMSAuthToken = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { role = 'guest' } = req.body;

    console.log('🔑 HMS token request:', { callId, currentUserId, role });

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        console.error('❌ Invalid call ID format:', { callId, isValid: false });
        throw new ApiError(400, `Invalid call ID format: ${callId}. Must be a valid 24-character MongoDB ObjectId.`);
    }

    // Find the call
    console.log('🔍 Looking for call:', callId);
    const call = await Call.findById(callId);
    if (!call) {
        console.error('❌ Call not found:', callId);
        throw new ApiError(404, 'Call not found');
    }

    console.log('✅ Call found:', { callId: call._id, status: call.status, hmsRoom: !!call.hmsRoom });

    // Check if user is a participant
    const participantIds = call.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        console.error('❌ User not a participant:', { currentUserId, participants: participantIds });
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Check if call has HMS room
    if (!call.hmsRoom || !call.hmsRoom.roomId) {
        console.error('❌ Call does not have HMS room configured:', { hmsRoom: call.hmsRoom });
        throw new ApiError(400, 'Call does not have 100ms room configured');
    }

    // Check if call is still active
    if (!['initiated', 'ringing', 'connecting', 'active'].includes(call.status)) {
        console.error('❌ Call is not active:', { status: call.status });
        throw new ApiError(400, 'Call is not active');
    }

    try {
        // Generate new auth token
        console.log('🔑 Generating HMS auth token...');
        const tokenResponse = await hmsService.generateAuthToken(call.hmsRoom.roomId, req.user, role);

        // Extract token string from response (HMS SDK returns { token: "jwt_string" })
        const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse.token;

        // Store/update token in call
        await call.addHMSToken(currentUserId, token, role);

        console.log('✅ HMS token generated successfully');
        res.status(200).json({
            success: true,
            data: {
                token: token,
                room_id: call.hmsRoom.roomId
            }
        });
    } catch (error) {
        console.error('❌ Error generating HMS token:', {
            message: error.message,
            stack: error.stack,
            callId,
            roomId: call.hmsRoom?.roomId
        });
        throw new ApiError(500, 'Failed to generate HMS auth token');
    }
});

// Get 100ms room details for a call
export const getHMSRoomDetails = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;

    // Validate call ID format
    if (!isValidObjectId(callId)) {
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Find the call
    const call = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl');

    if (!call) {
        throw new ApiError(404, 'Call not found');
    }

    // Check if user is a participant
    const participantIds = call.participants.map(p => p._id.toString());
    if (!participantIds.includes(currentUserId.toString())) {
        throw new ApiError(403, 'You are not a participant in this call');
    }

    // Check if call has HMS room
    if (!call.hmsRoom || !call.hmsRoom.roomId) {
        throw new ApiError(400, 'Call does not have 100ms room configured');
    }

    try {
        // Get room details from 100ms
        const roomDetails = await hmsService.getRoomDetails(call.hmsRoom.roomId);

        // Get active sessions
        const activeSessions = await hmsService.getActiveSessions(call.hmsRoom.roomId);

        // Get user's token
        const userToken = call.getHMSTokenForUser(currentUserId);

        res.status(200).json(
            new ApiResponse(200, {
                call: {
                    id: call._id,
                    status: call.status,
                    callType: call.callType,
                    participants: call.participants
                },
                hmsRoom: {
                    ...roomDetails,
                    activeSessions: activeSessions.length,
                    authToken: userToken ? userToken.token : null,
                    userRole: userToken ? userToken.role : null
                }
            }, 'HMS room details fetched successfully')
        );
    } catch (error) {
        console.error('❌ Error fetching HMS room details:', error);
        throw new ApiError(500, 'Failed to fetch HMS room details');
    }
});

// Handle 100ms webhook events
export const handleHMSWebhook = asyncHandler(async (req, res) => {
    const { type, data } = req.body;

    console.log(`📡 Received HMS webhook: ${type}`, data);

    try {
        switch (type) {
            case 'session.started':
                await handleSessionStarted(data);
                break;
            case 'session.ended':
                await handleSessionEnded(data);
                break;
            case 'peer.joined':
                await handlePeerJoined(data);
                break;
            case 'peer.left':
                await handlePeerLeft(data);
                break;
            case 'recording.success':
                await handleRecordingSuccess(data);
                break;
            default:
                console.log(`⚠️ Unhandled webhook type: ${type}`);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Error handling HMS webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Webhook event handlers
const handleSessionStarted = async (data) => {
    const { room_id, session_id } = data;

    const call = await Call.getCallByRoomId(room_id);
    if (call && call.status === 'connecting') {
        call.status = 'active';
        call.startedAt = new Date();
        await call.save();

        // Notify participants via socket
        call.participants.forEach(participant => {
            safeEmitToUser(participant._id.toString(), 'call_session_started', {
                callId: call._id,
                sessionId: session_id,
                timestamp: new Date()
            });
        });
    }
};

const handleSessionEnded = async (data) => {
    const { room_id, session_id } = data;

    const call = await Call.getCallByRoomId(room_id);
    if (call && call.status === 'active') {
        call.status = 'ended';
        call.endedAt = new Date();
        call.endReason = 'normal';
        await call.save();

        // Notify participants via socket
        call.participants.forEach(participant => {
            safeEmitToUser(participant._id.toString(), 'call_session_ended', {
                callId: call._id,
                sessionId: session_id,
                timestamp: new Date()
            });
        });
    }
};

const handlePeerJoined = async (data) => {
    const { room_id, peer_id, user_id } = data;

    const call = await Call.getCallByRoomId(room_id);
    if (call) {
        // Notify other participants
        const otherParticipants = call.participants.filter(p =>
            p._id.toString() !== user_id
        );

        otherParticipants.forEach(participant => {
            safeEmitToUser(participant._id.toString(), 'peer_joined_call', {
                callId: call._id,
                peerId: peer_id,
                userId: user_id,
                timestamp: new Date()
            });
        });
    }
};

const handlePeerLeft = async (data) => {
    const { room_id, peer_id, user_id } = data;

    const call = await Call.getCallByRoomId(room_id);
    if (call) {
        // Notify other participants
        const otherParticipants = call.participants.filter(p =>
            p._id.toString() !== user_id
        );

        otherParticipants.forEach(participant => {
            safeEmitToUser(participant._id.toString(), 'peer_left_call', {
                callId: call._id,
                peerId: peer_id,
                userId: user_id,
                timestamp: new Date()
            });
        });
    }
};

const handleRecordingSuccess = async (data) => {
    const { room_id, recording_url } = data;

    const call = await Call.getCallByRoomId(room_id);
    if (call) {
        // Store recording URL in call metadata
        call.metadata = {
            ...call.metadata,
            recordingUrl: recording_url
        };
        await call.save();

        console.log(`📹 Recording saved for call ${call._id}: ${recording_url}`);
    }
};

// Get usage analytics for the latest Session in a Room
export const getSessionAnalyticsByRoom = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { roomId } = req.query;

    if (!roomId) {
        throw new ApiError(400, 'Room ID is required');
    }

    try {
        // Get the call associated with this room
        const call = await Call.getCallByRoomId(roomId);
        if (!call) {
            throw new ApiError(404, 'Call not found for this room');
        }

        // Check if user is a participant
        const participantIds = call.participants.map(p => p.toString());
        if (!participantIds.includes(currentUserId.toString())) {
            throw new ApiError(403, 'You are not authorized to view analytics for this call');
        }

        // Get session data from 100ms API
        const sessionListData = await hmsService.getSessionsByRoom(roomId);

        if (!sessionListData || !sessionListData.data || sessionListData.data.length === 0) {
            return res.status(404).json(
                new ApiResponse(404, null, "No session found for this room")
            );
        }

        const sessionData = sessionListData.data[0]; // Get latest session
        console.log('📊 Processing session data:', sessionData);

        // Calculate individual participants' duration
        const peers = Object.values(sessionData.peers || {});
        const detailsByUser = peers.reduce((acc, peer) => {
            const joinedAt = moment(peer.joined_at);
            const leftAt = moment(peer.left_at || sessionData.updated_at);
            const duration = moment.duration(leftAt.diff(joinedAt)).asMinutes();
            const roundedDuration = Math.round(duration * 100) / 100;

            const userId = peer.user_id;
            if (!acc[userId]) {
                acc[userId] = {
                    name: peer.name,
                    user_id: userId,
                    duration: 0
                };
            }
            acc[userId].duration += roundedDuration;
            return acc;
        }, {});

        const userDurationList = Object.values(detailsByUser);
        console.log('👥 User durations:', userDurationList);

        // Calculate aggregated participants' duration
        const totalPeerDuration = userDurationList
            .reduce((total, user) => total + user.duration, 0)
            .toFixed(2);
        console.log(`⏱️ Total duration for all peers: ${totalPeerDuration} minutes`);

        // Calculate total session duration
        const sessionStartTime = moment(sessionData.created_at);
        const sessionEndTime = moment(sessionData.updated_at);
        const sessionDuration = moment.duration(sessionEndTime.diff(sessionStartTime))
            .asMinutes()
            .toFixed(2);
        console.log(`📅 Session duration: ${sessionDuration} minutes`);

        // Include call metadata
        const analytics = {
            user_duration_list: userDurationList,
            session_duration: sessionDuration,
            total_peer_duration: totalPeerDuration,
            call_metadata: {
                call_id: call._id,
                call_type: call.callType,
                status: call.status,
                initiated_at: call.initiatedAt,
                started_at: call.startedAt,
                ended_at: call.endedAt,
                duration_seconds: call.duration,
                formatted_duration: call.formattedDuration,
                participants_count: call.participants.length
            },
            session_metadata: {
                session_id: sessionData.id,
                room_id: roomId,
                peers_count: peers.length,
                session_created_at: sessionData.created_at,
                session_updated_at: sessionData.updated_at
            }
        };

        res.status(200).json(
            new ApiResponse(200, analytics, 'Session analytics retrieved successfully')
        );

    } catch (error) {
        console.error('❌ Error fetching session analytics:', error);

        // If 100ms API fails, return basic analytics from our database
        if (error.message?.includes('100ms') || error.response?.status >= 400) {
            const call = await Call.getCallByRoomId(roomId)
                .populate('participants', 'username fullName profileImageUrl');

            if (call) {
                const fallbackAnalytics = {
                    user_duration_list: call.participants.map(participant => ({
                        name: participant.fullName,
                        user_id: participant._id.toString(),
                        duration: call.duration ? (call.duration / 60).toFixed(2) : 0 // Convert seconds to minutes
                    })),
                    session_duration: call.duration ? (call.duration / 60).toFixed(2) : 0,
                    total_peer_duration: call.duration && call.participants.length ?
                        ((call.duration * call.participants.length) / 60).toFixed(2) : 0,
                    call_metadata: {
                        call_id: call._id,
                        call_type: call.callType,
                        status: call.status,
                        initiated_at: call.initiatedAt,
                        started_at: call.startedAt,
                        ended_at: call.endedAt,
                        duration_seconds: call.duration,
                        formatted_duration: call.formattedDuration,
                        participants_count: call.participants.length
                    },
                    note: 'Analytics generated from local database due to 100ms API unavailability'
                };

                return res.status(200).json(
                    new ApiResponse(200, fallbackAnalytics, 'Fallback session analytics retrieved from database')
                );
            }
        }

        throw new ApiError(500, 'Failed to fetch session analytics');
    }
});

// Create a new room following 100ms guide pattern
export const createRoom = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { name, description, template_id, region, callType } = req.body;

    try {
        // Determine template ID based on callType if not provided
        let finalTemplateId = template_id;
        if (!finalTemplateId && callType) {
            finalTemplateId = callType === 'video' ?
                process.env.HMS_VIDEO_TEMPLATE_ID :
                process.env.HMS_VOICE_TEMPLATE_ID;
        }

        const payload = {
            name: name || `room-${Date.now()}`,
            description: description || `Room created by ${req.user.username}`,
            template_id: finalTemplateId,
            region: region || 'in' // Default to India region
        };

        // Use the new APIService for room creation
        const roomData = await hmsService.createRoomDirect(payload);

        // Log room creation for analytics
        console.log(`🏠 Room created: ${roomData.id} by user: ${req.user.username}`);

        // Return room data in the format expected by clients
        const responseData = {
            id: roomData.id,
            name: roomData.name,
            description: roomData.description,
            room_code: roomData.room_code,
            enabled: roomData.enabled,
            template_id: roomData.template_id,
            region: roomData.region,
            created_at: roomData.created_at,
            created_by: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName
            }
        };

        res.status(201).json(
            new ApiResponse(201, responseData, 'Room created successfully')
        );

    } catch (error) {
        console.error('❌ Error creating room:', error);
        throw new ApiError(500, `Unable to create room: ${error.message}`);
    }
});

// Generate auth token for a client to join a room (following 100ms guide)
export const generateAuthToken = asyncHandler(async (req, res) => {
    const { room_id, user_id, role } = req.body;

    // Validate required fields
    if (!room_id || !user_id) {
        throw new ApiError(400, 'room_id and user_id are required');
    }

    // Validate role
    const validRoles = ['participant', 'guest', 'host', 'moderator'];
    const finalRole = role && validRoles.includes(role) ? role : 'participant';

    try {
        // Use the enhanced TokenService to generate auth token
        const token = hmsService.tokenService.getAuthToken({
            room_id,
            user_id,
            role: finalRole
        });

        // Log token generation for security audit
        console.log(`🔑 Auth token generated for user ${user_id} in room ${room_id} with role ${finalRole}`);

        res.status(200).json(
            new ApiResponse(200, {
                token,
                room_id,
                user_id,
                role: finalRole,
                expires_in: '1h', // Auth tokens expire in 1 hour
                success: true
            }, 'Auth token generated successfully')
        );

    } catch (error) {
        console.error('❌ Error generating auth token:', error);
        throw new ApiError(500, `Failed to generate auth token: ${error.message}`);
    }
});