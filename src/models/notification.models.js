import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema({
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
        enum: ['like', 'comment', 'follow', 'mention', 'message', 'tag', 'storyView', 'others'],
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
    isRead: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

export default mongoose.model('Notification', NotificationSchema);
