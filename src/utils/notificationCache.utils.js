import { redisClient } from '../config/redis.config.js';
import Notification from '../models/notification.models.js';
import Message from '../models/message.models.js';
import Chat from '../models/chat.models.js';
import Block from '../models/block.models.js';

class NotificationCacheManager {
    constructor() {
        this.CACHE_TTL = 300; // 5 minutes cache
        this.UNREAD_NOTIFICATIONS_KEY = 'unread_notifications:';
        this.UNREAD_MESSAGES_KEY = 'unread_messages:';
        this.USER_CHATS_KEY = 'user_chats:';
    }

    /**
     * Get cache key for unread notifications
     */
    getNotificationCacheKey(userId) {
        return `${this.UNREAD_NOTIFICATIONS_KEY}${userId}`;
    }

    /**
     * Get cache key for unread messages
     */
    getMessageCacheKey(userId) {
        return `${this.UNREAD_MESSAGES_KEY}${userId}`;
    }

    /**
     * Get cache key for user chats
     */
    getChatsCacheKey(userId) {
        return `${this.USER_CHATS_KEY}${userId}`;
    }

    /**
     * Get cached unread notifications count
     */
    async getCachedNotificationCount(userId) {
        try {
            const cached = await redisClient.get(this.getNotificationCacheKey(userId));
            return cached ? parseInt(cached) : null;
        } catch (error) {
            console.error('Error getting cached notification count:', error);
            return null;
        }
    }

    /**
     * Cache unread notifications count
     */
    async setCachedNotificationCount(userId, count) {
        try {
            await redisClient.setex(this.getNotificationCacheKey(userId), this.CACHE_TTL, count);
        } catch (error) {
            console.error('Error caching notification count:', error);
        }
    }

    /**
     * Get cached unread messages count
     */
    async getCachedMessageCount(userId) {
        try {
            const cached = await redisClient.get(this.getMessageCacheKey(userId));
            return cached ? parseInt(cached) : null;
        } catch (error) {
            console.error('Error getting cached message count:', error);
            return null;
        }
    }

    /**
     * Cache unread messages count
     */
    async setCachedMessageCount(userId, count) {
        try {
            await redisClient.setex(this.getMessageCacheKey(userId), this.CACHE_TTL, count);
        } catch (error) {
            console.error('Error caching message count:', error);
        }
    }

    /**
     * Get cached user chats
     */
    async getCachedUserChats(userId) {
        try {
            const cached = await redisClient.get(this.getChatsCacheKey(userId));
            return cached ? JSON.parse(cached) : null;
        } catch (error) {
            console.error('Error getting cached user chats:', error);
            return null;
        }
    }

    /**
     * Cache user chats
     */
    async setCachedUserChats(userId, chatIds) {
        try {
            await redisClient.setex(
                this.getChatsCacheKey(userId), 
                this.CACHE_TTL * 2, // Cache chats longer as they change less frequently
                JSON.stringify(chatIds)
            );
        } catch (error) {
            console.error('Error caching user chats:', error);
        }
    }

    /**
     * Get unread counts with caching
     */
    async getUnreadCounts(userId) {
        try {
            // Try to get from cache first
            const [cachedNotifications, cachedMessages] = await Promise.all([
                this.getCachedNotificationCount(userId),
                this.getCachedMessageCount(userId)
            ]);

            if (cachedNotifications !== null && cachedMessages !== null) {
                return {
                    unreadNotifications: cachedNotifications,
                    unreadMessages: cachedMessages,
                    fromCache: true
                };
            }

            // If not in cache, calculate from database
            const counts = await this.calculateUnreadCounts(userId);
            
            // Cache the results
            await Promise.all([
                this.setCachedNotificationCount(userId, counts.unreadNotifications),
                this.setCachedMessageCount(userId, counts.unreadMessages)
            ]);

            return {
                ...counts,
                fromCache: false
            };
        } catch (error) {
            console.error('Error getting unread counts:', error);
            throw error;
        }
    }

