import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

const BUNNY_CONFIG = {
    storageZoneName: process.env.BUNNY_STORAGE_ZONE_NAME,
    accessKey: process.env.BUNNY_ACCESS_KEY,
    storageApiUrl: process.env.BUNNY_STORAGE_API_URL,
    cdnUrl: process.env.BUNNY_CDN_URL,
};

const validateConfig = () => {
    const required = ['storageZoneName', 'accessKey', 'storageApiUrl', 'cdnUrl'];
    const missing = required.filter(key => !BUNNY_CONFIG[key]);
    if (missing.length > 0) {
        throw new Error(`Missing Bunny.net configuration: ${missing.join(', ')}`);
    }
};

// ── Bunny Stream (video only) ────────────────────────────────────────────────
// Storage serves whatever bytes were uploaded: a phone's 10 MB clip is stored
// and delivered at 10 MB to every viewer, and the "?thumbnail=1" URL this file
// used to build was never honoured (the Optimizer is off), so it returned the
// MP4 itself — several MB downloaded to render a thumbnail that then failed to
// decode. Stream transcodes to a resolution ladder and produces a real
// thumbnail, and its encoding is free.
//
// Every field below must be set or video keeps going to Storage exactly as
// before, so this can be deployed before the credentials exist.
const STREAM_CONFIG = {
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
    apiKey: process.env.BUNNY_STREAM_API_KEY,
    cdnHost: process.env.BUNNY_STREAM_CDN_HOST,
};

const STREAM_API = 'https://video.bunnycdn.com/library';

/** Default rendition stored in the DB. Clients rewrite it per connection. */
export const STREAM_DEFAULT_RENDITION = '720p';

export const isStreamEnabled = () =>
    Boolean(STREAM_CONFIG.libraryId && STREAM_CONFIG.apiKey && STREAM_CONFIG.cdnHost);

/** Playback URL for a Stream video. Progressive MP4, deliberately not HLS. */
export const streamVideoUrl = (guid, rendition = STREAM_DEFAULT_RENDITION) =>
    `https://${STREAM_CONFIG.cdnHost}/${guid}/play_${rendition}.mp4`;

export const streamThumbnailUrl = (guid) =>
    `https://${STREAM_CONFIG.cdnHost}/${guid}/thumbnail.jpg`;

/** Adaptive playlist. Kept for long-form playback; the feeds do not use it. */
export const streamHlsUrl = (guid) =>
    `https://${STREAM_CONFIG.cdnHost}/${guid}/playlist.m3u8`;

/** True for a URL this module produced via Stream. */
export const isStreamUrl = (url) =>
    Boolean(url && STREAM_CONFIG.cdnHost && url.includes(STREAM_CONFIG.cdnHost));

/**
 * Fetches a Stream video's metadata. Called from the encoding webhook, which
 * is the first moment `availableResolutions` is known.
 */
export const getStreamVideo = async (guid) => {
    const { libraryId, apiKey } = STREAM_CONFIG;
    const { data } = await axios.get(`${STREAM_API}/${libraryId}/videos/${guid}`, {
        headers: { AccessKey: apiKey },
    });
    return data;
};

/**
 * Best rendition actually present for a video.
 *
 * Bunny never upscales: a 360p source produces only a 360p MP4, so the 720p
 * URL stored at upload time would 404 forever. `availableResolutions` comes
 * back as "360p,480p"; this picks the highest at or below [ceiling].
 */
export const bestAvailableRendition = (availableResolutions, ceiling = STREAM_DEFAULT_RENDITION) => {
    const ladder = ['240p', '360p', '480p', '720p', '1080p'];
    const have = String(availableResolutions || '')
        .split(',')
        .map((r) => r.trim())
        .filter((r) => ladder.includes(r));
    if (have.length === 0) return null;

    const cap = ladder.indexOf(ceiling);
    const withinCap = have.filter((r) => ladder.indexOf(r) <= cap);
    const pool = withinCap.length ? withinCap : have; // else the smallest we have
    return pool.sort((a, b) => ladder.indexOf(b) - ladder.indexOf(a))[0];
};

/** The video's GUID is the first path segment of any Stream URL. */
export const streamGuidFromUrl = (url) => {
    try {
        return new URL(url).pathname.split('/').filter(Boolean)[0] || null;
    } catch {
        return null;
    }
};

