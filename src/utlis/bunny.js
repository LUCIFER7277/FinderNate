import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Bunny.net configuration
const BUNNY_CONFIG = {
    storageZoneName: process.env.BUNNY_STORAGE_ZONE_NAME,
    accessKey: process.env.BUNNY_ACCESS_KEY,
    storageApiUrl: process.env.BUNNY_STORAGE_API_URL,
    cdnUrl: process.env.BUNNY_CDN_URL,
};

// Validate configuration
const validateConfig = () => {
    const required = ['storageZoneName', 'accessKey', 'storageApiUrl', 'cdnUrl'];
    const missing = required.filter(key => !BUNNY_CONFIG[key]);

    if (missing.length > 0) {
        throw new Error(`Missing Bunny.net configuration: ${missing.join(', ')}`);
    }
};

// Helper function to generate file path
const generateFilePath = (folder = "posts", originalName = null, fileType = null) => {
    const timestamp = Date.now();
    const uuid = uuidv4();
    
    let extension = 'jpg'; // default
    
    if (originalName) {
        extension = originalName.split('.').pop();
    } else if (fileType) {
        // If no original name but we have file type, use appropriate extension
        const mimeToExtension = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'video/mp4': 'mp4',
            'video/webm': 'webm',
            'video/avi': 'avi',
            'video/quicktime': 'mov',
            'video/x-ms-wmv': 'wmv',
            'video/x-flv': 'flv'
        };
        extension = mimeToExtension[fileType.mimeType] || 'bin';
    }
    
    return `${folder}/${timestamp}-${uuid}.${extension}`;
};

// Helper function to determine file type
const getFileType = (buffer, originalName = null) => {
    const signatures = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46],
        'image/webp': [0x52, 0x49, 0x46, 0x46],
        'video/mp4': [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70],
        'video/webm': [0x1A, 0x45, 0xDF, 0xA3],
        'video/avi': [0x52, 0x49, 0x46, 0x46]
    };

    // First try to detect by file signature
    for (const [mimeType, signature] of Object.entries(signatures)) {
        if (signature.every((byte, index) => byte === null || buffer[index] === byte)) {
            return {
                mimeType,
                isVideo: mimeType.startsWith('video/'),
                isImage: mimeType.startsWith('image/')
            };
        }
    }

    // Fallback to file extension if signature detection fails
    if (originalName) {
        const extension = originalName.toLowerCase().split('.').pop();
        const extensionMimeTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'mp4': 'video/mp4',
            'webm': 'video/webm',
            'avi': 'video/avi',
            'mov': 'video/quicktime',
            'wmv': 'video/x-ms-wmv',
            'flv': 'video/x-flv'
        };

        const mimeType = extensionMimeTypes[extension];
        if (mimeType) {
            return {
                mimeType,
                isVideo: mimeType.startsWith('video/'),
                isImage: mimeType.startsWith('image/')
            };
        }
    }

    return {
        mimeType: 'application/octet-stream',
        isVideo: false,
        isImage: false
    };
};

// Upload buffer to Bunny.net
export const uploadBufferToBunny = async (fileBuffer, folder = "posts", originalName = null) => {
    try {
        validateConfig();

        const fileType = getFileType(fileBuffer, originalName);
        const filePath = generateFilePath(folder, originalName, fileType);

        console.log('Upload Debug Info:');
        console.log('- File path:', filePath);
        console.log('- File type detected:', fileType);
        console.log('- Buffer size:', fileBuffer.length);
        console.log('- Original name:', originalName);

        // Upload to Bunny.net Storage API
        const uploadUrl = `${BUNNY_CONFIG.storageApiUrl}/${filePath}`;
        console.log('- Upload URL:', uploadUrl);

        const response = await axios.put(uploadUrl, fileBuffer, {
            headers: {
                'AccessKey': BUNNY_CONFIG.accessKey,
                'Content-Type': fileType.mimeType,
                'Content-Length': fileBuffer.length
            }
        });

        console.log('- Upload response status:', response.status);

        if (response.status !== 201) {
            throw new Error(`Upload failed with status: ${response.status}`);
        }

        // Generate CDN URL
        const cdnUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}`;

        // Generate thumbnail URL for images
        let thumbnailUrl = null;
        if (fileType.isImage) {
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?width=300&height=300&crop=fill`;
        } else if (fileType.isVideo) {
            // For videos, we'll use a thumbnail extraction parameter
            thumbnailUrl = `${BUNNY_CONFIG.cdnUrl}/${filePath}?thumbnail=1&width=300&height=300`;
        }

        return {
            success: true,
            secure_url: cdnUrl,
            public_id: filePath,
            resource_type: fileType.isVideo ? 'video' : 'image',
            thumbnailUrl,
            format: originalName ? originalName.split('.').pop() : 'unknown',
            bytes: fileBuffer.length,
            url: cdnUrl
        };

    } catch (error) {
        console.error('Bunny.net Upload Error:', error);
        if (error.response) {
            console.error('- Response status:', error.response.status);
            console.error('- Response data:', error.response.data);
            console.error('- Response headers:', error.response.headers);
        }
        throw new Error(`Failed to upload to Bunny.net: ${error.message}`);
    }
};

// Delete single file from Bunny.net
export const deleteFromBunny = async (url) => {
    try {
        validateConfig();

        // Extract file path from CDN URL
        const filePath = url.replace(`${BUNNY_CONFIG.cdnUrl}/`, '').split('?')[0];

        const deleteUrl = `${BUNNY_CONFIG.storageApiUrl}/${filePath}`;

        const response = await axios.delete(deleteUrl, {
            headers: {
                'AccessKey': BUNNY_CONFIG.accessKey
            }
        });

        return {
            success: true,
            result: response.status === 200 ? 'ok' : 'not_found',
            url: url
        };

    } catch (error) {
        if (error.response && error.response.status === 404) {
            return {
                success: true,
                result: 'not_found',
                url: url
            };
        }
        throw new Error(`Failed to delete from Bunny.net: ${error.message}`);
    }
};

// Delete multiple files from Bunny.net
export const deleteMultipleFromBunny = async (urls) => {
    const results = [];
    const errors = [];

    for (const url of urls) {
        try {
            const result = await deleteFromBunny(url);
            results.push({ url, success: true, result: result.result });
        } catch (error) {
            results.push({ url, success: false, error: error.message });
            errors.push({ url, error: error.message });
        }
    }

    return {
        results,
        errors,
        totalDeleted: results.filter(r => r.success && r.result === 'ok').length,
        totalSkipped: results.filter(r => r.success && r.result === 'not_found').length
    };
};

// Helper function to check if URL is from Bunny.net
export const isBunnyUrl = (url) => {
    return url && url.includes(BUNNY_CONFIG.cdnUrl);
};

// Helper function to generate optimized image URL
export const generateOptimizedImageUrl = (url, options = {}) => {
    const {
        width = null,
        height = null,
        quality = 85,
        format = null,
        crop = null
    } = options;

    if (!isBunnyUrl(url)) {
        return url;
    }

    const params = new URLSearchParams();

    if (width) params.append('width', width);
    if (height) params.append('height', height);
    if (quality) params.append('quality', quality);
    if (format) params.append('format', format);
    if (crop) params.append('crop', crop);

    const queryString = params.toString();
    return queryString ? `${url}?${queryString}` : url;
};

export default {
    uploadBufferToBunny,
    deleteFromBunny,
    deleteMultipleFromBunny,
    isBunnyUrl,
    generateOptimizedImageUrl
};
