import { Document, Types } from 'mongoose';

export type ContactRequestStatus = 'pending' | 'approved' | 'denied';

export interface IContactRequest extends Document {
    requester: Types.ObjectId;
    business: Types.ObjectId;
    businessOwner: Types.ObjectId;
    status: ContactRequestStatus;
    message?: string;
    responseMessage?: string;
    respondedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
