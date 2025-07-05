import mongoose from 'mongoose';

const HashtagSchema = new mongoose.Schema({
    tag: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,  // Normalize tags like #Travel and #travel
        trim: true
    },
    posts: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post'
    }],
    usageCount: {
        type: Number,
        default: 0
    },
    lastUsedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// 🔍 Index for fast hashtag search
HashtagSchema.index({ tag: 1 });

export default mongoose.model('Hashtag', HashtagSchema);