/**
 * Uploads a video to Bunny Stream. Two calls: create the record, then PUT the
 * bytes into it.
 *
 * Encoding is asynchronous — the GUID and both URLs are valid immediately, but
 * the file is not playable for roughly 10-30s for a short clip. Callers mark
 * the media as still processing; see the `processing` flag on post media.
 */
const uploadVideoToStream = async (fileBuffer, originalName) => {
    const { libraryId, apiKey } = STREAM_CONFIG;
    const base = `${STREAM_API}/${libraryId}/videos`;

    const created = await axios.post(
        base,
        { title: originalName || `video-${Date.now()}` },
        { headers: { AccessKey: apiKey, 'Content-Type': 'application/json' } }
    );

    const guid = created.data?.guid;
    if (!guid) throw new Error('Bunny Stream did not return a video guid');

    await axios.put(`${base}/${guid}`, fileBuffer, {
        headers: { AccessKey: apiKey, 'Content-Type': 'application/octet-stream' },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    const url = streamVideoUrl(guid);
    return {
        success: true,
        secure_url: url,
        url,
        public_id: guid,
        resource_type: 'video',
        // A real frame from the video, not the MP4 wearing a query string.
        thumbnailUrl: streamThumbnailUrl(guid),
        hlsUrl: streamHlsUrl(guid),
        format: 'mp4',
        bytes: fileBuffer.length,
        // Renditions are still encoding at this point; nothing may play yet.
        processing: true,
    };
};

// ── Original extension map (unchanged) ──────────────────────────────────────
const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/avi': 'avi',
    'video/quicktime': 'mov', 'video/x-ms-wmv': 'wmv', 'video/x-flv': 'flv',
    // Audio
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'webm',
    // Documents
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar',
};

const generateFilePath = (folder = "posts", originalName = null, fileType = null) => {
    const timestamp = Date.now();
    const uuid = uuidv4();
    let extension = 'jpg'; // original default

    if (originalName) {
        extension = originalName.split('.').pop();
    } else if (fileType) {
        extension = MIME_TO_EXT[fileType.mimeType] || 'bin';
    }

    return `${folder}/${timestamp}-${uuid}.${extension}`;
};

// ── ORIGINAL getFileType — unchanged for image/video detection ───────────────
const getFileType = (buffer, originalName = null) => {
    // AVIF is ISO-BMFF ('....ftypavif'), which would otherwise satisfy the
    // video/mp4 signature below — so the brand check must come FIRST.
    if (buffer.length >= 12 &&
        buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        const brand = buffer.toString('ascii', 8, 12);
        if (brand === 'avif' || brand === 'avis') {
            return { mimeType: 'image/avif', isVideo: false, isImage: true, isAudio: false, isDocument: false };
        }
    }

    // RIFF containers (WebP, WAV, AVI) share the same first four bytes — the
    // subtype at offset 8 disambiguates them. Without this, WAV audio would
    // match the image/webp signature below and be stored as an "image".
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        const riffType = buffer.toString('ascii', 8, 12);
        if (riffType === 'WEBP') {
            return { mimeType: 'image/webp', isVideo: false, isImage: true, isAudio: false, isDocument: false };
        }
        if (riffType === 'WAVE') {
            return { mimeType: 'audio/wav', isVideo: false, isImage: false, isAudio: true, isDocument: false };
        }
        if (riffType === 'AVI ') {
            return { mimeType: 'video/avi', isVideo: true, isImage: false, isAudio: false, isDocument: false };
        }
    }

    // Original magic bytes (EXACTLY as they were before any changes)
    const signatures = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png':  [0x89, 0x50, 0x4E, 0x47],
        'image/gif':  [0x47, 0x49, 0x46],
        'image/webp': [0x52, 0x49, 0x46, 0x46],
        'video/mp4':  [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70],
        'video/webm': [0x1A, 0x45, 0xDF, 0xA3],
        'video/avi':  [0x52, 0x49, 0x46, 0x46],
    };

    for (const [mimeType, signature] of Object.entries(signatures)) {
        if (signature.every((byte, index) => byte === null || buffer[index] === byte)) {
            return {
                mimeType,
                isVideo: mimeType.startsWith('video/'),
                isImage: mimeType.startsWith('image/'),
                isAudio: false,
                isDocument: false,
            };
        }
    }

    // Original extension fallback (EXACTLY as before)
    if (originalName) {
        const ext = originalName.toLowerCase().split('.').pop();
        const extMap = {
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
            'gif': 'image/gif', 'webp': 'image/webp', 'avif': 'image/avif',
            'mp4': 'video/mp4', 'webm': 'video/webm', 'avi': 'video/avi',
            'mov': 'video/quicktime', 'wmv': 'video/x-ms-wmv', 'flv': 'video/x-flv',
        };
        const mimeType = extMap[ext];
        if (mimeType) {
            return {
                mimeType,
                isVideo: mimeType.startsWith('video/'),
                isImage: mimeType.startsWith('image/'),
                isAudio: false,
                isDocument: false,
            };
        }
    }

    return { mimeType: 'application/octet-stream', isVideo: false, isImage: false, isAudio: false, isDocument: false };
};

