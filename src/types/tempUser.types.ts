import { Document } from 'mongoose';

export interface ITempUser extends Document {
    fullName?: string;
    fullNameLower?: string;
    username?: string;
    email?: string;
    password?: string;
    phoneNumber?: string;
    dateOfBirth?: string;
    gender?: string;
    emailOTP?: string;
    emailOTPExpiry?: Date;
    createdAt: Date;
    updatedAt: Date;
}
