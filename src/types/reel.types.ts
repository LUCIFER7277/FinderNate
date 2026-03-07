import { Document, Types } from 'mongoose';

export interface IReelMusic {
    title?: string;
    url?: string;
}

export interface IReel extends Document {
    userId: Types.ObjectId;
    videoUrl: string;
    caption?: string;
    thumbnailUrl?: string;
    hashtags?: string[];
    music?: IReelMusic;
    likes?: Types.ObjectId[];
    comments?: Types.ObjectId[];
    views: number;
    isPublic: boolean;
    isFeatured: boolean;
    createdAt: Date;
    updatedAt: Date;
}
