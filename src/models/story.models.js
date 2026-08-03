import mongoose from 'mongoose';

const StorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    mediaUrl: {
        type: String,
        required: true
    },
    mediaType: {
        type: String,
        enum: ['image', 'video'],
        default: 'image'
    },
    caption: {
        type: String,
        trim: true
    },
    viewers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    isArchived: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        required: true
    }
}, { timestamps: true });

// Auto-expire stories after 24 hours.
//
// The comment here used to say this happened "in code logic, not schema
// itself", but no such code ever existed: nothing swept expired stories, so the
// collection grew forever and every stories-tray load scanned all of it to find
// the handful still live. MongoDB does the sweep now — expireAfterSeconds: 0
// means "delete once the date in expiresAt has passed", which is exactly the
// 24-hour window createStory sets.
//
// Archived stories are exempt via the partial filter: fetchArchivedStories
// reads { userId, isArchived: true } long after expiresAt has gone by, and a
// blanket TTL would delete the archive out from under it. Nothing else can
// reach an expired story — every other read path filters expiresAt: { $gt: now }
// — so this only removes documents that were already unreachable.
StorySchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { isArchived: false } }
);

// The stories tray (story.controllers fetchAllStories) and the profile stories
// tab both filter { isArchived: false, expiresAt: { $gt: now } }; neither field
// was indexed, so both were collection scans.
StorySchema.index({ isArchived: 1, expiresAt: 1 });

// Archive screen and per-user story lookups: { userId, isArchived } sorted by
// createdAt desc.
StorySchema.index({ userId: 1, isArchived: 1, createdAt: -1 });

export default mongoose.model('Story', StorySchema);
