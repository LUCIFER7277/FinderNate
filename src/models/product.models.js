import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true,
        index: 'text'
    },
    description: {
        type: String,
        trim: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        default: 'INR'
    },
    stock: {
        type: Number,
        default: 1,
        min: 0
    },
    category: {
        type: String,
        index: true
    },
    images: [{
        url: String,
        alt: String
    }],
    tags: [String],
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('Product', ProductSchema);