    /**
     * Calculate unread counts from database
     * ✅ OPTIMIZED: Uses Redis cache for blocked users instead of duplicate DB queries
     */
    async calculateUnreadCounts(userId) {
        try {
            // Get blocked users from cache (reuse the same cache used by blocking middleware)
            const blockedCacheKey = `blocked:${userId}`;
            let blockedUsers = [];

            try {
                const cachedBlocked = await redisClient.get(blockedCacheKey);
                if (cachedBlocked) {
                    blockedUsers = JSON.parse(cachedBlocked);
                } else {
                    // Cache miss - query database and cache
                    const blockedByMe = await Block.find({ blockerId: userId }).select('blockedId').lean();
                    const blockedByOthers = await Block.find({ blockedId: userId }).select('blockerId').lean();
                    blockedUsers = [
                        ...blockedByMe.map(block => block.blockedId.toString()),
                        ...blockedByOthers.map(block => block.blockerId.toString())
                    ];
                    // Cache for 5 minutes (same TTL as blocking middleware)
                    await redisClient.setex(blockedCacheKey, 300, JSON.stringify(blockedUsers));
                }
            } catch (cacheError) {
                console.error('Error accessing blocked users cache:', cacheError);
                // Fallback to direct DB query if cache fails
                const blockedByMe = await Block.find({ blockerId: userId }).select('blockedId').lean();
                const blockedByOthers = await Block.find({ blockedId: userId }).select('blockerId').lean();
                blockedUsers = [
                    ...blockedByMe.map(block => block.blockedId.toString()),
                    ...blockedByOthers.map(block => block.blockerId.toString())
                ];
            }

            // Get unread notifications count (excluding blocked users)
            const notificationQuery = {
                receiverId: userId,
                isRead: false
            };
            if (blockedUsers.length > 0) {
                notificationQuery.senderId = { $nin: blockedUsers };
            }
            const unreadNotificationsCount = await Notification.countDocuments(notificationQuery);

            // Get user's chats (try cache first)
            let chatIds = await this.getCachedUserChats(userId);

            if (!chatIds) {
                const userChats = await Chat.find({
                    participants: userId,
                    status: 'active'
                }).select('_id');

                chatIds = userChats.map(chat => chat._id);
                await this.setCachedUserChats(userId, chatIds);
            }

            // Get unread messages count (excluding blocked users)
            const messageQuery = {
                chatId: { $in: chatIds },
                sender: { $ne: userId },
                readBy: { $ne: userId },
                isDeleted: false
            };
            if (blockedUsers.length > 0) {
                messageQuery.sender = { $nin: [...blockedUsers, userId] };
            }
            const unreadMessagesCount = await Message.countDocuments(messageQuery);

            return {
                unreadNotifications: unreadNotificationsCount,
                unreadMessages: unreadMessagesCount
            };
        } catch (error) {
            console.error('Error calculating unread counts:', error);
            throw error;
        }
    }

    /**
     * Invalidate cache when notification is created/read
     */
    async invalidateNotificationCache(userId) {
        try {
            await redisClient.del(this.getNotificationCacheKey(userId));
            
            // Emit real-time update via Socket.IO to user room across all processes
            if (global.io) {
                const freshCounts = await this.getUnreadCounts(userId);
                global.io.to(`user_${userId}`).emit('unread_counts_updated', {
                    unreadNotifications: freshCounts.unreadNotifications,
                    unreadMessages: freshCounts.unreadMessages,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Error invalidating notification cache:', error);
        }
    }

    /**
     * Invalidate cache when message is sent/read
     */
    async invalidateMessageCache(userId) {
        try {
            await redisClient.del(this.getMessageCacheKey(userId));
            
            // Emit real-time update via Socket.IO to user room across all processes
            if (global.io) {
                const freshCounts = await this.getUnreadCounts(userId);
                global.io.to(`user_${userId}`).emit('unread_counts_updated', {
                    unreadNotifications: freshCounts.unreadNotifications,
                    unreadMessages: freshCounts.unreadMessages,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Error invalidating message cache:', error);
        }
    }

    /**
     * Invalidate all cache for a user
     */
    async invalidateAllCache(userId) {
        try {
            await Promise.all([
                redisClient.del(this.getNotificationCacheKey(userId)),
                redisClient.del(this.getMessageCacheKey(userId)),
                redisClient.del(this.getChatsCacheKey(userId))
            ]);
        } catch (error) {
            console.error('Error invalidating all cache:', error);
        }
    }

    /**
     * Invalidate cache for multiple users (e.g., when message is sent to chat)
     */
    async invalidateMultipleUsersCache(userIds, type = 'message') {
        try {
            const promises = userIds.map(userId => {
                if (type === 'notification') {
                    return this.invalidateNotificationCache(userId);
                } else {
                    return this.invalidateMessageCache(userId);
                }
            });
            
            await Promise.all(promises);
        } catch (error) {
            console.error('Error invalidating multiple users cache:', error);
        }
    }
}

export default new NotificationCacheManager();