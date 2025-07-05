import mongoose from 'mongoose';

const ReelSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    videoUrl: {
        type: String,
        required: true
    },
    caption: {
        type: String,
        trim: true
    },
    thumbnailUrl: {
        type: String // Optional: for faster previews
    },
    hashtags: [{
        type: String
    }],
    music: {
        title: String,
        url: String
    },
    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    comments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment'
    }],
    views: {
        type: Number,
        default: 0
    },
    isPublic: {
        type: Boolean,
        default: true
    },
    isFeatured: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

export default mongoose.model('Reel', ReelSchema);
