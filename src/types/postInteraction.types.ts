import { Document, Types } from 'mongoose';

export type PostInteractionType = 'view' | 'like' | 'comment' | 'share' | 'click' | 'hide';

export interface IPostInteraction extends Document {
    userId: Types.ObjectId;
    postId: Types.ObjectId;
    interactionType: PostInteractionType;
    viewDuration: number;
    lastInteracted: Date;
    interactionCount: number;
    isHidden: boolean;
    createdAt: Date;
    updatedAt: Date;
}
