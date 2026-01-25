import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { User } from "../models/user.models.js";
import dynamicQR from "../utlis/dynamicQR.js";
const { generateStyledQR, generateOwnStyledQR, isValidUsername } = dynamicQR;


const getStyledQRCode = asyncHandler(async (req, res) => {
    const { username } = req.params;
    
    if (!isValidUsername(username)) {
        throw new ApiError(400, "Invalid username format");
    }
    
    // Verify user exists
    const userExists = await User.findOne({ username }).select('_id');
    if (!userExists) {
        throw new ApiError(404, "User not found");
    }
    
    // Fixed constants for consistent premium QR codes
    const styling = {
        size: 256,                    // Fixed size
        frameStyle: 'instagram',      // Fixed Instagram gold yellow style
        primaryColor: '#FFD700',      // Fixed gold color
        backgroundColor: '#FFFEF7',   // Fixed cream background
        logoSize: 0.15               // Fixed logo size (15%)
    };
    
    const styledQRBuffer = await generateStyledQR(username, styling);
    
    res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=1800', // Cache for 30 minutes
        'Content-Disposition': `inline; filename="qr-styled-${username}.png"`,
        'X-Style': 'instagram',
        'X-Generated-At': new Date().toISOString()
    });
    
    res.send(styledQRBuffer);
});

// Get authenticated user's own QR code with embedded profile image
const getMyQRCode = asyncHandler(async (req, res) => {
    const { username } = req.user; // From JWT token
    
    // Fixed constants for consistent premium QR codes
    const styling = {
        size: 256,                    // Fixed size
        frameStyle: 'instagram',      // Fixed Instagram gold yellow style
        primaryColor: '#FFD700',      // Fixed gold color
        backgroundColor: '#FFFEF7',   // Fixed cream background
        logoSize: 0.15               // Fixed logo size (15%)
    };
    
    const styledQRBuffer = await generateOwnStyledQR(styling);
    
    res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=1800', 
        'Content-Disposition': `inline; filename="my-qr-${username}.png"`,
        'X-Style': 'instagram',
        'X-Generated-At': new Date().toISOString()
    });
    
    res.send(styledQRBuffer);
});

// Share QR code as base64 data URL for easy sharing
const shareQRCode = asyncHandler(async (req, res) => {
    const { username } = req.params;
    
    if (!isValidUsername(username)) {
        throw new ApiError(400, "Invalid username format");
    }
    
    // Verify target user exists
    const targetUser = await User.findOne({ username }).select('_id username fullName');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }
    
    // Generate QR code as base64 data URL for sharing
    const styling = {
        size: 256,
        frameStyle: 'findernate',
        primaryColor: '#FFD700',
        backgroundColor: '#FFFEF7'
    };
    
    const qrBuffer = await generateStyledQR(username, styling);
    const qrDataURL = `data:image/png;base64,${qrBuffer.toString('base64')}`;
    
    res.status(200).json({
        success: true,
        data: {
            targetUser: {
                username: targetUser.username,
                fullName: targetUser.fullName
            },
            qrCode: {
                dataURL: qrDataURL,
                shareableURL: `https://findernate.com/userprofile/${username}`,
                size: 256,
                style: 'gold-yellow'
            },
            generatedAt: new Date().toISOString()
        },
        message: "QR code ready for sharing"
    });
});

// Share your own QR code
const shareMyQRCode = asyncHandler(async (req, res) => {
    const { username } = req.user;
    
    // Generate own QR code as base64 for sharing
    const styling = {
        size: 256,
        frameStyle: 'findernate',
        primaryColor: '#FFD700',
        backgroundColor: '#FFFEF7'
    };
    
    const qrBuffer = await generateOwnStyledQR(styling);
    const qrDataURL = `data:image/png;base64,${qrBuffer.toString('base64')}`;
    
    res.status(200).json({
        success: true,
        data: {
            qrCode: {
                dataURL: qrDataURL,
                shareableURL: `https://findernate.com/profile`,
                size: 256,
                style: 'gold-yellow'
            },
            owner: username,
            generatedAt: new Date().toISOString(),
            sharing: {
                message: `Check out my FINDERNATE profile!`,
                hashtags: ['#FINDERNATE', '#Profile', '#Connect']
            }
        },
        message: "Your QR code is ready for sharing"
    });
});

// Share QR code image for chat (returns PNG image)
const shareQRForChat = asyncHandler(async (req, res) => {
    const { username } = req.params;
    
    if (!isValidUsername(username)) {
        throw new ApiError(400, "Invalid username format");
    }
    
    // Verify target user exists
    const targetUser = await User.findOne({ username }).select('_id username fullName');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }
    
    // Generate smaller QR code for chat (200px)
    const styling = {
        size: 200,
        frameStyle: 'findernate',
        primaryColor: '#FFD700',
        backgroundColor: '#FFFEF7'
    };
    
    const qrBuffer = await generateStyledQR(username, styling);
    
    // Set headers for chat image sharing
    res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300', // 5 minutes cache for chat
        'Content-Disposition': `inline; filename="chat-qr-${username}.png"`,
        'X-Chat-QR': 'true',
        'X-Target-User': targetUser.username,
        'X-Generated-At': new Date().toISOString()
    });
    
    res.send(qrBuffer);
});

// Share your own QR code image for chat
const shareMyQRForChat = asyncHandler(async (req, res) => {
    const { username } = req.user;
    
    // Generate smaller QR code for chat (200px)
    const styling = {
        size: 200,
        frameStyle: 'findernate',
        primaryColor: '#FFD700',
        backgroundColor: '#FFFEF7'
    };
    
    const qrBuffer = await generateOwnStyledQR(styling);
    
    // Set headers for chat image sharing
    res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=300', // 5 minutes cache for chat
        'Content-Disposition': `inline; filename="chat-my-qr-${username}.png"`,
        'X-Chat-QR': 'true',
        'X-Owner': username,
        'X-Generated-At': new Date().toISOString()
    });
    
    res.send(qrBuffer);
});

export {
    getStyledQRCode,
    getMyQRCode,
    shareQRCode,
    shareMyQRCode,
    shareQRForChat,
    shareMyQRForChat
};