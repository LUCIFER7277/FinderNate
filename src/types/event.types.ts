import { Document, Types } from 'mongoose';

export interface IEvent extends Document {
    title: string;
    description?: string;
    date: Date;
    location?: string;
    createdBy: Types.ObjectId;
    media?: string[];
    attendees?: Types.ObjectId[];
    tags?: string[];
    isOnline: boolean;
    eventUrl?: string;
    capacity?: number;
    createdAt: Date;
}
