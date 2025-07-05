import mongoose from 'mongoose';

const ActivityLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    action: {
        type: String,
        required: true,
        enum: ['like', 'comment', 'follow', 'unfollow', 'post', 'message', 'share', 'storyView', 'save']
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    targetType: {
        type: String,
        required: true,
        enum: ['User', 'Post', 'Comment', 'Story', 'Message', 'Notification']
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    additionalInfo: {
        type: Map,
        of: String, // Useful for storing dynamic data related to the action (e.g., comment text, post caption)
        default: {}
    }
}, { timestamps: true });

export default mongoose.model('ActivityLog', ActivityLogSchema);
