import mongoose from 'mongoose';
import { IBusinessRating } from '../types/businessRating.types.js';

const BusinessRatingSchema = new mongoose.Schema<IBusinessRating>({
    businessId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Business',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    rating: {
        type: Number,
        required: true,
        min: 1,
        max: 5
    }
}, {
    timestamps: true
});

// Compound index to ensure one rating per user per business
BusinessRatingSchema.index({ businessId: 1, userId: 1 }, { unique: true });

// Index for efficient querying of business ratings
BusinessRatingSchema.index({ businessId: 1, rating: 1 });

export default mongoose.model('BusinessRating', BusinessRatingSchema);
