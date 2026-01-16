import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
    chatId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chat',
        required: true,
        index: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true
    },
    messageType: {
        type: String,
        enum: ['text', 'image', 'video', 'file', 'audio', 'location'],
        default: 'text'
    },
    mediaUrl: String,
    fileName: String,
    fileSize: Number,
    duration: Number, // for audio/video
    location: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    readBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedAt: Date,
    editedAt: Date,
    originalMessage: String, // Store original message for potential restoration
    reactions: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        emoji: String,
        timestamp: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Compound indexes for optimal query performance
MessageSchema.index({ chatId: 1, timestamp: -1 }); // For message fetching
MessageSchema.index({ chatId: 1, isDeleted: 1, timestamp: -1 }); // For non-deleted messages
MessageSchema.index({ chatId: 1, isDeleted: 1, readBy: 1 }); // For unread count queries
MessageSchema.index({ sender: 1, timestamp: -1 }); // For user's sent messages

// Virtual for unread status (per user)
MessageSchema.virtual('isUnread').get(function () {
    // This would be calculated per user in queries
    return false;
});

export default mongoose.model('Message', MessageSchema); 