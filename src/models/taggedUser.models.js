import mongoose from 'mongoose';

const TaggedUserSchema = new mongoose.Schema({
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    targetType: {
        type: String,
        required: true,
        enum: ['Post', 'Reel', 'Story', 'Comment']
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    taggedAt: {
        type: Date,
        default: Date.now
    },
    position: {
        x: Number,
        y: Number
    }
});

// Prevent duplicate tagging in the same target
TaggedUserSchema.index({ targetId: 1, targetType: 1, userId: 1 }, { unique: true });

export default mongoose.model('TaggedUser', TaggedUserSchema);
