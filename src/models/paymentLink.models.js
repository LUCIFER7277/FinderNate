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
    // WHAT KIND OF CONTENT THIS LINK POINTED AT — 'product' | 'service' |
    // 'business' | 'normal', copied off the Post at mint time.
    //
    // It exists for one reason: a deleted post takes its own type with it, and
    // the tombstone the checkout endpoints answer with
    // (utils/contentTombstone.utils.js) then had nothing left to name, so every
    // PaymentLink-backed deletion degraded to "This item was deleted by the
    // owner." Mint time is the last moment the type is knowable.
    //
    // OPTIONAL, AND DELIBERATELY WITHOUT AN ENUM. Links minted before this
    // field existed carry nothing here and fall back to the neutral wording;
    // the read endpoints back-fill one whenever they resolve a link whose post
    // is still alive. An enum would tie a money path to Post.contentType's own
    // list — widen that list and every link mint for the new type would throw —
    // and the tombstone helper already normalises anything it does not know.
    contentType: { type: String },
    amount: { type: Number, required: true },
    // REMOVED FIELD — `sellerSetAmount` is deliberately NOT declared here.
    //
    // It briefly marked a link whose `amount` the seller had chosen themselves
    // (a discount on their own listing). That feature was removed: links are now
    // always minted at the listing's own total and the charge is always
    // recomputed from the Post, so no seller-chosen figure exists to record.
    //
    // Rows minted while it existed still carry the field in MongoDB. Nothing
    // charges from it any more, but resolveLinkPricingFlow still READS it off
    // the raw document (payments.controllers.js) so those legacy links are not
    // mistaken for online-store mints and handed the store's shipping waiver.
    // Do not re-add it to the schema and do not backfill it — leaving it
    // undeclared is what keeps it read-only.
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
