import mongoose from 'mongoose';
import { INotification } from '../types/notification.types.js';

const NotificationSchema = new mongoose.Schema<INotification>({
    receiverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['like', 'unlike', 'comment', 'follow', 'mention', 'message', 'tag', 'storyView', 'order', 'others'],
        required: true
    },
    message: {
        type: String,
        trim: true
    },
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        default: null
    },
    commentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        default: null
    },
    isRead: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

export default mongoose.model('Notification', NotificationSchema);
