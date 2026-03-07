import mongoose from "mongoose";
import { IPushSubscription } from '../types/pushSubscription.types.js';

const pushSubscriptionSchema = new mongoose.Schema<IPushSubscription>({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  endpoint: {
    type: String,
    required: true
  },
  p256dh: {
    type: String,
    required: true
  },
  auth: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index to ensure one subscription per user per endpoint
pushSubscriptionSchema.index({ userId: 1, endpoint: 1 }, { unique: true });

// Index for faster queries when sending notifications
pushSubscriptionSchema.index({ userId: 1, isActive: 1 });

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

export default PushSubscription;