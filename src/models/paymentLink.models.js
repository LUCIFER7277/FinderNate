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
    shortUrl: String
}, { timestamps: true });

PaymentLinkSchema.index({ sellerId: 1 });
PaymentLinkSchema.index({ buyerId: 1 });
PaymentLinkSchema.index({ status: 1 });

export default mongoose.model('PaymentLink', PaymentLinkSchema);
