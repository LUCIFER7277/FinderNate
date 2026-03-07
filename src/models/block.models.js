import mongoose from 'mongoose';
import { IBlock } from '../types/block.types.js';

const BlockSchema = new mongoose.Schema<IBlock>({
    blockerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    blockedId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    reason: {
        type: String,
        trim: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// 🛡 Prevent duplicate block records
BlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

export default mongoose.model('Block', BlockSchema);
