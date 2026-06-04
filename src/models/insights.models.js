import mongoose from 'mongoose';

const InsightSchema = new mongoose.Schema({
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        unique: true,
        index: true
    },
    views: {
        type: Number,
        default: 0
    },
    likes: {
        type: Number,
        default: 0
    },
    shares: {
        type: Number,
        default: 0
    },
    comments: {
        type: Number,
        default: 0
    },
    saves: {
        type: Number,
        default: 0
    },
    reach: {
        type: Number,
        default: 0
    },
    engagementRate: {
        type: Number,
        default: 0
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

export default mongoose.model('Insight', InsightSchema);