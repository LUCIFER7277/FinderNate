import { Document, Types } from 'mongoose';

export interface IApiKey extends Document {
    key: string;
    userId: Types.ObjectId;
    label?: string;
    permissions: string[];
    createdAt: Date;
    expiresAt?: Date;
    lastUsedAt?: Date;
    isActive: boolean;
    usageCount: number;
}
