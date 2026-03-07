import { Document, Types } from 'mongoose';

export type DeviceType = 'web' | 'android' | 'ios' | 'other';

export interface IDevice extends Document {
    userId: Types.ObjectId;
    deviceId: string;
    deviceType: DeviceType;
    browser?: string;
    os?: string;
    ipAddress?: string;
    lastUsedAt: Date;
    isLoggedIn: boolean;
}
