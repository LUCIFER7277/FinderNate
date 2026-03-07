import { Document, Types } from 'mongoose';

export type DraftType = 'Post' | 'Reel' | 'Story' | 'Tweet';
export type DraftMediaType = 'image' | 'video';

export interface IDraftMedia {
    url?: string;
    type?: DraftMediaType;
}

export interface IDraft extends Document {
    userId: Types.ObjectId;
    type: DraftType;
    content?: string;
    media?: IDraftMedia[];
    taggedUsers?: Types.ObjectId[];
    location?: string;
    tags?: string[];
    createdAt: Date;
    updatedAt?: Date;
    isAutoSaved: boolean;
}
