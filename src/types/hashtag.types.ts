import { Document, Types } from 'mongoose';

export interface IHashtag extends Document {
    tag: string;
    posts: Types.ObjectId[];
    usageCount: number;
    lastUsedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
