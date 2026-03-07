import { Document, Types } from 'mongoose';

export interface IComment extends Document {
    postId: Types.ObjectId;
    userId: Types.ObjectId;
    content: string;
    parentCommentId: Types.ObjectId | null;
    rootCommentId: Types.ObjectId | null;
    replyToUserId: Types.ObjectId | null;
    likes: Types.ObjectId[];
    isEdited: boolean;
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
}
