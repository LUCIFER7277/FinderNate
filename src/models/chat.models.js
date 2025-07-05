import mongoose from 'mongoose';

const ChatSchema = new mongoose.Schema({
    // 👥 Users involved in the chat (1-on-1 or group)
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],

    // 💬 Message array
    messages: [{
        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        message: {
            type: String,
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now
        },
        readBy: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }]
    }],

    // 🕒 Last updated time for sorting recent chats
    lastMessageAt: {
        type: Date,
        default: Date.now
    }

}, { timestamps: true });

// 📛 Optional unique index to prevent duplicate chats (for 1-on-1)
ChatSchema.index({ participants: 1 });

export default mongoose.model('Chat', ChatSchema);
