import { Document, Types } from 'mongoose';

export interface IFollower extends Document {
    userId: Types.ObjectId;
    followerId: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}
