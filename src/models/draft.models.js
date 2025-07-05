import mongoose from 'mongoose';

const DraftSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['Post', 'Reel', 'Story'],
        required: true
    },
    content: {
        type: String,
        trim: true
    },
    media: [{
        url: String,
        type: { type: String, enum: ['image', 'video'] }
    }],
    taggedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    location: String,
    tags: [String],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: Date,
    isAutoSaved: {
        type: Boolean,
        default: false
    }
});

export default mongoose.model('Draft', DraftSchema);
