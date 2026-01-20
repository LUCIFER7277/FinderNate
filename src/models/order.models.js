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
    reason: String,
    description: String,
    evidence: [String],
    status: { type: String, enum: ['open', 'under_review', 'resolved', 'rejected'], default: 'open' },
    resolution: String,
    createdAt: { type: Date, default: Date.now },
    resolvedAt: Date
}, { _id: false });

const OrderSchema = new mongoose.Schema({
    orderNumber: { type: String, required: true, unique: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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
        enum: ['created', 'payment_pending', 'payment_received', 'processing', 'shipped', 'delivered', 'confirmed', 'disputed', 'cancelled', 'refunded'],
        default: 'created'
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    shippingAddress: ShippingAddressSchema,
    shippingInfo: ShippingInfoSchema,
    buyerProof: BuyerProofSchema,
    dispute: DisputeSchema,
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
    sellerReview: String
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

export default mongoose.model('Order', OrderSchema);
