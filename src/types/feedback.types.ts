import { Document, Types } from 'mongoose';

export interface IFeedback extends Document {
    userId: Types.ObjectId;
    message: string;
    submittedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
