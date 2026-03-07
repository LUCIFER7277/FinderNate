import mongoose from 'mongoose';
import { IFollower } from '../types/follower.types.js';

const FollowerSchema = new mongoose.Schema<IFollower>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    followerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    }
}, { timestamps: true });

// 🚫 Prevent duplicate follower pairs
FollowerSchema.index({ userId: 1, followerId: 1 }, { unique: true });

export default mongoose.model('Follower', FollowerSchema);
