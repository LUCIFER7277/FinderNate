import mongoose from 'mongoose';

const LikeSchema = new mongoose.Schema({
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
    commentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null // Optional – supports likes on comments too
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// 🛡 Prevent duplicate likes (one like per user per post/comment)
LikeSchema.index({ userId: 1, postId: 1 }, { unique: true, partialFilterExpression: { postId: { $type: "objectId" } } });
LikeSchema.index({ userId: 1, commentId: 1 }, { unique: true, partialFilterExpression: { commentId: { $type: "objectId" } } });

export default mongoose.model('Like', LikeSchema);
