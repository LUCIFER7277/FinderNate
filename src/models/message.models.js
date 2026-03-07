import mongoose from 'mongoose';
import { IMessage } from '../types/message.types.js';

const MessageSchema = new mongoose.Schema<IMessage>({
    chatId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chat',
        required: true,
        index: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true
    },
    messageType: {
        type: String,
        enum: ['text', 'image', 'video', 'file', 'audio', 'location', 'payment_link', 'checkout', 'order_update'],
        default: 'text'
    },
    mediaUrl: String,
    fileName: String,
    fileSize: Number,
    duration: Number, // for audio/video
    location: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    readBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    deliveryStatus: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        status: {
            type: String,
            enum: ['sent', 'delivered', 'seen'],
            default: 'sent'
        },
        deliveredAt: Date,
        seenAt: Date
    }],
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedAt: Date,
    deletedFor: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        deletedAt: {
            type: Date,
            default: Date.now
        }
    }],
    deletedForEveryone: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedForEveryoneAt: Date,
    editedAt: Date,
    originalMessage: String, // Store original message for potential restoration
    reactions: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        emoji: String,
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    // 🏷️ Product/Business reference for contact-initiated chats
    productReference: {
        postId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Post'
        },
        businessId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Business'
        },
        productName: String,
        productImage: String,
        productPrice: Number,
        productType: {
            type: String,
            enum: ['product', 'service', 'business']
        },
        productDescription: String,
        location: String
    },
    // 📤 Forwarding support
    forwardedFrom: {
        messageId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Message'
        },
        chatId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Chat'
        },
        originalSender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }
    },
    isForwarded: {
        type: Boolean,
        default: false,
        index: true
    },
    // 📌 Pinning support
    isPinned: {
        type: Boolean,
        default: false,
        index: true
    },
    pinnedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    pinnedAt: Date,
    // ✏️ Editing support
    isEdited: {
        type: Boolean,
        default: false
    },
    originalContent: String, // Original content before edit
    // 🎤 Voice message metadata
    waveform: [Number], // For voice message visualization
    // 🔗 Link preview cache
    linkPreview: {
        url: String,
        title: String,
        description: String,
        image: String,
        siteName: String,
        fetchedAt: Date
    },
    // 🛒 Checkout details for in-chat checkout messages
    checkoutDetails: {
        postId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Post'
        },
        productName: String,
        productDescription: String,
        productImages: [String],
        productCategory: String,
        productType: {
            type: String,
            enum: ['product', 'service']
        },
        specifications: [{
            key: String,
            value: String
        }],
        variants: [{
            name: String,
            options: [String]
        }],
        deliveryOptions: String,
        sellerLocation: String,
        // Price breakdown
        basePrice: Number,
        shippingCharges: Number,
        gstPercent: Number,
        gstAmount: Number,
        totalPrice: Number,
        currency: {
            type: String,
            default: 'INR'
        },
        // Seller info
        sellerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        sellerName: String,
        sellerUsername: String,
        sellerAvatar: String,
        // Payment link reference
        paymentLinkId: String,
        paymentUrl: String,
        // Status tracking
        checkoutStatus: {
            type: String,
            enum: ['pending', 'paid', 'expired'],
            default: 'pending'
        },
        expiresAt: Date
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Compound indexes for optimal query performance
MessageSchema.index({ chatId: 1, timestamp: -1 }); // For message fetching
MessageSchema.index({ chatId: 1, isDeleted: 1, timestamp: -1 }); // For non-deleted messages
MessageSchema.index({ chatId: 1, isDeleted: 1, readBy: 1 }); // For unread count queries
MessageSchema.index({ sender: 1, timestamp: -1 }); // For user's sent messages
MessageSchema.index({ chatId: 1, 'deliveryStatus.userId': 1, 'deliveryStatus.status': 1 }); // For delivery status queries
MessageSchema.index({ chatId: 1, deletedForEveryone: 1 }); // For deleted messages filtering
MessageSchema.index({ chatId: 1, isPinned: 1, pinnedAt: -1 }); // For pinned messages queries
MessageSchema.index({ chatId: 1, isForwarded: 1 }); // For forwarded messages queries

// Virtual for unread status (per user)
MessageSchema.virtual('isUnread').get(function () {
    // This would be calculated per user in queries
    return false;
});

export default mongoose.model('Message', MessageSchema); 