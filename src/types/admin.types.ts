import { Document, Types } from 'mongoose';

export interface IAdminPermissions {
    verifyAadhaar: boolean;
    manageReports: boolean;
    manageUsers: boolean;
    manageBusiness: boolean;
    systemSettings: boolean;
    viewAnalytics: boolean;
    deleteContent: boolean;
    banUsers: boolean;
}

export interface IAdminActivityLog {
    action: string;
    targetType: string;
    targetId: string;
    details: string;
    timestamp: Date;
}

export interface IAdmin extends Document {
    uid: string;
    username: string;
    email: string;
    password: string;
    fullName: string;
    role: string;
    permissions: IAdminPermissions;
    profileImageUrl?: string;
    isActive: boolean;
    lastLogin?: Date;
    refreshToken?: string;
    createdBy: Types.ObjectId | null;
    activityLog: IAdminActivityLog[];
    createdAt: Date;
    updatedAt: Date;
    isPasswordCorrect(password: string): Promise<boolean>;
    generateAccessToken(): string;
    generateRefreshToken(): string;
    logActivity(action: string, targetType: string, targetId: string, details: string): Promise<IAdmin>;
}
