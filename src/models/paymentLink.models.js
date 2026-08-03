import mongoose from "mongoose";

const PaymentLinkSchema = new mongoose.Schema({
    linkId: { type: String, required: true, unique: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    productDetails: {
        name: { type: String, required: true },
        description: String,
        price: { type: Number, required: true },
        images: [String],
        category: String
    },
    amount: { type: Number, required: true },
    shippingCharges: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    status: {
        type: String,
        enum: ['active', 'paid', 'expired', 'cancelled'],
        default: 'active'
    },
    expiresAt: { type: Date },
    paidAt: Date,
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    paymentUrl: String,
    shortUrl: String,
    isShareableLink: { type: Boolean, default: false },
    // WHICH CHECKOUT MINTED THIS LINK — and therefore which of the two
    // server-computed totals its `paymentUrl` was written at. The online store
    // waives shipping at ≥ ₹499 and the shareable payment link never does, so
    // the same post has two legitimate totals and a link is only payable at its
    // own one. Without this the store minted /post/:postId/pay/<store total> and
    // the pay endpoint, which validates against the shareable total, rejected it
    // forever with "price mismatch … please reload".
    //
    // DELIBERATELY HAS NO DEFAULT. A link written before this field existed must
    // read as "unknown" so the flow can be inferred from the amount it was
    // actually minted at; a default of 'shareable_link' would assert something
    // untrue about every legacy store link and re-break exactly those URLs.
    pricingFlow: {
        type: String,
        enum: ['shareable_link', 'online_store']
    }
}, { timestamps: true });

PaymentLinkSchema.index({ sellerId: 1 });
PaymentLinkSchema.index({ buyerId: 1 });
PaymentLinkSchema.index({ status: 1 });
PaymentLinkSchema.index({ postId: 1, amount: 1, isShareableLink: 1 });

export default mongoose.model('PaymentLink', PaymentLinkSchema);
