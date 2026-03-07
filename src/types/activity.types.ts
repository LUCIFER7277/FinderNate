import { Document, Types } from 'mongoose';

export type ActivityAction = 'like' | 'comment' | 'follow' | 'unfollow' | 'post' | 'message' | 'share' | 'storyView' | 'save';
export type ActivityTargetType = 'User' | 'Post' | 'Comment' | 'Story' | 'Message' | 'Notification';

export interface IActivityLog extends Document {
    userId: Types.ObjectId;
    action: ActivityAction;
    targetId: Types.ObjectId;
    targetType: ActivityTargetType;
    createdAt: Date;
    additionalInfo: Map<string, string>;
}
