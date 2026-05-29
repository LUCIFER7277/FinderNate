import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
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

// ── Original extension map (unchanged) ──────────────────────────────────────
const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
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
            'gif': 'image/gif', 'webp': 'image/webp',
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

// ── Upload buffer to Bunny.net ───────────────────────────────────────────────
// mimeTypeHint: only pass for audio/doc types — images/videos use magic-byte detection
export const uploadBufferToBunny = async (fileBuffer, folder = "posts", originalName = null, mimeTypeHint = null) => {
    try {
        validateConfig();

        // Use hint only for audio/docs; fall back to original detection for images/videos
        const fileType = mimeTypeHint
            ? getFileTypeFromHint(mimeTypeHint)
            : getFileType(fileBuffer, originalName);

        const filePath = generateFilePath(folder, originalName, fileType);
        const uploadUrl = `${BUNNY_CONFIG.storageApiUrl}/${filePath}`;

        const response = await axios.put(uploadUrl, fileBuffer, {
            headers: {
                'AccessKey': BUNNY_CONFIG.accessKey,
                'Content-Type': fileType.mimeType,
                'Content-Length': fileBuffer.length,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        if (response.status !== 201) {
            throw new Error(`Upload failed with status: ${response.status}`);
        }

        const cdnUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}`;

        let thumbnailUrl = null;
        if (fileType.isImage) {
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?width=300&height=300&crop=fill`;
        } else if (fileType.isVideo) {
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?thumbnail=1&width=300&height=300`;
        }

        let resourceType = 'image';
        if (fileType.isVideo)    resourceType = 'video';
        else if (fileType.isAudio)    resourceType = 'audio';
        else if (fileType.isDocument) resourceType = 'raw';

        return {
            success: true,
            secure_url: cdnUrl,
            public_id: filePath,
            resource_type: resourceType,
            thumbnailUrl,
            format: originalName ? originalName.split('.').pop() : 'unknown',
            bytes: fileBuffer.length,
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

export default { uploadBufferToBunny, deleteFromBunny, deleteMultipleFromBunny, isBunnyUrl, generateOptimizedImageUrl };
