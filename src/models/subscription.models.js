import mongoose from 'mongoose';

const SubscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
        unique: true // One active subscription per user (unless you support multiple)
    },
    plan: {
        type: String,
        required: true,
        enum: ['free', 'small_business', 'corporate'] // Only three tiers: free, small_business, and corporate
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'expired', 'cancelled'],
        default: 'active'
    },
    paymentId: {
        type: String,
        default: null // Link to external payment gateway transaction ID
    },
    autoRenew: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

export default mongoose.model('Subscription', SubscriptionSchema);
