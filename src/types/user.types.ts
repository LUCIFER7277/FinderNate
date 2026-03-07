import { Document, Types } from 'mongoose';

export type UserGender = 'male' | 'female' | 'other';
export type UserPrivacy = 'private' | 'public';
export type UserAccountStatus = 'active' | 'deactivated' | 'banned';
export type UserMessagingVisibility = 'everyone' | 'followers' | 'nobody';

export interface IUserMessagingPrivacy {
    onlineStatus: UserMessagingVisibility;
    lastSeen: UserMessagingVisibility;
}

export interface IUserServicePostPreferences {
    enableAutoFill: boolean;
}

export interface IUserProductPostPreferences {
    enableAutoFill: boolean;
}

export interface IUser extends Document {
    uid: string;
    username: string;
    email: string;
    password: string;
    fullName: string;
    fullNameLower?: string;
    phoneNumber?: string;
    dateOfBirth?: string;
    gender?: UserGender;
    bio?: string;
    profileImageUrl?: string;
    location?: string;
    address?: string;
    isPhoneNumberHidden: boolean;
    isAddressHidden: boolean;
    privacy: UserPrivacy;
    isFullPrivate: boolean;
    messagingPrivacy: IUserMessagingPrivacy;
    lastSeenAt: Date;
    link?: string;
    followers: Types.ObjectId[];
    following: Types.ObjectId[];
    posts: Types.ObjectId[];
    isBusinessProfile: boolean;
    businessProfileId?: Types.ObjectId;
    isBlueTickVerified: boolean;
    isEmailVerified: boolean;
    emailVerificationToken?: string;
    emailOTPExpiry?: Date;
    emailOTP?: string;
    passwordResetOTP?: string;
    passwordResetOTPExpiry?: Date;
    isPhoneVerified: boolean;
    phoneVerificationCode?: string;
    phoneVerificationExpiry?: Date;
    refreshToken?: string;
    accountStatus: UserAccountStatus;
    servicePostPreferences: IUserServicePostPreferences;
    productPostPreferences: IUserProductPostPreferences;
    fcmToken: string | null;
    fcmTokenUpdatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    isPasswordCorrect(password: string): Promise<boolean>;
    generateAccessToken(): string;
    generateRefreshToken(): string;
    hasCallingAccess(): Promise<boolean>;
    getSubscriptionTier(): Promise<string>;
    getSubscriptionBadge(): Promise<{ type: string; label: string; color: string; isPaid: boolean } | null>;
}
