import { Document, Types } from 'mongoose';

export interface IInsight extends Document {
    postId: Types.ObjectId;
    views: number;
    likes: number;
    shares: number;
    comments: number;
    saves: number;
    reach: number;
    engagementRate: number;
    updatedAt: Date;
    createdAt: Date;
}
