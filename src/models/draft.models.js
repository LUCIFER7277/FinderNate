import mongoose from 'mongoose';
import { IDraft } from '../types/draft.types.js';

const DraftSchema = new mongoose.Schema<IDraft>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['Post', 'Reel', 'Story', 'Tweet'],
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
