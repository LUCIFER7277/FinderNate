import mongoose from 'mongoose';

const EventSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: String,
    date: {
        type: Date,
        required: true
    },
    location: String,
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    media: [String], // Optional: image or flyer
    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    tags: [String],
    isOnline: { type: Boolean, default: false },
    eventUrl: String, // if online
    capacity: Number,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('Event', EventSchema);
