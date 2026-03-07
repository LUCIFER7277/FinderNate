import mongoose from 'mongoose';
import { IFollowRequest } from '../types/followRequest.types.js';

const FollowRequestSchema = new mongoose.Schema<IFollowRequest>({
    requesterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    }
}, { timestamps: true });

// Prevent duplicate follow requests
FollowRequestSchema.index({ requesterId: 1, recipientId: 1 }, { unique: true });

export default mongoose.model('FollowRequest', FollowRequestSchema);