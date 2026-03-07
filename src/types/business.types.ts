import { Document, Types } from 'mongoose';

export type DocumentType = 'gst' | 'aadhaar' | 'pan' | 'license' | 'registration' | 'other';
export type BusinessPlan = 'plan1' | 'plan2' | 'plan3' | 'plan4';
export type BusinessSubscriptionStatus = 'active' | 'inactive' | 'pending';
export type BusinessVerificationStatus = 'pending' | 'approved' | 'rejected';
export type BankAccountType = 'savings' | 'current';

export interface ISocialMedia {
    platform?: string;
    url?: string;
}

export interface IBusinessContact {
    phone?: string;
    email?: string;
    website?: string;
    socialMedia?: ISocialMedia[];
}

export interface IGeoJSONPoint {
    type: 'Point';
    coordinates: number[];
}

export interface IBusinessLocation {
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    coordinates?: IGeoJSONPoint;
    isLiveLocationEnabled: boolean;
    lastLocationUpdate?: Date;
}

export interface IBusinessDocument {
    _id: Types.ObjectId;
    documentType: DocumentType;
    documentName: string;
    documentUrl: string;
    uploadedAt: Date;
    verified: boolean;
    verifiedAt?: Date;
    verifiedBy?: Types.ObjectId;
    remarks?: string;
}

export interface IBankDetails {
    accountHolderName?: string;
    bankName?: string;
    accountNumber?: string;
    ifscCode?: string;
    accountType?: BankAccountType;
    upiId?: string;
    branchName?: string;
    paymentQRCode?: string;
    isVerified: boolean;
    verifiedAt?: Date;
    verifiedBy?: Types.ObjectId;
    updatedAt?: Date;
}

export interface IBusinessInsights {
    views: number;
    clicks: number;
    conversions: number;
}

export interface IBusinessPostSettings {
    allowProductPosts: boolean;
    allowServicePosts: boolean;
}

export interface IBusiness extends Document {
    userId: Types.ObjectId;
    businessName?: string;
    businessType?: string;
    description?: string;
    category?: string;
    subcategory?: string;
    contact?: IBusinessContact;
    location?: IBusinessLocation;
    rating?: number;
    tags?: string[];
    website?: string;
    gstNumber?: string;
    aadhaarNumber?: string;
    documents: IBusinessDocument[];
    bankDetails?: IBankDetails;
    logoUrl?: string;
    isVerified: boolean;
    followers: Types.ObjectId[];
    insights: IBusinessInsights;
    plan: BusinessPlan;
    subscriptionStatus: BusinessSubscriptionStatus;
    verificationStatus: BusinessVerificationStatus;
    verificationRemarks?: string;
    verifiedAt?: Date;
    verifiedBy?: Types.ObjectId;
    rejectedAt?: Date;
    rejectedBy?: Types.ObjectId;
    gstVerified: boolean;
    gstVerifiedAt?: Date;
    gstVerifiedBy?: Types.ObjectId;
    aadhaarVerified: boolean;
    aadhaarVerifiedAt?: Date;
    aadhaarVerifiedBy?: Types.ObjectId;
    postSettings: IBusinessPostSettings;
    isProfileCompleted: boolean;
    createdAt: Date;
    updatedAt: Date;
}
