import { Document, Types } from 'mongoose';

export interface ILike extends Document {
    userId: Types.ObjectId;
    postId?: Types.ObjectId;
    commentId: Types.ObjectId | null;
    createdAt: Date;
}
