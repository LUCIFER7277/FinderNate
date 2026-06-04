import mongoose from 'mongoose';

const PostInteractionSchema = new mongoose.Schema({
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
    interactionType: {
        type: String,
        enum: ['view', 'like', 'comment', 'share', 'click', 'hide'],
        required: true
    },
    viewDuration: {
        type: Number, // in seconds
        default: 0
    },
    lastInteracted: {
        type: Date,
        default: Date.now
    },
    interactionCount: {
        type: Number,
        default: 1
    },
    isHidden: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

// Compound index for efficient querying
PostInteractionSchema.index({ userId: 1, postId: 1, interactionType: 1 });
PostInteractionSchema.index({ userId: 1, lastInteracted: -1 });
PostInteractionSchema.index({ postId: 1, interactionType: 1 });

// TTL index to automatically remove old interactions after 90 days
PostInteractionSchema.index({ lastInteracted: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model('PostInteraction', PostInteractionSchema);