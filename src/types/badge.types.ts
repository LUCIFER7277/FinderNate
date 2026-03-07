import { Document } from 'mongoose';

export type BadgeType = 'system' | 'earned' | 'custom';

export interface IBadge extends Document {
    name: string;
    iconUrl: string;
    description?: string;
    criteria: string;
    type: BadgeType;
    isActive: boolean;
    createdAt: Date;
}
