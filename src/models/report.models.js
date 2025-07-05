import mongoose from 'mongoose';

const ReportSchema = new mongoose.Schema({
    reporterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reportedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    reportedPostId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        default: null
    },
    reportedCommentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null
    },
    reportedStoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Story',
        default: null
    },
    reason: {
        type: String,
        required: true,
        enum: ['spam', 'harassment', 'nudity', 'violence', 'hateSpeech', 'scam', 'other']
    },
    description: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['pending', 'reviewed', 'resolved', 'dismissed'],
        default: 'pending'
    }
}, { timestamps: true });

// Optional: Prevent duplicate reports from same user for the same post/comment/user
ReportSchema.index({ reporterId: 1, reportedPostId: 1 }, { unique: true, sparse: true });
ReportSchema.index({ reporterId: 1, reportedUserId: 1 }, { unique: true, sparse: true });
ReportSchema.index({ reporterId: 1, reportedCommentId: 1 }, { unique: true, sparse: true });
ReportSchema.index({ reporterId: 1, reportedStoryId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Report', ReportSchema);
