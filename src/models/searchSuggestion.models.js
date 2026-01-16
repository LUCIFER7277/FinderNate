import mongoose from 'mongoose';

const SearchSuggestionSchema = new mongoose.Schema({
    keyword: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        unique: true,
        minlength: 2,
        maxlength: 100
    },
    searchCount: {
        type: Number,
        default: 1,
        min: 1
    },
    lastSearched: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for search count (for ordering suggestions)
SearchSuggestionSchema.index({ searchCount: -1 });
// Text index for keyword search (separate from unique index)
SearchSuggestionSchema.index({ keyword: 'text' });

export default mongoose.model('SearchSuggestion', SearchSuggestionSchema);