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
    /**
     * Every gateway payment/order id this subscription has ever been activated
     * with — the redemption history, not just the latest receipt.
     *
     * `paymentId` above holds one id and renewal overwrites it, so it cannot
     * answer "has this payment already been used?": the moment a second month
     * is paid, the first month's id is gone from the database entirely. A paid
     * Cashfree order stays order_status PAID forever, so the user could re-post
     * an old cashfreeOrderId for a free month, alternating old receipts
     * indefinitely. The replay guard has to look at the full history.
     */
    redeemedPaymentIds: {
        type: [String],
        default: [],
        index: true
    },
    autoRenew: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Record the redemption without every caller having to remember to. Both
// activation paths (subscription/payment.js and the legacy Razorpay
// webhook.controllers.js) assign paymentId and then save(), so appending here
// keeps the history complete for renewals and first activations alike.
SubscriptionSchema.pre('save', function (next) {
    if (!Array.isArray(this.redeemedPaymentIds)) this.redeemedPaymentIds = [];

    if (this.isModified('paymentId') && this.paymentId) {
        const id = String(this.paymentId);
        if (!this.redeemedPaymentIds.includes(id)) {
            this.redeemedPaymentIds.push(id);
        }
    }
    next();
});

export default mongoose.model('Subscription', SubscriptionSchema);
