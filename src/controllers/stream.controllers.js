import { ApiError } from '../utlis/ApiError.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { asyncHandler } from '../utlis/asyncHandler.js';
import streamService from '../config/stream.config.js';

/**
 * POST /api/v1/stream/token
 * Generate a Stream.io user token for video/audio calls
 *
 * Body: {
 *   userId?: string (optional - defaults to authenticated user)
 *   expirationSeconds?: number (optional - defaults to 24 hours)
 * }
 */
export const generateUserToken = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id.toString();
    const { userId, expirationSeconds = 86400 } = req.body;

    // Use authenticated user's ID if no userId provided
    const targetUserId = userId || currentUserId;

    // Security: Only allow users to generate tokens for themselves
    // unless they have admin privileges (you can add admin check here)
    if (targetUserId !== currentUserId) {
        throw new ApiError(403, 'You can only generate tokens for yourself');
    }

    console.log('🔑 Token generation request:', { userId: targetUserId, expirationSeconds });

    // Check if Stream.io is configured
    if (!streamService.isConfigured()) {
        throw new ApiError(503, 'Stream.io service is not configured. Please contact support.');
    }

    try {
        // Auto-register user in Stream.io (idempotent - safe to call multiple times)
        console.log('👤 Auto-registering user in Stream.io...');
        await streamService.upsertUsers([{
            id: currentUserId,
            name: req.user.fullName || req.user.username || 'User',
            image: req.user.profileImageUrl || undefined
        }]);

        // Generate token
        const tokenData = streamService.generateUserToken(targetUserId, expirationSeconds);

        res.status(200).json(
            new ApiResponse(200, {
                token: tokenData.token,
                userId: tokenData.userId,
                apiKey: tokenData.apiKey,
                expiresAt: tokenData.expiresAt
            }, 'Stream.io token generated successfully')
        );
    } catch (error) {
        console.error('❌ Error in generateUserToken:', error);
        throw new ApiError(500, error.message || 'Failed to generate Stream.io token');
    }
});

/**
 * POST /api/v1/stream/call/create
 * Create or get a Stream.io call with proper settings
 *
 * Body: {
 *   callId: string (required - your backend call ID)
 *   callType: 'voice' | 'video' (required)
 *   members: string[] (optional - array of user IDs to add to call)
 *   videoEnabled: boolean (optional - whether video should be enabled initially, default: false)
 * }
 */
export const createStreamCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id.toString();
    const { callId, callType, members = [], videoEnabled = false } = req.body;

    console.log('📞 Stream.io call creation request:', { callId, callType, currentUserId, members, videoEnabled });

    // Validate input
    if (!callId || !callType) {
        throw new ApiError(400, 'Call ID and call type are required');
    }

    if (!['voice', 'video'].includes(callType)) {
        throw new ApiError(400, 'Call type must be voice or video');
    }

    // Check if Stream.io is configured
    if (!streamService.isConfigured()) {
        throw new ApiError(503, 'Stream.io service is not configured. Please contact support.');
    }

    try {
        // Ensure all users are registered in Stream.io
        const allMemberIds = [currentUserId, ...members].filter((id, index, self) => self.indexOf(id) === index);

        console.log(`👥 Registering ${allMemberIds.length} users in Stream.io...`);

        // Optimize: Build users array using current user data and only fetch others if needed
        const usersToRegister = [];

        // Add current user (already available from req.user)
        usersToRegister.push({
            id: currentUserId,
            name: req.user.fullName || req.user.username || 'User',
            image: req.user.profileImageUrl || undefined
        });

        // Only fetch other members from DB if there are any
        if (members.length > 0) {
            const { User } = await import('../models/user.models.js');
            const otherUsers = await User.find({ _id: { $in: members } })
                .select('_id username fullName profileImageUrl')
                .lean(); // Use lean() for faster queries

            if (otherUsers.length !== members.length) {
                console.error('❌ Some members not found in database:', {
                    requested: members,
                    found: otherUsers.map(u => u._id.toString())
                });
                throw new ApiError(404, 'One or more members not found');
            }

            // Add other users
            otherUsers.forEach(user => {
                usersToRegister.push({
                    id: user._id.toString(),
                    name: user.fullName || user.username || 'User',
                    image: user.profileImageUrl || undefined
                });
            });
        }

        await streamService.upsertUsers(usersToRegister);
        console.log(`✅ Registered ${usersToRegister.length} users in Stream.io`);

        // Create Stream.io call with appropriate settings
        // Use 'default' type for both voice and video calls
        // The difference is in the videoEnabled setting
        const streamCallType = 'default';
        const finalVideoEnabled = callType === 'video' ? videoEnabled : false;

        console.log(`📞 Creating Stream.io call: ${streamCallType}:${callId} with videoEnabled: ${finalVideoEnabled}`);
        const callResponse = await streamService.createCall(
            streamCallType,
            callId,
            currentUserId,
            allMemberIds,
            finalVideoEnabled
        );

        res.status(200).json(
            new ApiResponse(200, {
                streamCallType,
                callId,
                callType,
                videoEnabled,
                call: callResponse
            }, 'Stream.io call created successfully')
        );
    } catch (error) {
        console.error('❌ Error in createStreamCall:', error);
        throw new ApiError(500, error.message || 'Failed to create Stream.io call');
    }
});