// ── New: type from explicit MIME hint (audio / documents only) ───────────────
const getFileTypeFromHint = (mimeType) => ({
    mimeType,
    isVideo:    mimeType.startsWith('video/'),
    isImage:    mimeType.startsWith('image/'),
    isAudio:    mimeType.startsWith('audio/'),
    isDocument: mimeType.startsWith('application/') || mimeType.startsWith('text/'),
});

// ── Web image optimization: convert to AVIF before storage ───────────────────
// Source formats we re-encode. GIF is excluded (animation would be flattened),
// AVIF is excluded (already converted), SVG never reaches here (no signature).
const AVIF_CONVERTIBLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Folders whose files must stay byte-identical originals (KYC/legal docs).
const AVIF_SKIP_FOLDERS = new Set(['documents']);

const AVIF_MAX_DIMENSION = 1920;   // longest edge cap for web delivery
const AVIF_QUALITY = 55;           // visually transparent for photos at 1920px
const AVIF_EFFORT = 4;             // encode-speed/size tradeoff (0-9)

/**
 * Re-encodes an image buffer as web-optimized AVIF: EXIF orientation baked in,
 * metadata stripped, longest edge capped at AVIF_MAX_DIMENSION.
 * Returns the AVIF buffer, or null when the input can't/shouldn't be converted
 * (callers then store the original untouched).
 */
