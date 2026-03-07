import { Document, Types } from 'mongoose';

export type TaggedUserTargetType = 'Post' | 'Reel' | 'Story' | 'Comment';

export interface ITaggedUserPosition {
    x?: number;
    y?: number;
}

export interface ITaggedUser extends Document {
    taggedBy?: Types.ObjectId;
    targetId: Types.ObjectId;
    targetType: TaggedUserTargetType;
    userId: Types.ObjectId;
    taggedAt: Date;
    position?: ITaggedUserPosition;
}
