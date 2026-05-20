import Chat from "../../models/chat.models.js";
import socketManager from "../../config/socket.js";
import notificationCache from "../../utils/notificationCache.utils.js";

export const notifyStatusChange = async (userId, status) => {
    try {
        const affectedChats = await Chat.find({
            participants: userId,
            chatType: 'direct'
        }).select('_id participants').lean();

        affectedChats.forEach(chat => {
            if (socketManager.isReady()) {
                socketManager.emitToChat(chat._id.toString(), 'participant_status_changed', {
                    userId,
                    status
                });
            }
        });

        const partnerIds = new Set();
        affectedChats.forEach(chat => {
            chat.participants.forEach(p => {
                if (p.toString() !== userId) partnerIds.add(p.toString());
            });
        });
        await Promise.all([...partnerIds].map(pid => notificationCache.invalidateAllCache(pid)));
    } catch (err) {
        console.error('notifyStatusChange error:', err);
    }
};
