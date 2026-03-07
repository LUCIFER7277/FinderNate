import { Document, Types } from 'mongoose';

export type PaymentLinkStatus = 'active' | 'paid' | 'expired' | 'cancelled';

export interface IPaymentLinkProductDetails {
    name: string;
    description?: string;
    price: number;
    images?: string[];
    category?: string;
}

export interface IPaymentLink extends Document {
    linkId: string;
    sellerId: Types.ObjectId;
    buyerId?: Types.ObjectId;
    chatId?: Types.ObjectId;
    postId?: Types.ObjectId;
    productDetails?: IPaymentLinkProductDetails;
    amount: number;
    currency: string;
    status: PaymentLinkStatus;
    expiresAt?: Date;
    paidAt?: Date;
    orderId?: Types.ObjectId;
    paymentUrl?: string;
    shortUrl?: string;
    isShareableLink: boolean;
    createdAt: Date;
    updatedAt: Date;
}
