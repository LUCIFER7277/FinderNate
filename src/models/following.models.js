import mongoose from 'mongoose';
import { IFollowing } from '../types/following.types.js';

const FollowingSchema = new mongoose.Schema<IFollowing>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    followingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    }
}, { timestamps: true });

// Prevent duplicate entries
FollowingSchema.index({ userId: 1, followingId: 1 }, { unique: true });

export default mongoose.model('Following', FollowingSchema);
