import mongoose from "mongoose";

const EscrowTransactionSchema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: String,
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['credit', 'debit', 'hold', 'release', 'refund'], required: true },
    amount: { type: Number, required: true },
    description: String,
    createdAt: { type: Date, default: Date.now }
}, { _id: true });

const EscrowWalletSchema = new mongoose.Schema({
    isSystemWallet: { type: Boolean, default: true, unique: true },
    totalBalance: { type: Number, default: 0 },
    heldBalance: { type: Number, default: 0 },
    releasedBalance: { type: Number, default: 0 },
    refundedBalance: { type: Number, default: 0 },
    platformEarnings: { type: Number, default: 0 },
    transactions: [EscrowTransactionSchema],
    lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

EscrowWalletSchema.statics.getWallet = async function() {
    let wallet = await this.findOne({ isSystemWallet: true });
    if (!wallet) {
        wallet = await this.create({ isSystemWallet: true });
    }
    return wallet;
};

EscrowWalletSchema.methods.holdFunds = async function(order, amount, description, opts = {}) {
    this.heldBalance += amount;
    this.totalBalance += amount;
    this.transactions.push({
        orderId: order._id,
        orderNumber: order.orderNumber,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        type: 'hold',
        amount,
        description: description || 'Payment held in escrow'
    });
    this.lastUpdated = new Date();
    return this.save(opts);
};

EscrowWalletSchema.methods.releaseFunds = async function(order, amount, platformFee, description, opts = {}) {
    if (this.heldBalance < amount) {
        throw new Error('Insufficient held balance');
    }
    this.heldBalance -= amount;
    this.releasedBalance += (amount - platformFee);
    this.platformEarnings += platformFee;
    this.totalBalance -= amount;
    this.transactions.push({
        orderId: order._id,
        orderNumber: order.orderNumber,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        type: 'release',
        amount: amount - platformFee,
        description: description || `Payment released to seller (Platform fee: ${platformFee})`
    });
    this.lastUpdated = new Date();
    return this.save(opts);
};

EscrowWalletSchema.methods.refundFunds = async function(order, amount, description, opts = {}) {
    if (this.heldBalance < amount) {
        throw new Error('Insufficient held balance for refund');
    }
    this.heldBalance -= amount;
    this.refundedBalance += amount;
    this.totalBalance -= amount;
    this.transactions.push({
        orderId: order._id,
        orderNumber: order.orderNumber,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        type: 'refund',
        amount,
        description: description || 'Payment refunded to buyer'
    });
    this.lastUpdated = new Date();
    return this.save(opts);
};

export default mongoose.model('EscrowWallet', EscrowWalletSchema);
