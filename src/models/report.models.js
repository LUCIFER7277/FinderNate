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
    },
    // Admin review fields
    adminRemarks: { type: String },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewedAt: { type: Date },
    actionTaken: {
        type: String,
        enum: ['none', 'warning', 'content_deleted', 'user_suspended', 'user_banned'],
        default: 'none'
    }
}, { timestamps: true });

// Prevent duplicate reports from same user for the same specific target.
// Each index ensures a user can only report the same specific content once.
ReportSchema.index(
    { reporterId: 1, reportedPostId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            reportedPostId: { $exists: true, $ne: null },
            reportedUserId: null,
            reportedCommentId: null,
            reportedStoryId: null
        }
    }
);
ReportSchema.index(
    { reporterId: 1, reportedUserId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            reportedUserId: { $exists: true, $ne: null },
            reportedPostId: null,
            reportedCommentId: null,
            reportedStoryId: null
        }
    }
);
ReportSchema.index(
    { reporterId: 1, reportedCommentId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            reportedCommentId: { $exists: true, $ne: null },
            reportedPostId: null,
            reportedUserId: null,
            reportedStoryId: null
        }
    }
);
ReportSchema.index(
    { reporterId: 1, reportedStoryId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            reportedStoryId: { $exists: true, $ne: null },
            reportedPostId: null,
            reportedUserId: null,
            reportedCommentId: null
        }
    }
);

export default mongoose.model('Report', ReportSchema);
