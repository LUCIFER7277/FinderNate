import { Document, Types } from 'mongoose';

export type MessageType = 'text' | 'image' | 'video' | 'file' | 'audio' | 'location' | 'payment_link' | 'checkout' | 'order_update';
export type MessageDeliveryStatus = 'sent' | 'delivered' | 'seen';
export type CheckoutStatus = 'pending' | 'paid' | 'expired';
export type MessageProductType = 'product' | 'service' | 'business';

export interface IMessageLocation {
    latitude?: number;
    longitude?: number;
    address?: string;
}

export interface IMessageDeliveryStatus {
    userId?: Types.ObjectId;
    status: MessageDeliveryStatus;
    deliveredAt?: Date;
    seenAt?: Date;
}

export interface IMessageDeletedFor {
    userId?: Types.ObjectId;
    deletedAt: Date;
}

export interface IMessageReaction {
    user?: Types.ObjectId;
    emoji?: string;
    timestamp: Date;
}

export interface IMessageProductReference {
    postId?: Types.ObjectId;
    businessId?: Types.ObjectId;
    productName?: string;
    productImage?: string;
    productPrice?: number;
    productType?: MessageProductType;
    productDescription?: string;
    location?: string;
}

export interface IMessageForwardedFrom {
    messageId?: Types.ObjectId;
    chatId?: Types.ObjectId;
    originalSender?: Types.ObjectId;
}

export interface IMessageLinkPreview {
    url?: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    fetchedAt?: Date;
}

export interface IMessageCheckoutSpecification {
    key?: string;
    value?: string;
}

export interface IMessageCheckoutVariant {
    name?: string;
    options?: string[];
}

export interface IMessageCheckoutDetails {
    postId?: Types.ObjectId;
    productName?: string;
    productDescription?: string;
    productImages?: string[];
    productCategory?: string;
    productType?: 'product' | 'service';
    specifications?: IMessageCheckoutSpecification[];
    variants?: IMessageCheckoutVariant[];
    deliveryOptions?: string;
    sellerLocation?: string;
    basePrice?: number;
    shippingCharges?: number;
    gstPercent?: number;
    gstAmount?: number;
    totalPrice?: number;
    currency: string;
    sellerId?: Types.ObjectId;
    sellerName?: string;
    sellerUsername?: string;
    sellerAvatar?: string;
    paymentLinkId?: string;
    paymentUrl?: string;
    checkoutStatus: CheckoutStatus;
    expiresAt?: Date;
}

export interface IMessage extends Document {
    chatId: Types.ObjectId;
    sender: Types.ObjectId;
    message: string;
    messageType: MessageType;
    mediaUrl?: string;
    fileName?: string;
    fileSize?: number;
    duration?: number;
    location?: IMessageLocation;
    replyTo?: Types.ObjectId;
    timestamp: Date;
    readBy?: Types.ObjectId[];
    deliveryStatus?: IMessageDeliveryStatus[];
    isDeleted: boolean;
    deletedAt?: Date;
    deletedFor?: IMessageDeletedFor[];
    deletedForEveryone: boolean;
    deletedForEveryoneAt?: Date;
    editedAt?: Date;
    originalMessage?: string;
    reactions?: IMessageReaction[];
    productReference?: IMessageProductReference;
    forwardedFrom?: IMessageForwardedFrom;
    isForwarded: boolean;
    isPinned: boolean;
    pinnedBy?: Types.ObjectId;
    pinnedAt?: Date;
    isEdited: boolean;
    originalContent?: string;
    waveform?: number[];
    linkPreview?: IMessageLinkPreview;
    checkoutDetails?: IMessageCheckoutDetails;
    createdAt: Date;
    updatedAt: Date;
}
