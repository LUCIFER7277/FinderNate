import { Document, Types } from 'mongoose';

export type StoryMediaType = 'image' | 'video';

export interface IStory extends Document {
    userId: Types.ObjectId;
    mediaUrl: string;
    mediaType: StoryMediaType;
    caption?: string;
    viewers?: Types.ObjectId[];
    isArchived: boolean;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
