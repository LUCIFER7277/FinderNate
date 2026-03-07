import { Document, Types } from 'mongoose';

export type ChatType = 'direct' | 'group';
export type ChatStatus = 'active' | 'requested' | 'declined';
export type ProductContextType = 'product' | 'service' | 'business';

export interface IChatLastMessage {
    sender?: Types.ObjectId;
    message?: string;
    timestamp?: Date;
}

export interface IChatStats {
    totalMessages: number;
    totalParticipants: number;
}

export interface IChatProductContext {
    postId?: Types.ObjectId;
    businessId?: Types.ObjectId;
    productName?: string;
    productImage?: string;
    productPrice?: number;
    productType?: ProductContextType;
    productDescription?: string;
    location?: string;
}

export interface IChat extends Document {
    participants: Types.ObjectId[];
    chatType: ChatType;
    status: ChatStatus;
    groupName?: string;
    groupDescription?: string;
    groupImage?: string;
    admins?: Types.ObjectId[];
    createdBy: Types.ObjectId;
    lastMessageId?: Types.ObjectId;
    lastMessage?: IChatLastMessage;
    lastMessageAt: Date;
    mutedBy?: Types.ObjectId[];
    pinnedMessages?: Types.ObjectId[];
    blockedUsers?: Types.ObjectId[];
    themeColor: string;
    stats: IChatStats;
    productContext?: IChatProductContext;
    createdAt: Date;
    updatedAt: Date;
}
