import { Document, Types } from 'mongoose';

export type PostType = 'photo' | 'reel' | 'video' | 'story' | 'tweet';
export type PostContentType = 'normal' | 'product' | 'service' | 'business';
export type PostPrivacy = 'public' | 'private';
export type PostDeliveryOptions = 'online' | 'offline' | 'both';

export interface IGeoJSONPoint {
    type: 'Point';
    coordinates: number[];
}

export interface IMediaDimensions {
    width?: number;
    height?: number;
}

export interface IAdditionalMedia {
    url?: string;
    thumbnailUrl?: string;
    dimensions?: IMediaDimensions;
    order?: number;
}

export interface IPostMedia {
    type?: string;
    url?: string;
    thumbnailUrl?: string;
    duration?: number;
    dimensions?: IMediaDimensions;
    fileSize?: number;
    format?: string;
    additionalMedia?: IAdditionalMedia[];
}

export interface IProductVariant {
    name?: string;
    options?: string[];
}

export interface IProductSpecification {
    key?: string;
    value?: string;
}

export interface IProductLocation {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    coordinates?: IGeoJSONPoint;
}

export interface IProductDetails {
    name?: string;
    description?: string;
    price?: number;
    currency?: string;
    category?: string;
    subcategory?: string;
    brand?: string;
    sku?: string;
    availability?: string;
    inStock: boolean;
    variants?: IProductVariant[];
    specifications?: IProductSpecification[];
    images?: string[];
    tags?: string[];
    weight?: number;
    dimensions?: { length?: number; width?: number; height?: number; unit?: string };
    deliveryOptions: PostDeliveryOptions;
    shippingCharges: number;
    gstPercent: number;
    location?: IProductLocation;
    link?: string;
}

export interface IServiceTimeSlot {
    startTime?: string;
    endTime?: string;
}

export interface IServiceSchedule {
    day?: string;
    timeSlots?: IServiceTimeSlot[];
}

export interface IServiceAvailability {
    schedule?: IServiceSchedule[];
    timezone?: string;
    bookingAdvance?: number;
    maxBookingsPerDay?: number;
}

export interface IServiceLocation {
    type?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    coordinates?: IGeoJSONPoint;
}

export interface IServiceDetails {
    name?: string;
    description?: string;
    price?: number;
    currency?: string;
    category?: string;
    subcategory?: string;
    duration?: number;
    serviceType?: string;
    deliveryOptions: PostDeliveryOptions;
    shippingCharges: number;
    gstPercent: number;
    availability?: IServiceAvailability;
    location?: IServiceLocation;
    requirements?: string[];
    deliverables?: string[];
    tags?: string[];
    link?: string;
}

export interface IBusinessSocialMedia {
    platform?: string;
    url?: string;
}

export interface IBusinessContact {
    phone?: string;
    email?: string;
    website?: string;
    socialMedia?: IBusinessSocialMedia[];
}

export interface IBusinessPostLocation {
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    coordinates?: IGeoJSONPoint;
}

export interface IBusinessHours {
    day?: string;
    openTime?: string;
    closeTime?: string;
    isClosed?: boolean;
}

export interface IBusinessPromotion {
    title?: string;
    description?: string;
    discount?: number;
    validUntil?: Date;
    isActive?: boolean;
}

export interface IBusinessDetails {
    businessName?: string;
    businessType?: string;
    description?: string;
    category?: string;
    subcategory?: string;
    deliveryOptions: PostDeliveryOptions;
    contact?: IBusinessContact;
    location?: IBusinessPostLocation;
    hours?: IBusinessHours[];
    features?: string[];
    priceRange?: string;
    rating?: number;
    tags?: string[];
    announcement?: string;
    promotions?: IBusinessPromotion[];
    link?: string;
}

export interface INormalLocation {
    name?: string;
    address?: string;
    coordinates?: IGeoJSONPoint;
}

export interface INormalDetails {
    mood?: string;
    activity?: string;
    location?: INormalLocation;
    tags?: string[];
}

export interface IPostCustomization {
    product?: IProductDetails;
    service?: IServiceDetails;
    business?: IBusinessDetails;
    normal?: INormalDetails;
}

export interface IPostEngagement {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    views: number;
    reach: number;
    impressions: number;
}

export interface IPostSettings {
    visibility?: string;
    privacy: PostPrivacy;
    isPrivacyTouched: boolean;
    allowComments?: boolean;
    allowLikes?: boolean;
    allowShares?: boolean;
    allowSaves?: boolean;
    commentsFilter?: string;
    hideLikeCount?: boolean;
    allowDownload?: boolean;
    customAudience?: Types.ObjectId[];
}

export interface IPostAnalytics {
    clickThroughs?: number;
    inquiries?: number;
    conversions?: number;
    topCountries?: string[];
    topAgeGroups?: string[];
    genderDistribution?: { male?: number; female?: number; other?: number };
    peakViewingTimes?: { hour?: number; count?: number }[];
}

export interface IPost extends Document {
    userId: Types.ObjectId;
    postType: PostType;
    contentType: PostContentType;
    caption?: string;
    description?: string;
    hashtags?: string[];
    mentions?: Types.ObjectId[];
    media?: IPostMedia[];
    customization?: IPostCustomization;
    engagement?: IPostEngagement;
    settings?: IPostSettings;
    createdAt: Date;
    updatedAt: Date;
    scheduledAt?: Date;
    publishedAt?: Date;
    status?: string;
    isPromoted?: boolean;
    isFeatured?: boolean;
    isReported?: boolean;
    reportCount?: number;
    analytics?: IPostAnalytics;
}
