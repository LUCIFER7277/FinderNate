import { Document, Types } from 'mongoose';

export interface IBlock extends Document {
    blockerId: Types.ObjectId;
    blockedId: Types.ObjectId;
    reason?: string;
    createdAt: Date;
}
