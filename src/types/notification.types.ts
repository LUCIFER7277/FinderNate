import { Document, Types } from 'mongoose';

export type NotificationType = 'like' | 'unlike' | 'comment' | 'follow' | 'mention' | 'message' | 'tag' | 'storyView' | 'order' | 'others';

export interface INotification extends Document {
    receiverId: Types.ObjectId;
    senderId: Types.ObjectId;
    type: NotificationType;
    message?: string;
    postId: Types.ObjectId | null;
    commentId: Types.ObjectId | null;
    orderId: Types.ObjectId | null;
    isRead: boolean;
    createdAt: Date;
    updatedAt: Date;
}
