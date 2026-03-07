import { Document, Types } from 'mongoose';

export type ReportReason = 'spam' | 'harassment' | 'nudity' | 'violence' | 'hateSpeech' | 'scam' | 'other';
export type ReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';
export type ReportActionTaken = 'none' | 'warning' | 'content_deleted' | 'user_suspended' | 'user_banned';

export interface IReport extends Document {
    reporterId: Types.ObjectId;
    reportedUserId: Types.ObjectId | null;
    reportedPostId: Types.ObjectId | null;
    reportedCommentId: Types.ObjectId | null;
    reportedStoryId: Types.ObjectId | null;
    reason: ReportReason;
    description?: string;
    status: ReportStatus;
    adminRemarks?: string;
    reviewedBy?: Types.ObjectId;
    reviewedAt?: Date;
    actionTaken: ReportActionTaken;
    createdAt: Date;
    updatedAt: Date;
}
