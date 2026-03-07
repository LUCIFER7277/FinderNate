import mongoose from 'mongoose';
import { IFeedback } from '../types/feedback.types.js';

const FeedbackSchema = new mongoose.Schema<IFeedback>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    submittedAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: true
});

// Index for better query performance
FeedbackSchema.index({ submittedAt: -1 });

const Feedback = mongoose.model('Feedback', FeedbackSchema);
export default Feedback;
