/**
 * Message Status Utility Functions
 *
 * Calculate and format message delivery and read status for chat messages.
 * Supports single tick (sent), double tick (delivered), and blue tick (seen) indicators.
 */

/**
 * Calculate the overall message status for the sender's view
 *
 * @param {Object} message - The message document
 * @param {Array} chatParticipants - Array of participant IDs in the chat
 * @returns {string} - 'sent' | 'delivered' | 'seen'
 *
 * Status Logic:
 * - 'sent': Message sent but not yet delivered to all recipients (single tick)
 * - 'delivered': Message delivered to all recipients but not read (double tick, grey)
 * - 'seen': Message read by all recipients (double tick, blue)
 */
export const calculateMessageStatus = (message, chatParticipants) => {
    // Get recipients (all participants except the sender)
    const recipients = chatParticipants.filter(
        p => p.toString() !== message.sender.toString()
    );

    // If there are no recipients (shouldn't happen in normal chats), return 'sent'
    if (recipients.length === 0) {
        return 'sent';
    }

    // Check if ALL recipients have seen the message (blue double tick)
    const allSeen = recipients.every(recipientId => {
        const recipientIdStr = recipientId.toString();
        return message.readBy?.some(r => r.toString() === recipientIdStr);
    });

    if (allSeen) {
        return 'seen';
    }

    // Check if ALL recipients have received the message (grey double tick)
    const allDelivered = recipients.every(recipientId => {
        const recipientIdStr = recipientId.toString();
        return message.deliveryStatus?.some(d => {
            const userIdStr = d.userId?.toString();
            return userIdStr === recipientIdStr && ['delivered', 'seen'].includes(d.status);
        });
    });

    if (allDelivered) {
        return 'delivered';
    }

    // Otherwise, still in 'sent' state (single tick)
    return 'sent';
};

/**
 * Get the timestamp when a specific user read the message
 *
 * @param {Object} message - The message document
 * @param {string|ObjectId} recipientId - The user ID to check
 * @returns {Date|null} - The seen timestamp, or null if not seen
 */
export const getSeenTime = (message, recipientId) => {
    const recipientIdStr = recipientId.toString();

    const deliveryInfo = message.deliveryStatus?.find(
        d => d.userId?.toString() === recipientIdStr
    );

    return deliveryInfo?.seenAt || null;
};

/**
 * Get the timestamp when a specific user received the message
 *
 * @param {Object} message - The message document
 * @param {string|ObjectId} recipientId - The user ID to check
 * @returns {Date|null} - The delivery timestamp, or null if not delivered
 */
export const getDeliveryTime = (message, recipientId) => {
    const recipientIdStr = recipientId.toString();

    const deliveryInfo = message.deliveryStatus?.find(
        d => d.userId?.toString() === recipientIdStr
    );

    return deliveryInfo?.deliveredAt || null;
};

/**
 * Get detailed delivery status for a message (useful for group chats)
 *
 * @param {Object} message - The message document
 * @param {Array} chatParticipants - Array of participant IDs in the chat
 * @returns {Object} - Detailed status breakdown
 *
 * Example return value:
 * {
 *   totalRecipients: 3,
 *   delivered: 2,
 *   seen: 1,
 *   pending: 1,
 *   overallStatus: 'delivered',
 *   recipients: [
 *     { userId: '123', status: 'seen', seenAt: Date, deliveredAt: Date },
 *     { userId: '456', status: 'delivered', deliveredAt: Date },
 *     { userId: '789', status: 'sent' }
 *   ]
 * }
 */
export const getDetailedMessageStatus = (message, chatParticipants) => {
    const recipients = chatParticipants.filter(
        p => p.toString() !== message.sender.toString()
    );

    const recipientStatuses = recipients.map(recipientId => {
        const recipientIdStr = recipientId.toString();

        // Check if seen
        const isSeen = message.readBy?.some(r => r.toString() === recipientIdStr);
        if (isSeen) {
            const seenTime = getSeenTime(message, recipientId);
            const deliveryTime = getDeliveryTime(message, recipientId);
            return {
                userId: recipientIdStr,
                status: 'seen',
                seenAt: seenTime,
                deliveredAt: deliveryTime
            };
        }

        // Check if delivered
        const deliveryInfo = message.deliveryStatus?.find(
            d => d.userId?.toString() === recipientIdStr
        );

        if (deliveryInfo && ['delivered', 'seen'].includes(deliveryInfo.status)) {
            return {
                userId: recipientIdStr,
                status: 'delivered',
                deliveredAt: deliveryInfo.deliveredAt
            };
        }

        // Otherwise, still pending/sent
        return {
            userId: recipientIdStr,
            status: 'sent'
        };
    });

    const seenCount = recipientStatuses.filter(r => r.status === 'seen').length;
    const deliveredCount = recipientStatuses.filter(r => r.status === 'delivered').length;
    const pendingCount = recipientStatuses.filter(r => r.status === 'sent').length;

    return {
        totalRecipients: recipients.length,
        delivered: deliveredCount,
        seen: seenCount,
        pending: pendingCount,
        overallStatus: calculateMessageStatus(message, chatParticipants),
        recipients: recipientStatuses
    };
};

/**
 * Check if a user has read a specific message
 *
 * @param {Object} message - The message document
 * @param {string|ObjectId} userId - The user ID to check
 * @returns {boolean} - true if the user has read the message
 */
export const hasUserReadMessage = (message, userId) => {
    const userIdStr = userId.toString();
    return message.readBy?.some(r => r.toString() === userIdStr) || false;
};

/**
 * Check if a user has received a specific message
 *
 * @param {Object} message - The message document
 * @param {string|ObjectId} userId - The user ID to check
 * @returns {boolean} - true if the user has received the message
 */
export const hasUserReceivedMessage = (message, userId) => {
    const userIdStr = userId.toString();
    return message.deliveryStatus?.some(d =>
        d.userId?.toString() === userIdStr && ['delivered', 'seen'].includes(d.status)
    ) || false;
};
