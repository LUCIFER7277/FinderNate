import mongoose from 'mongoose';

const HashtagSchema = new mongoose.Schema({
    tag: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,  // Normalize tags like #Travel and #travel
        trim: true
    },
    posts: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post'
    }],
    usageCount: {
        type: Number,
        default: 0
    },
    lastUsedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// 🔍 Index for fast hashtag search
//
// Intentionally NOT re-declared here. The `unique: true` on the `tag` field
// above already builds exactly this index ({ tag: 1 }, auto-named "tag_1"),
// so an explicit HashtagSchema.index({ tag: 1 }) declared the same key a
// second time with different options (unique vs non-unique). Both resolve to
// the same auto-generated name, so on startup Mongoose issued two createIndex
// calls for "tag_1" and MongoDB rejected the second with IndexOptionsConflict
// (code 85). Lookups on `tag` are still fully indexed by the unique index.

export default mongoose.model('Hashtag', HashtagSchema);
