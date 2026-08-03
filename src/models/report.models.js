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
        // under_review: enough reports have accumulated that this is queued for
        // an admin to look at. Distinct from 'reviewed', which means an admin
        // already has.
        enum: ['pending', 'under_review', 'reviewed', 'resolved', 'dismissed'],
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
//
// The "this target is the one that is set" clause is written as
// `{ $type: 'objectId' }`, not `{ $exists: true, $ne: null }`: MongoDB only
// accepts equality, $exists:true, $gt/$gte/$lt/$lte, $type, $and/$or and $in
// inside a partialFilterExpression. With $ne in there, createIndex rejected the
// whole specification, autoIndex swallowed the failure on the unlistened
// 'index' event, and the collection ended up with no index at all — so the
// E11000 branch in reportContent was guarding a constraint that did not exist
// and the same user could file the same report several times. Same operator
// like.models.js uses for the identical "which target is set" shape.
ReportSchema.index(
    { reporterId: 1, reportedPostId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            reportedPostId: { $type: 'objectId' },
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
            reportedUserId: { $type: 'objectId' },
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
            reportedCommentId: { $type: 'objectId' },
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
            reportedStoryId: { $type: 'objectId' },
            reportedPostId: null,
            reportedUserId: null,
            reportedCommentId: null
        }
    }
);

export default mongoose.model('Report', ReportSchema);
