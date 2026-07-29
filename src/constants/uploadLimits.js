/**
 * Every upload ceiling in the system, and the wording users see when they hit
 * one.
 *
 * These lived in three places before — the multer config, the media upload
 * controller and the chat controller — and had already drifted: the multi-file
 * media route rejected at a flat 50 MB whatever the type, while the
 * single-file route on the same controller used a per-type map. Keeping the
 * numbers and the messages together is the point of this file; a limit that
 * changes here changes everywhere, including in what the user is told.
 *
 * On the message wording: "File too large" (multer's own text) tells someone
 * nothing they can act on. Every message below names the actual file size, the
 * ceiling it crossed, and a way forward.
 */

/**
 * Hard ceiling enforced by multer, before any controller sees the file.
 * Must be >= the largest per-type limit below, or that limit is unreachable.
 *
 * NOTE: multer uses memoryStorage, so a file this size sits in the Node
 * process for the duration of the upload. Raising this raises peak RSS
 * proportionally, and the post routes accept several videos per request.
 */
export const MAX_UPLOAD_MB = 600;

/** Posts, reels, stories — the main media pipeline. */
export const POST_MEDIA_LIMITS_MB = {
    image: 10,
    video: 600,
    audio: 6,
    file: 7,
};

/**
 * Chat attachments. Video is deliberately lower than the post limit: a chat
 * video is delivered to a conversation, not to a feed, and the message below
 * points people at posts when they need the bigger ceiling.
 */
export const CHAT_MEDIA_LIMITS_MB = {
    image: 10,
    video: 200,
    audio: 6,
    file: 7,
};

/**
 * How many of each a single post may carry.
 *
 * One video, deliberately. A carousel of ten 600 MB videos is several GB held
 * in memory for one request (multer buffers to RAM), and nothing in the
 * product shows more than one video per post anyway. Images stay at ten.
 */
export const MAX_VIDEOS_PER_POST = 1;
export const MAX_IMAGES_PER_POST = 10;

/**
 * Images allowed alongside a video. Ten media in total either way: ten images
 * on their own, or one video plus nine.
 *
 * This is also what bounds request memory. Multer buffers uploads in RAM, so
 * the worst case per request is now one video plus nine images — roughly
 * 700 MB — rather than the several GB a carousel of videos would have held.
 */
export const MAX_IMAGES_WITH_VIDEO = 9;
export const MAX_MEDIA_PER_POST = 10;

/**
 * A video at or under this length can appear in Vibes. Longer clips still post
 * fine, they just stay in the feed rather than the reel scroller — a
 * five-minute video in a swipe-up feed is not what anyone is there for.
 */
export const REEL_MAX_DURATION_SECONDS = 60;

/** Human-readable size — "812.4 MB", "1.2 GB". */
export const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
};

// Phone video at 1080p30 runs to roughly this much per minute. Only used to
// turn a byte ceiling into a duration people can picture.
const MB_PER_MINUTE_1080P = 120;

// What to actually do about it, per type. Concrete advice beats "try a smaller
// file" — most people do not know that resolution is the lever. The video line
// is built from the limit in play rather than a fixed number, so the chat
// ceiling does not end up quoting the (larger) post one back at the user.
const adviceFor = (category, limitMB) => {
    if (category === 'video') {
        const minutes = Math.max(1, Math.round(limitMB / MB_PER_MINUTE_1080P));
        return `Trim the clip or export it at a lower resolution — 1080p is plenty, and ${limitMB} MB is about ${minutes} minute${minutes === 1 ? '' : 's'} of 1080p video.`;
    }
    return {
        image: 'Export at a lower quality, or resize it before uploading.',
        audio: 'Trim the recording, or export it as MP3 instead of WAV.',
        file: 'Compress the document, or split it into smaller parts.',
    }[category];
};

/**
 * The message shown when a file exceeds its per-type limit.
 *
 * @param {object}  opts
 * @param {string}  opts.category    'image' | 'video' | 'audio' | 'file'
 * @param {number}  opts.actualBytes size of the rejected file
 * @param {number}  opts.limitMB     ceiling it crossed
 * @param {string} [opts.alternative] extra route out, e.g. posting instead of chatting
 */
export const tooLargeMessage = ({ category, actualBytes, limitMB, alternative }) => {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    const parts = [
        `${label} is too large. This file is ${formatBytes(actualBytes)}, and the maximum allowed is ${limitMB} MB.`,
    ];
    if (alternative) parts.push(alternative);
    const advice = adviceFor(category, limitMB);
    if (advice) parts.push(advice);
    return parts.join(' ');
};

/**
 * The message for multer's own LIMIT_FILE_SIZE, which fires while the request
 * is still streaming in — before any controller runs, so the file's category
 * and true size are not yet known. Only the hard ceiling can be quoted here.
 */
export const overallTooLargeMessage = (field) =>
    `That file is larger than the ${MAX_UPLOAD_MB} MB upload limit${field ? ` (field "${field}")` : ''}. ` +
    `The upload was stopped partway, so nothing was saved. ` +
    `For video, trim the clip or export it at a lower resolution — ${MAX_UPLOAD_MB} MB is roughly 5 minutes of 1080p. ` +
    `Images, audio and documents have much smaller limits than this.`;
