import socketManager from '../../config/socket.js';
import Follower from '../../models/follower.models.js';

export const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for chat ${chatId}`);
    }
};

export const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for user ${userId}`);
    }
};

export const checkFollowStatus = async (followerId, userId) => {
    const followRelation = await Follower.findOne({ followerId, userId });
    return !!followRelation;
};
