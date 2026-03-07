import { Document, Types } from 'mongoose';

export type CallType = 'voice' | 'video';
export type CallStatus = 'initiated' | 'ringing' | 'connecting' | 'active' | 'ended' | 'declined' | 'missed' | 'failed';
export type CallEndReason = 'normal' | 'declined' | 'missed' | 'failed' | 'network_error' | 'cancelled' | 'timeout';
export type CallQuality = 'excellent' | 'good' | 'poor' | 'failed';
export type CallConnectionType = 'wifi' | 'cellular' | 'unknown';

export interface ICallMetadata {
    initiatorDevice?: string;
    receiverDevice?: string;
    quality: CallQuality;
    connectionType: CallConnectionType;
}

export interface ICall extends Document {
    participants: Types.ObjectId[];
    initiator: Types.ObjectId;
    chatId: Types.ObjectId;
    callType: CallType;
    status: CallStatus;
    initiatedAt: Date;
    startedAt?: Date;
    endedAt?: Date;
    duration: number;
    endReason: CallEndReason;
    endedBy?: Types.ObjectId;
    metadata?: ICallMetadata;
    createdAt: Date;
    updatedAt: Date;
    formattedDuration: string;
    wasAnswered: boolean;
    isOngoing: boolean;
}
