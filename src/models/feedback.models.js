import mongoose from 'mongoose';

const FeedbackSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        trim: true,
        maxlength: 1000
    },
    rating: {
        type: Number,
        min: 1,
        max: 5
    },
    context: {
        type: String,
        enum: ['app', 'order', 'product', 'subscription', 'other'],
        default: 'app'
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    isResolved: {
        type: Boolean,
        default: false
    }
});

export default mongoose.model('Feedback', FeedbackSchema);
