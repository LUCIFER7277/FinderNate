import mongoose from "mongoose";

// 🌐 GeoJSON for location
const GeoJSONPointSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
    },
    coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        index: '2dsphere'
    }
}, { _id: false });

// 📏 Media
const MediaDimensionsSchema = new mongoose.Schema({
    width: Number,
    height: Number
}, { _id: false });

const AdditionalMediaSchema = new mongoose.Schema({
    url: String,
    thumbnailUrl: String,
    dimensions: MediaDimensionsSchema,
    order: Number
}, { _id: false });

const MediaSchema = new mongoose.Schema({
    type: String, // "image" or "video"
    url: String,
    thumbnailUrl: String,
    duration: Number,
    dimensions: MediaDimensionsSchema,
    fileSize: Number,
    format: String,
    additionalMedia: [AdditionalMediaSchema]
}, { _id: false });

// 🛍 Product Details
const ProductVariantSchema = new mongoose.Schema({
    name: String,
    options: [String]
}, { _id: false });

const ProductSpecificationSchema = new mongoose.Schema({
    key: String,
    value: String
}, { _id: false });

const ProductDetailsSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    currency: String,
    category: String,
    subcategory: String,
    brand: String,
    sku: String,
    availability: String,
    variants: [ProductVariantSchema],
    specifications: [ProductSpecificationSchema],
    images: [String],
    tags: [String],
    weight: Number,
    dimensions: {
        length: Number,
        width: Number,
        height: Number,
        unit: String
    },
    location: {
        name: String,
        coordinates: GeoJSONPointSchema
    }
}, { _id: false });

// 💼 Service Details
const ServiceAvailabilitySchema = new mongoose.Schema({
    schedule: [{
        day: String,
        timeSlots: [{
            startTime: String,
            endTime: String
        }]
    }],
    timezone: String,
    bookingAdvance: Number,
    maxBookingsPerDay: Number
}, { _id: false });

const ServiceLocationSchema = new mongoose.Schema({
    type: String,
    address: String,
    city: String,
    state: String,
    country: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const ServiceDetailsSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    currency: String,
    category: String,
    subcategory: String,
    duration: Number,
    serviceType: String,
    availability: ServiceAvailabilitySchema,
    location: ServiceLocationSchema,
    requirements: [String],
    deliverables: [String],
    tags: [String]
}, { _id: false });

// 🏢 Business Details
const BusinessContactSchema = new mongoose.Schema({
    phone: String,
    email: String,
    website: String,
    socialMedia: [{
        platform: String,
        url: String
    }]
}, { _id: false });

const BusinessLocationSchema = new mongoose.Schema({
    address: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const BusinessHoursSchema = new mongoose.Schema({
    day: String,
    openTime: String,
    closeTime: String,
    isClosed: Boolean
}, { _id: false });

const BusinessPromotionSchema = new mongoose.Schema({
    title: String,
    description: String,
    discount: Number,
    validUntil: Date,
    isActive: Boolean
}, { _id: false });

const BusinessDetailsSchema = new mongoose.Schema({
    businessName: String,
    businessType: String,
    description: String,
    category: String,
    subcategory: String,
    contact: BusinessContactSchema,
    location: BusinessLocationSchema,
    hours: [BusinessHoursSchema],
    features: [String],
    priceRange: String,
    rating: Number,
    tags: [String],
    announcement: String,
    promotions: [BusinessPromotionSchema]
}, { _id: false });

// 🧍 Normal Post Details (with fixed GeoJSON)
const NormalLocationSchema = new mongoose.Schema({
    name: String,
    address: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const NormalDetailsSchema = new mongoose.Schema({
    mood: String,
    activity: String,
    location: NormalLocationSchema,
    tags: [String]
}, { _id: false });

// 🎨 Customization Options
const CustomizationSchema = new mongoose.Schema({
    product: ProductDetailsSchema,
    service: ServiceDetailsSchema,
    business: BusinessDetailsSchema,
    normal: NormalDetailsSchema
}, { _id: false });

// 📊 Engagement
const EngagementSchema = new mongoose.Schema({
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 }
}, { _id: false });

// ⚙️ Settings
const SettingsSchema = new mongoose.Schema({
    visibility: String,
    allowComments: Boolean,
    allowLikes: Boolean,
    allowShares: Boolean,
    allowSaves: Boolean,
    commentsFilter: String,
    hideLikeCount: Boolean,
    allowDownload: Boolean,
    customAudience: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { _id: false });

// 📈 Analytics
const AnalyticsSchema = new mongoose.Schema({
    clickThroughs: Number,
    inquiries: Number,
    conversions: Number,
    topCountries: [String],
    topAgeGroups: [String],
    genderDistribution: {
        male: Number,
        female: Number,
        other: Number
    },
    peakViewingTimes: [{
        hour: Number,
        count: Number
    }]
}, { _id: false });

// 📬 Post Schema
const PostSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postType: { type: String, required: true, enum: ['photo', 'reel'] },
    contentType: { type: String, required: true, enum: ['normal', 'product', 'service', 'business'] },
    caption: String,
    description: String,
    hashtags: [String],
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    media: [MediaSchema],
    customization: CustomizationSchema,
    engagement: EngagementSchema,
    settings: SettingsSchema,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    scheduledAt: Date,
    publishedAt: Date,
    status: String,
    isPromoted: Boolean,
    isFeatured: Boolean,
    isReported: Boolean,
    reportCount: Number,
    analytics: AnalyticsSchema
});

// 🏷 Auto-extract hashtags
function extractHashtags(text) {
    const regex = /#(\w+)/g;
    const tags = new Set();
    let match;
    while ((match = regex.exec(text))) {
        tags.add(match[1].toLowerCase());
    }
    return [...tags];
}

// 🪝 Pre-save hook for hashtags
PostSchema.pre('save', function (next) {
    const captionHashtags = extractHashtags(this.caption || '');
    const descriptionHashtags = extractHashtags(this.description || '');
    const combinedHashtags = new Set([...captionHashtags, ...descriptionHashtags]);
    this.hashtags = [...combinedHashtags];
    next();
});

export default mongoose.model('Post', PostSchema);
