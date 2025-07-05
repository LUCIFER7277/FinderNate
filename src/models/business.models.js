import mongoose from 'mongoose';

const BusinessSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true, // Ensure one business profile per user
        index: true
    },
    businessName: {
        type: String,
        required: true,
        trim: true
    },
    category: {
        type: String,
        required: true
    },
    contactEmail: {
        type: String,
        required: true,
        lowercase: true
    },
    contactPhone: {
        type: String
    },
    website: {
        type: String
    },
    address: {
        type: String
    },
    gstNumber: {
        type: String,
        unique: true,
        sparse: true // Allows nulls to not trigger uniqueness errors
    },
    panNumber: {
        type: String,
        unique: true,
        sparse: true
    },
    logoUrl: {
        type: String
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    followers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    insights: {
        views: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        conversions: { type: Number, default: 0 }
    }
}, { timestamps: true });

export default mongoose.model('Business', BusinessSchema);
