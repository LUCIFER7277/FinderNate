import { Document, Types } from 'mongoose';

export interface IBusinessRating extends Document {
    businessId: Types.ObjectId;
    userId: Types.ObjectId;
    rating: number;
    createdAt: Date;
    updatedAt: Date;
}
