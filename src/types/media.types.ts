import { Document, Types } from 'mongoose';

export type MediaType = 'image' | 'video';
export type MediaTargetType = 'Post' | 'Reel' | 'Story' | 'Advertisement';

export interface IMediaMetadata {
    width?: number;
    height?: number;
    duration?: number;
    sizeInBytes?: number;
}

export interface IMedia extends Document {
    url: string;
    type: MediaType;
    targetId: Types.ObjectId;
    targetType: MediaTargetType;
    thumbnailUrl?: string;
    metadata?: IMediaMetadata;
    uploadedBy: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}
