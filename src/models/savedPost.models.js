import mongoose from 'mongoose';

const SavedPostSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true
    },
    savedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// 🛡 Prevent saving the same post multiple times by same user
SavedPostSchema.index({ userId: 1, postId: 1 }, { unique: true });

export default mongoose.model('SavedPost', SavedPostSchema);
