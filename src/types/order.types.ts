import { Document, Types } from 'mongoose';

export type OrderPaymentStatus = 'pending' | 'paid' | 'held' | 'released' | 'refunded' | 'failed';
export type OrderStatus = 'created' | 'payment_pending' | 'payment_received' | 'processing' | 'shipped' | 'delivered' | 'confirmed' | 'disputed' | 'cancelled' | 'refunded' | 'seller_rejected';
export type DisputeReason = 'damaged_product' | 'wrong_item' | 'missing_item' | 'not_as_described' | 'defective' | 'counterfeit' | 'other';
export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'rejected';
export type SellerResponseStatus = 'confirmed' | 'rejected';
export type SellerRejectionReason = 'out_of_stock' | 'price_change' | 'invalid_address' | 'need_clarification' | 'certificate_required' | 'other';

export interface IShippingAddress {
    fullName?: string;
    phoneNumber?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country: string;
}

export interface IShippingInfo {
    trackingId?: string;
    carrier?: string;
    shippedAt?: Date;
    deliveredAt?: Date;
    packingVideoUrl?: string;
    packingImages?: string[];
}

export interface IBuyerProof {
    paymentScreenshot?: string;
    openingVideoUrl?: string;
    uploadedAt: Date;
}

export interface IDispute {
    reason: DisputeReason;
    description?: string;
    evidence?: string[];
    disputeVideoUrl?: string;
    disputeVideoUploadedAt?: Date;
    status: DisputeStatus;
    resolution?: string;
    createdAt: Date;
    resolvedAt?: Date;
}

export interface ISellerResponse {
    status?: SellerResponseStatus;
    rejectionReason?: SellerRejectionReason;
    rejectionNote?: string;
    respondedAt: Date;
}

export interface IGuestBuyerDetails {
    fullName?: string;
    email?: string;
    phoneNumber?: string;
}

export interface IOrderProductDetails {
    name?: string;
    description?: string;
    price: number;
    quantity: number;
    images?: string[];
    category?: string;
}

export interface IOrderStatusHistory {
    status?: string;
    timestamp: Date;
    note?: string;
}

export interface IOrder extends Document {
    orderNumber: string;
    buyerId?: Types.ObjectId;
    buyerDetails?: IGuestBuyerDetails;
    sellerId: Types.ObjectId;
    postId?: Types.ObjectId;
    chatId?: Types.ObjectId;
    paymentLinkId?: Types.ObjectId;
    productDetails?: IOrderProductDetails;
    amount: number;
    platformFee: number;
    sellerAmount: number;
    currency: string;
    paymentStatus: OrderPaymentStatus;
    orderStatus: OrderStatus;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
    shippingAddress?: IShippingAddress;
    shippingInfo?: IShippingInfo;
    buyerProof?: IBuyerProof;
    dispute?: IDispute;
    sellerResponse?: ISellerResponse;
    statusHistory: IOrderStatusHistory[];
    deliveryConfirmedAt?: Date;
    paymentReleasedAt?: Date;
    buyerRating?: number;
    buyerReview?: string;
    sellerRating?: number;
    sellerReview?: string;
    isShareableOrder: boolean;
    createdAt: Date;
    updatedAt: Date;
}
