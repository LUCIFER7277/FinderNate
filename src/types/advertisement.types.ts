import { Document, Types } from 'mongoose';

export type AdvertisementStatus = 'pending' | 'approved' | 'rejected' | 'running' | 'paused' | 'completed';
export type AdvertisementGender = 'male' | 'female' | 'any';

export interface IAdvertisementTargetAudience {
    gender: AdvertisementGender;
    ageRange: number[];
    locations: string[];
}

export interface IAdvertisement extends Document {
    userId: Types.ObjectId;
    mediaUrl: string;
    caption?: string;
    link: string;
    budget: number;
    costPerClick: number;
    costPerImpression: number;
    impressions: number;
    clicks: number;
    targetAudience: IAdvertisementTargetAudience;
    startDate: Date;
    endDate?: Date;
    isActive: boolean;
    status: AdvertisementStatus;
    createdAt: Date;
    updatedAt: Date;
}
