import mongoose from 'mongoose';
import { IApiKey } from '../types/apikey.types.js';

const ApiKeySchema = new mongoose.Schema<IApiKey>({
    key: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    label: {
        type: String,
        trim: true // optional: helps identify purpose (e.g., "PostBot", "ZapierSync")
    },
    permissions: {
        type: [String], // e.g., ['read:posts', 'write:comments']
        default: ['read:*']
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: Date,
    lastUsedAt: Date,
    isActive: {
        type: Boolean,
        default: true
    },
    usageCount: {
        type: Number,
        default: 0
    }
});

export default mongoose.model('ApiKey', ApiKeySchema);
