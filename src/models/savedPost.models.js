import mongoose from 'mongoose';

// Instagram-style saved posts: Always private, only visible to the user who saved them
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
