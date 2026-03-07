import { Document, Types } from 'mongoose';

export type EscrowTransactionType = 'credit' | 'debit' | 'hold' | 'release' | 'refund';

export interface IEscrowTransaction {
    _id: Types.ObjectId;
    orderId: Types.ObjectId;
    orderNumber?: string;
    buyerId?: Types.ObjectId;
    sellerId?: Types.ObjectId;
    type: EscrowTransactionType;
    amount: number;
    description?: string;
    createdAt: Date;
}

export interface IEscrowWallet extends Document {
    isSystemWallet: boolean;
    totalBalance: number;
    heldBalance: number;
    releasedBalance: number;
    refundedBalance: number;
    platformEarnings: number;
    transactions: IEscrowTransaction[];
    lastUpdated: Date;
    createdAt: Date;
    updatedAt: Date;
    holdFunds(order: { _id: Types.ObjectId; orderNumber?: string; buyerId?: Types.ObjectId; sellerId?: Types.ObjectId }, amount: number, description?: string): Promise<IEscrowWallet>;
    releaseFunds(order: { _id: Types.ObjectId; orderNumber?: string; buyerId?: Types.ObjectId; sellerId?: Types.ObjectId }, amount: number, platformFee: number, description?: string): Promise<IEscrowWallet>;
    refundFunds(order: { _id: Types.ObjectId; orderNumber?: string; buyerId?: Types.ObjectId; sellerId?: Types.ObjectId }, amount: number, description?: string): Promise<IEscrowWallet>;
}
