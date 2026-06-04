import mongoose from 'mongoose';

const ContactRequestSchema = new mongoose.Schema({
    requester: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Business',
        required: true,
        index: true
    },
    businessOwner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'denied'],
        default: 'pending',
        index: true
    },
    message: {
        type: String,
        trim: true,
        maxlength: 500
    },
    responseMessage: {
        type: String,
        trim: true,
        maxlength: 500
    },
    respondedAt: {
        type: Date
    }
}, { timestamps: true });

// Compound index to prevent duplicate requests from same user to same business
ContactRequestSchema.index({ requester: 1, business: 1 }, { unique: true });

// Index for business owner to quickly find their requests
ContactRequestSchema.index({ businessOwner: 1, status: 1 });

export default mongoose.model('ContactRequest', ContactRequestSchema);