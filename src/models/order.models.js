import mongoose from "mongoose";

const ShippingAddressSchema = new mongoose.Schema({
    fullName: String,
    phoneNumber: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    postalCode: String,
    country: { type: String, default: 'India' }
}, { _id: false });

const ShippingInfoSchema = new mongoose.Schema({
    trackingId: String,
    carrier: String,
    shippedAt: Date,
    deliveredAt: Date,
    packingVideoUrl: String,
    packingImages: [String]
}, { _id: false });

const BuyerProofSchema = new mongoose.Schema({
    paymentScreenshot: String,
    openingVideoUrl: String,
    uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const DisputeSchema = new mongoose.Schema({
    reason: {
        type: String,
        enum: ['damaged_product', 'wrong_item', 'missing_item', 'not_as_described', 'defective', 'counterfeit', 'other'],
        required: true
    },
    description: String,
    evidence: [String],
    disputeVideoUrl: String,
    disputeVideoUploadedAt: Date,
    status: { type: String, enum: ['open', 'under_review', 'resolved', 'rejected'], default: 'open' },
    resolution: String,
    createdAt: { type: Date, default: Date.now },
    resolvedAt: Date
}, { _id: false });

const SellerResponseSchema = new mongoose.Schema({
    status: { type: String, enum: ['confirmed', 'rejected'] },
    rejectionReason: {
        type: String,
        enum: [
            'out_of_stock',
            'price_change',
            'invalid_address',
            'need_clarification',
            'certificate_required',
            'other'
        ]
    },
    rejectionNote: String,
    respondedAt: { type: Date, default: Date.now }
}, { _id: false });

// Guest buyer details schema (for shareable payment links)
const GuestBuyerDetailsSchema = new mongoose.Schema({
    fullName: String,
    email: String,
    phoneNumber: String
}, { _id: false });

const OrderSchema = new mongoose.Schema({
    orderNumber: { type: String, required: true, unique: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Optional for guest checkout
    buyerDetails: GuestBuyerDetailsSchema, // For guest buyers via shareable links
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
    paymentLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentLink' },
    productDetails: {
        name: String,
        description: String,
        price: { type: Number, required: true },
        quantity: { type: Number, default: 1 },
        images: [String],
        category: String
    },
    amount: { type: Number, required: true },
    platformFee: { type: Number, default: 0 },
    sellerAmount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'held', 'released', 'refunded', 'failed'],
        default: 'pending'
    },
    orderStatus: {
        type: String,
        enum: ['created', 'payment_pending', 'payment_received', 'processing', 'shipped', 'delivered', 'confirmed', 'disputed', 'cancelled', 'refunded', 'seller_rejected'],
        default: 'created'
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    phonePeMerchantTransactionId: String,
    phonePeTransactionId: String,
    cashfreeOrderId: String,      // Cashfree order ID (CF-xxx) stored for webhook lookup
    cashfreePaymentId: String,    // Cashfree cf_payment_id populated after payment
    refundId: String,             // Cashfree refund ID once a refund is initiated
    shippingAddress: ShippingAddressSchema,
    shippingInfo: ShippingInfoSchema,
    buyerProof: BuyerProofSchema,
    dispute: DisputeSchema,
    sellerResponse: SellerResponseSchema,
    statusHistory: [{
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String
    }],
    deliveryConfirmedAt: Date,
    paymentReleasedAt: Date,
    buyerRating: { type: Number, min: 1, max: 5 },
    buyerReview: String,
    sellerRating: { type: Number, min: 1, max: 5 },
    sellerReview: String,
    isShareableOrder: { type: Boolean, default: false } // Created via shareable payment link
}, { timestamps: true });

OrderSchema.pre('save', function(next) {
    if (this.isModified('orderStatus') || this.isModified('paymentStatus')) {
        this.statusHistory.push({
            status: `${this.orderStatus} - ${this.paymentStatus}`,
            timestamp: new Date()
        });
    }
    next();
});

OrderSchema.index({ buyerId: 1, createdAt: -1 });
OrderSchema.index({ sellerId: 1, createdAt: -1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ phonePeMerchantTransactionId: 1 }); // fast webhook lookup
OrderSchema.index({ cashfreeOrderId: 1 });              // fast Cashfree webhook lookup

export default mongoose.model('Order', OrderSchema);
