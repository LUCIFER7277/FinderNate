import mongoose from 'mongoose';

const FollowingSchema = new mongoose.Schema({
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
