import { Document, Types } from 'mongoose';

export type FollowRequestStatus = 'pending' | 'approved' | 'rejected';

export interface IFollowRequest extends Document {
    requesterId: Types.ObjectId;
    recipientId: Types.ObjectId;
    status: FollowRequestStatus;
    createdAt: Date;
    updatedAt: Date;
}
