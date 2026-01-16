import express from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { upload } from '../middlewares/multerConfig.js';
import { chatRateLimit } from '../middlewares/rateLimiter.middleware.js';
import {
    createChat,
    getUserChats,
    getChatMessages,
    addMessage,
    markMessagesRead,
    markChatAsRead,
    deleteMessage,
    restoreMessage,
    startTyping,
    stopTyping,
    getOnlineStatus,
    searchMessages,
    acceptChatRequest,
    declineChatRequest
} from '../controllers/chat.controllers.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Apply rate limiting to all chat routes
router.use(chatRateLimit);

// Create a new chat (1-on-1 or group)
router.post('/', createChat);

// Get all chats for a user
router.get('/', getUserChats);

// Chat request management
router.patch('/:chatId/accept', acceptChatRequest);
router.patch('/:chatId/decline', declineChatRequest);

// Get messages for a chat
router.get('/:chatId/messages', getChatMessages);

// Add a message to a chat (with optional file upload)
router.post('/:chatId/messages', upload.single('mediaFile'), addMessage);

// Alternative route for JSON messages (without file upload)
router.post('/:chatId/messages/text', addMessage);

// Mark messages as read
router.patch('/:chatId/read', markMessagesRead);

// Mark all messages in a chat as read
router.patch('/:chatId/read-all', markChatAsRead);

// Delete a message
router.delete('/:chatId/messages/:messageId', deleteMessage);

// Restore a deleted message
router.patch('/:chatId/messages/:messageId/restore', restoreMessage);

// Typing indicators
router.post('/:chatId/typing/start', startTyping);
router.post('/:chatId/typing/stop', stopTyping);

// Online status
router.get('/users/online-status', getOnlineStatus);

// Search messages in a chat
router.get('/:chatId/search', searchMessages);

export default router; 