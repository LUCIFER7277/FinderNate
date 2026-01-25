import mongoose from 'mongoose';

const BadgeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    iconUrl: {
        type: String,
        required: true
    },
    description: String,
    criteria: {
        type: String, // e.g. "1000 followers", "verified", "top creator"
        default: ""
    },
    type: {
        type: String,
        enum: ['system', 'earned', 'custom'],
        default: 'earned'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('Badge', BadgeSchema);
