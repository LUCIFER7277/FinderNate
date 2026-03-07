import mongoose from 'mongoose';
import { ISearchHistory } from '../types/searchHistory.types.js';

const SearchHistorySchema = new mongoose.Schema<ISearchHistory>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    keyword: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    searchedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Optional: Prevent same keyword for same user within 24h
SearchHistorySchema.index({ userId: 1, keyword: 1, searchedAt: 1 });

export default mongoose.model('SearchHistory', SearchHistorySchema);
