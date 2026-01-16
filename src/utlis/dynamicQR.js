import QRCode from 'qrcode';
import { ApiError } from './ApiError.js';

/**
 * Generate styled QR code with Instagram gold yellow colors
 * Note: Profile image embedding requires canvas which has Windows build issues
 * This version provides beautiful gold yellow QR codes without profile images
 * @param {string} username - Username to generate QR for
 * @param {Object} styling - Styling options
 * @returns {Buffer} Styled QR code image buffer
 */
const generateStyledQR = async (username, styling = {}) => {
    try {
        const {
            size = 512,
            primaryColor = '#000000',
            backgroundColor = '#FFFFFF',
            frameStyle = 'none',
            profileImageUrl = null,
            baseUrl = 'https://findernate.com',
        } = styling;

        const profileUrl = `${baseUrl}/userprofile/${username}?utm_source=qr_styled`;
        console.log('🔗 QR Code URL generated:', profileUrl);
        
        // Apply different styling based on frameStyle
        let qrColor = primaryColor;
        let qrBackground = backgroundColor;
        let margin = 4;
        
        if (frameStyle === 'findernate') {
            // Instagram gold yellow - premium look
            qrColor = '#FFD700';
            qrBackground = '#FFFEF7';
            margin = 6;
        }
        
        // Generate premium styled QR code with enhanced error correction
        const qrBuffer = await QRCode.toBuffer(profileUrl, {
            width: size,
            margin: margin,
            color: {
                dark: qrColor,
                light: qrBackground
            },
            errorCorrectionLevel: 'H', // High error correction for premium quality
            type: 'png'
        });
        
        return qrBuffer;

    } catch (error) {
        console.error('Styled QR generation error:', error);
        throw new ApiError(500, `Failed to generate styled QR code: ${error.message}`);
    }
};

const generateOwnStyledQR = async (styling = {}) => {
    try {
        const {
            size = 512,
            primaryColor = '#000000',
            backgroundColor = '#FFFFFF',
            frameStyle = 'none',
            profileImageUrl = null,
            baseUrl = 'https://findernate.com',
        } = styling;

        const profileUrl = `${baseUrl}/profile?utm_source=qr_styled`;
        console.log('🔗 QR Code URL generated:', profileUrl);

        // Apply different styling based on frameStyle
        let qrColor = primaryColor;
        let qrBackground = backgroundColor;
        let margin = 4;

        if (frameStyle === 'findernate') {
            // Instagram gold yellow - premium look
            qrColor = '#FFD700';
            qrBackground = '#FFFEF7';
            margin = 6;
        }

        // Generate premium styled QR code with enhanced error correction
        const qrBuffer = await QRCode.toBuffer(profileUrl, {
            width: size,
            margin: margin,
            color: {
                dark: qrColor,
                light: qrBackground
            },
            errorCorrectionLevel: 'H', // High error correction for premium quality
            type: 'png'
        });

        return qrBuffer;

    } catch (error) {
        console.error('Styled QR generation error:', error);
        throw new ApiError(500, `Failed to generate styled QR code: ${error.message}`);
    }
};

/**
 * Validate username for QR generation
 * @param {string} username - Username to validate
 * @returns {boolean} Is valid
 */
const isValidUsername = (username) => {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 30) return false;
    
    // Check for valid characters (alphanumeric, underscore, dot)
    const validPattern = /^[a-zA-Z0-9_.]+$/;
    return validPattern.test(username);
};

export default {
    generateStyledQR,
    generateOwnStyledQR,
    isValidUsername
};