import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const debugUserChats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;

    const allChats = await Chat.find({}).lean();

    const userChats = allChats.filter(chat =>
        chat.participants.some(p => p.toString() === currentUserId.toString())
    );

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
            invalidDirectChatsCount: invalidDirectChats.length,
            duplicateDirectChatsCount: duplicateDirectChats.length,
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

export const cleanupProblematicChats = asyncHandler(async (req, res) => {
    const { action = 'analyze' } = req.body;

    const invalidDirectChats = await Chat.find({
        chatType: 'direct',
        $expr: { $gt: [{ $size: '$participants' }, 2] }
    });

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
            for (const chat of invalidDirectChats) {
                await Chat.findByIdAndUpdate(chat._id, {
                    chatType: 'group',
                    groupName: `Group Chat ${chat.participants.length} members`
                });
                results.invalidChatsConverted++;
            }

            for (const group of duplicateChatGroups) {
                const sortedGroup = group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                const chatToKeep = sortedGroup[0];
                const chatsToRemove = sortedGroup.slice(1);

                for (const chatToRemove of chatsToRemove) {
                    await Message.updateMany(
                        { chatId: chatToRemove._id },
                        { chatId: chatToKeep._id }
                    );
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