export const convertImageForWeb = async (buffer) => {
    try {
        const image = sharp(buffer, { failOn: 'none' });
        // Animated inputs (animated WebP) would be flattened to their first
        // frame — keep those as-is, same policy as GIF.
        const metadata = await image.metadata();
        if (metadata.pages && metadata.pages > 1) return null;

        return await image
            .rotate() // apply EXIF orientation, since metadata is stripped
            .resize({
                width: AVIF_MAX_DIMENSION,
                height: AVIF_MAX_DIMENSION,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
            .toBuffer();
    } catch (error) {
        console.error('AVIF conversion failed, storing original:', error.message);
        return null;
    }
};

// ── Upload buffer to Bunny.net ───────────────────────────────────────────────
// mimeTypeHint: only pass for audio/doc types — images/videos use magic-byte detection
export const uploadBufferToBunny = async (fileBuffer, folder = "posts", originalName = null, mimeTypeHint = null) => {
    try {
        validateConfig();

        // Use hint only for audio/docs; fall back to original detection for images/videos
        // Magic bytes win over the hint ONLY when they identify a convertible
        // image — so a stale client mimetype (e.g. chat passing image/jpeg)
        // can't bypass AVIF conversion, while audio/video/doc hints keep
        // working exactly as before.
        const detected = getFileType(fileBuffer, originalName);
        const detectionWins = detected.isImage && AVIF_CONVERTIBLE.has(detected.mimeType);
        const fileType = (mimeTypeHint && !detectionWins)
            ? getFileTypeFromHint(mimeTypeHint)
            : detected;

        // Video diverts to Stream when it is configured. The return shape is
        // identical to the Storage path, so none of the eleven call sites care
        // which one ran — they read secure_url, thumbnailUrl and resource_type.
        if (fileType.isVideo && isStreamEnabled()) {
            return await uploadVideoToStream(fileBuffer, originalName);
        }

        // Web optimization: store user images as capped, metadata-stripped AVIF.
        let uploadBuffer = fileBuffer;
        let uploadFileType = fileType;
        let uploadName = originalName;
        if (fileType.isImage &&
            AVIF_CONVERTIBLE.has(fileType.mimeType) &&
            !AVIF_SKIP_FOLDERS.has(folder)) {
            const avifBuffer = await convertImageForWeb(fileBuffer);
            if (avifBuffer) {
                uploadBuffer = avifBuffer;
                uploadFileType = { mimeType: 'image/avif', isVideo: false, isImage: true, isAudio: false, isDocument: false };
                // Null out originalName so the stored extension comes from the
                // MIME map ('avif'), not the client filename (.jpg/.png).
                uploadName = null;
            }
        }

        const filePath = generateFilePath(folder, uploadName, uploadFileType);
        const uploadUrl = `${BUNNY_CONFIG.storageApiUrl}/${filePath}`;

        const response = await axios.put(uploadUrl, uploadBuffer, {
            headers: {
                'AccessKey': BUNNY_CONFIG.accessKey,
                'Content-Type': uploadFileType.mimeType,
                'Content-Length': uploadBuffer.length,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        if (response.status !== 201) {
            throw new Error(`Upload failed with status: ${response.status}`);
        }

        const cdnUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}`;

        let thumbnailUrl = null;
        if (uploadFileType.isImage) {
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?width=300&height=300&crop=fill`;
        } else if (uploadFileType.isVideo) {
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?thumbnail=1&width=300&height=300`;
        }

        let resourceType = 'image';
        if (uploadFileType.isVideo)    resourceType = 'video';
        else if (uploadFileType.isAudio)    resourceType = 'audio';
        else if (uploadFileType.isDocument) resourceType = 'raw';

        return {
            success: true,
            secure_url: cdnUrl,
            public_id: filePath,
            resource_type: resourceType,
            thumbnailUrl,
            format: filePath.split('.').pop(),
            bytes: uploadBuffer.length,
            url: cdnUrl,
        };

    } catch (error) {
        console.error('Bunny.net Upload Error:', error.message);
        if (error.response) {
            console.error('Bunny response status:', error.response.status);
            console.error('Bunny response data:', error.response.data);
        }
        throw new Error(`Failed to upload to Bunny.net: ${error.message}`);
    }
};

export const deleteFromBunny = async (url) => {
    try {
        // Stream videos do not live in the storage zone, so the storage DELETE
        // below would 404 and leave the video in the library — still counting
        // against storage and still billable — every time a post was removed.
        if (isStreamUrl(url)) {
            const guid = streamGuidFromUrl(url);
            if (!guid) return { success: true, result: 'not_found', url };
            try {
                await axios.delete(
                    `${STREAM_API}/${STREAM_CONFIG.libraryId}/videos/${guid}`,
                    { headers: { AccessKey: STREAM_CONFIG.apiKey } }
                );
                return { success: true, result: 'ok', url };
            } catch (error) {
                if (error.response?.status === 404) {
                    return { success: true, result: 'not_found', url };
                }
                throw error;
            }
        }

        validateConfig();
        const filePath = url.replace(`${BUNNY_CONFIG.cdnUrl}/`, '').split('?')[0];
        const response = await axios.delete(`${BUNNY_CONFIG.storageApiUrl}/${filePath}`, {
            headers: { 'AccessKey': BUNNY_CONFIG.accessKey },
        });
        return { success: true, result: response.status === 200 ? 'ok' : 'not_found', url };
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return { success: true, result: 'not_found', url };
        }
        throw new Error(`Failed to delete from Bunny.net: ${error.message}`);
    }
};

export const deleteMultipleFromBunny = async (urls) => {
    const results = [];
    for (const url of urls) {
        try {
            const result = await deleteFromBunny(url);
            results.push({ url, success: true, result: result.result });
        } catch (error) {
            results.push({ url, success: false, error: error.message });
        }
    }
    return {
        results,
        errors: results.filter(r => !r.success),
        totalDeleted: results.filter(r => r.success && r.result === 'ok').length,
        totalSkipped: results.filter(r => r.success && r.result === 'not_found').length,
    };
};

export const isBunnyUrl = (url) => url && url.includes(BUNNY_CONFIG.cdnUrl);

export const generateOptimizedImageUrl = (url, options = {}) => {
    const { width = null, height = null, quality = 85, format = null, crop = null } = options;
    if (!isBunnyUrl(url)) return url;
    const params = new URLSearchParams();
    if (width)   params.append('width', width);
    if (height)  params.append('height', height);
    if (quality) params.append('quality', quality);
    if (format)  params.append('format', format);
    if (crop)    params.append('crop', crop);
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
};

export default { uploadBufferToBunny, deleteFromBunny, deleteMultipleFromBunny, isBunnyUrl, generateOptimizedImageUrl, convertImageForWeb };
