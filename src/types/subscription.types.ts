import { Document, Types } from 'mongoose';

export type SubscriptionPlan = 'free' | 'small_business' | 'corporate';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface ISubscription extends Document {
    userId: Types.ObjectId;
    plan: SubscriptionPlan;
    startDate: Date;
    endDate: Date;
    status: SubscriptionStatus;
    paymentId: string | null;
    autoRenew: boolean;
    createdAt: Date;
    updatedAt: Date;
}
