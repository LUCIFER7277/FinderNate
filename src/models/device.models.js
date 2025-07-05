import mongoose from 'mongoose';

const DeviceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    deviceId: {
        type: String,
        required: true,
        index: true
    },
    deviceType: {
        type: String,
        enum: ['web', 'android', 'ios', 'other'],
        default: 'other'
    },
    browser: String,
    os: String,
    ipAddress: String,
    lastUsedAt: {
        type: Date,
        default: Date.now
    },
    isLoggedIn: {
        type: Boolean,
        default: true
    }
});

export default mongoose.model('Device', DeviceSchema);
