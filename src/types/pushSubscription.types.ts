import { Document, Types } from 'mongoose';

export interface IPushSubscription extends Document {
    userId: Types.ObjectId;
    endpoint: string;
    p256dh: string;
    auth: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}
