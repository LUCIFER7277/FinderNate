import mongoose from "mongoose";

const PostSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    caption: { type: String },

    // 📁 Support for multiple media (images/videos)
    media: [
        {
            url: { type: String, required: true },
            type: { type: String, enum: ['image', 'video'], required: true }
        }
    ],

    // 🏷️ Hashtags
    tags: [{ type: String }],

    // 📍 Location (can be address, place name, or GPS)
    location: { type: String },

    // ❤️ Likes and 💬 Comments
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    comments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],

    // 📊 View & Share Tracking (optional)
    viewCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 }
},
    { timestamps: true } // Automatically adds createdAt and updatedAt
);

export default mongoose.model('Post', PostSchema);
