import mongoose from 'mongoose';

const AdvertisementSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    mediaUrl: {
        type: String,
        required: true
    },
    caption: {
        type: String,
        trim: true
    },
    link: {
        type: String,
        required: true
    },
    budget: {
        type: Number,
        required: true
    },
    costPerClick: {
        type: Number,
        default: 0.5 // Default CPC (can be updated)
    },
    costPerImpression: {
        type: Number,
        default: 0.01
    },
    impressions: {
        type: Number,
        default: 0
    },
    clicks: {
        type: Number,
        default: 0
    },
    targetAudience: {
        gender: { type: String, enum: ['male', 'female', 'any'], default: 'any' },
        ageRange: { type: [Number], default: [18, 65] },
        locations: [{ type: String }]
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'running', 'paused', 'completed'],
        default: 'pending'
    }
}, { timestamps: true });

export default mongoose.model('Advertisement', AdvertisementSchema);
