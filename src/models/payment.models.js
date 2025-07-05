import mongoose from 'mongoose';

const PaymentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        default: 'INR'
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending'
    },
    method: {
        type: String,
        enum: ['card', 'upi', 'wallet', 'netbanking', 'cash'],
        required: true
    },
    transactionId: {
        type: String,
        unique: true
    },
    purpose: {
        type: String, // e.g. 'subscription', 'ad', 'product', 'donation'
        required: true
    },
    metadata: {
        type: Object, // extra info like planId, productId, etc.
        default: {}
    },
    paidAt: Date,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('Payment', PaymentSchema);
