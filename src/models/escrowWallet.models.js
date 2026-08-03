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

// Builds the ledger row for a balance movement.
const buildTransaction = (order, type, amount, description) => ({
    orderId: order._id,
    orderNumber: order.orderNumber,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
    type,
    amount,
    description,
    createdAt: new Date()
});

// There is exactly one system wallet and every payment touches it, so the
// balances are updated with atomic $inc / $push operators rather than a
// read-modify-write save(): two concurrent payments used to read the same
// starting balance and the second $set silently overwrote the first, losing
// money from the ledger.
//
// `transactions` is deliberately NOT selected here. The array grows without
// bound and every payment verification loaded the whole thing over the wire.
// $push does not need it to be in memory; the admin transaction list reads it
// through its own paginated query.
EscrowWalletSchema.statics.getWallet = async function(opts = {}) {
    return this.findOneAndUpdate(
        { isSystemWallet: true },
        { $setOnInsert: { isSystemWallet: true } },
        { new: true, upsert: true, setDefaultsOnInsert: true, projection: { transactions: 0 }, ...opts }
    );
};

// Applies a balance movement atomically. `guard` is merged into the filter so
// the update only lands while the wallet is still in the expected state
// (compare-and-set); a null result means another request got there first.
EscrowWalletSchema.methods.applyMovement = async function(inc, transaction, opts = {}, guard = {}) {
    return this.constructor.findOneAndUpdate(
        { _id: this._id, ...guard },
        {
            $inc: inc,
            $push: { transactions: transaction },
            $set: { lastUpdated: new Date() }
        },
        { new: true, projection: { transactions: 0 }, ...opts }
    );
};

// Money arrived from the gateway and is now held against this order.
EscrowWalletSchema.methods.holdFunds = async function(order, amount, description, opts = {}) {
    const updated = await this.applyMovement(
        { heldBalance: amount, totalBalance: amount },
        buildTransaction(order, 'hold', amount, description || 'Payment held in escrow'),
        opts
    );
    if (!updated) throw new Error('Escrow wallet not found');
    return updated;
};

// Money arrived from the gateway for a direct (store) sale. Recorded as a
// credit but held the same way, so admin can still release or refund it.
EscrowWalletSchema.methods.creditPayment = async function(order, amount, description, opts = {}) {
    const updated = await this.applyMovement(
        { heldBalance: amount, totalBalance: amount },
        buildTransaction(order, 'credit', amount, description || 'Payment credited to escrow'),
        opts
    );
    if (!updated) throw new Error('Escrow wallet not found');
    return updated;
};

EscrowWalletSchema.methods.releaseFunds = async function(order, amount, platformFee, description, opts = {}) {
    // The balance check lives in the filter, not in JS, so a double-click
    // cannot pass the check twice and debit the same funds twice.
    const updated = await this.applyMovement(
        {
            heldBalance: -amount,
            releasedBalance: (amount - platformFee),
            platformEarnings: platformFee,
            totalBalance: -amount
        },
        buildTransaction(
            order,
            'release',
            amount - platformFee,
            description || `Payment released to seller (Platform fee: ${platformFee})`
        ),
        opts,
        { heldBalance: { $gte: amount } }
    );
    if (!updated) throw new Error('Insufficient held balance');
    return updated;
};

EscrowWalletSchema.methods.refundFunds = async function(order, amount, description, opts = {}) {
    const updated = await this.applyMovement(
        {
            heldBalance: -amount,
            refundedBalance: amount,
            totalBalance: -amount
        },
        buildTransaction(order, 'refund', amount, description || 'Payment refunded to buyer'),
        opts,
        { heldBalance: { $gte: amount } }
    );
    if (!updated) throw new Error('Insufficient held balance for refund');
    return updated;
};

export default mongoose.model('EscrowWallet', EscrowWalletSchema);
