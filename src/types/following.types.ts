import { Document, Types } from 'mongoose';

export interface IFollowing extends Document {
    userId: Types.ObjectId;
    followingId: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}
