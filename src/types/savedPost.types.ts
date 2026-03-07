import { Document, Types } from 'mongoose';

export interface ISavedPost extends Document {
    userId: Types.ObjectId;
    postId: Types.ObjectId;
    savedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
