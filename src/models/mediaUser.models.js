import mongoose from 'mongoose';

const MediaSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['image', 'video'],
        required: true
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    targetType: {
        type: String,
        required: true,
        enum: ['Post', 'Reel', 'Story', 'Advertisement']
    },
    thumbnailUrl: String, // For video preview
    metadata: {
        width: Number,
        height: Number,
        duration: Number, // For video
        sizeInBytes: Number
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { timestamps: true });

// Optional: fast lookup for media tied to a specific object
MediaSchema.index({ targetId: 1, targetType: 1 });

export default mongoose.model('Media', MediaSchema);
