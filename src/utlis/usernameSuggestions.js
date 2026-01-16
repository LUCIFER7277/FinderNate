import { User } from '../models/user.models.js';

/**
 * Generate real-time username suggestions as user types (3+ characters)
 * @param {string} partialUsername - The partial username user is typing
 * @param {number} count - Number of suggestions to generate (default: 8)
 * @returns {Promise<object>} Object with availability and suggestions
 */
export const generateRealtimeUsernameSuggestions = async (partialUsername, count = 8) => {
    const cleanBase = partialUsername.toLowerCase().replace(/[^a-z0-9_]/g, '');
    
    // Must be at least 3 characters
    if (!cleanBase || cleanBase.length < 3) {
        return {
            suggestions: [],
            isAvailable: false,
            message: 'Username must be at least 3 characters'
        };
    }

    // Check if the exact username is available
    const isExactAvailable = await isUsernameAvailable(cleanBase);
    
    const suggestions = [];
    
    // If exact username is available, suggest it first
    if (isExactAvailable && cleanBase.length >= 3) {
        suggestions.push(cleanBase);
    }

    // Strategy 1: Complete the partial username with common endings
    const commonEndings = ['123', '01', '99', '_official', '_real', '_user', '2024', '2025'];
    for (const ending of commonEndings) {
        if (suggestions.length >= count) break;
        const suggestion = `${cleanBase}${ending}`;
        if (suggestion !== cleanBase && await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 2: Add numbers at the end (smaller range for real-time)
    for (let i = 1; suggestions.length < count && i <= 50; i++) {
        const suggestion = `${cleanBase}${i}`;
        if (suggestion !== cleanBase && await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 3: Add underscore variations
    const underscoreVariations = ['_1', '_2', '_3', '_x', '_new', '_pro'];
    for (const variation of underscoreVariations) {
        if (suggestions.length >= count) break;
        const suggestion = `${cleanBase}${variation}`;
        if (await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 4: Prefix variations (only if base is 4+ chars to avoid too short)
    if (cleanBase.length >= 4) {
        const prefixes = ['the_', 'real_', 'im_'];
        for (const prefix of prefixes) {
            if (suggestions.length >= count) break;
            const suggestion = `${prefix}${cleanBase}`;
            if (await isUsernameAvailable(suggestion)) {
                suggestions.push(suggestion);
            }
        }
    }

    // Strategy 5: Random 2-digit numbers (quick generation)
    let attempts = 0;
    while (suggestions.length < count && attempts < 20) {
        const randomNum = Math.floor(Math.random() * 99) + 10;
        const suggestion = `${cleanBase}${randomNum}`;
        if (!suggestions.includes(suggestion) && await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
        attempts++;
    }

    return {
        suggestions: suggestions.slice(0, count),
        isAvailable: isExactAvailable,
        originalUsername: cleanBase,
        message: isExactAvailable ? 'Available!' : 'Username is taken, try these suggestions:'
    };
};

/**
 * Generate username suggestions based on a base username (for registration completion)
 * @param {string} baseUsername - The base username to generate suggestions from
 * @param {number} count - Number of suggestions to generate (default: 5)
 * @returns {Promise<string[]>} Array of available username suggestions
 */
export const generateUsernameSuggestions = async (baseUsername, count = 5) => {
    const suggestions = [];
    const cleanBase = baseUsername.toLowerCase().replace(/[^a-z0-9_]/g, '');
    
    if (!cleanBase) {
        return [];
    }

    // Strategy 1: Add numbers at the end
    for (let i = 1; suggestions.length < count && i <= 999; i++) {
        const suggestion = `${cleanBase}${i}`;
        if (await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 2: Add underscore and numbers
    if (suggestions.length < count) {
        for (let i = 1; suggestions.length < count && i <= 99; i++) {
            const suggestion = `${cleanBase}_${i}`;
            if (await isUsernameAvailable(suggestion)) {
                suggestions.push(suggestion);
            }
        }
    }

    // Strategy 3: Add common suffixes
    const suffixes = ['official', 'real', 'actual', 'the', 'original', 'user', 'account'];
    for (const suffix of suffixes) {
        if (suggestions.length >= count) break;
        const suggestion = `${cleanBase}_${suffix}`;
        if (await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 4: Add prefixes
    const prefixes = ['the', 'real', 'im', 'its', 'hello'];
    for (const prefix of prefixes) {
        if (suggestions.length >= count) break;
        const suggestion = `${prefix}_${cleanBase}`;
        if (await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    // Strategy 5: Variations with dots (if allowed by your system)
    if (suggestions.length < count) {
        const dotSuggestion = `${cleanBase.replace(/_/g, '.')}.user`;
        if (await isUsernameAvailable(dotSuggestion)) {
            suggestions.push(dotSuggestion);
        }
    }

    // Strategy 6: Random numbers (2-4 digits)
    while (suggestions.length < count) {
        const randomNum = Math.floor(Math.random() * 9999) + 100;
        const suggestion = `${cleanBase}${randomNum}`;
        if (await isUsernameAvailable(suggestion)) {
            suggestions.push(suggestion);
        }
    }

    return suggestions.slice(0, count);
};

/**
 * Check if a username is available
 * @param {string} username - Username to check
 * @returns {Promise<boolean>} True if available, false if taken
 */
export const isUsernameAvailable = async (username) => {
    if (!username || username.length < 3 || username.length > 30) {
        return false;
    }

    // Check for valid format (letters, numbers, underscores, dots)
    const validFormat = /^[a-zA-Z0-9_.]+$/.test(username);
    if (!validFormat) {
        return false;
    }

    // Check if username exists in database
    try {
        const existingUser = await User.findOne({ 
            username: username.toLowerCase() 
        }).select('_id');
        
        return !existingUser;
    } catch (error) {
        console.error('Error checking username availability:', error);
        return false;
    }
};

/**
 * Validate username format and rules
 * @param {string} username - Username to validate
 * @returns {object} Validation result with isValid and errors
 */
export const validateUsername = (username) => {
    const errors = [];
    
    if (!username) {
        errors.push('Username is required');
        return { isValid: false, errors };
    }

    if (username.length < 3) {
        errors.push('Username must be at least 3 characters long');
    }

    if (username.length > 30) {
        errors.push('Username must be less than 30 characters');
    }

    if (!/^[a-zA-Z0-9_.]+$/.test(username)) {
        errors.push('Username can only contain letters, numbers, underscores, and dots');
    }

    if (username.startsWith('.') || username.endsWith('.')) {
        errors.push('Username cannot start or end with a dot');
    }

    if (username.includes('..')) {
        errors.push('Username cannot contain consecutive dots');
    }

    // Reserved usernames
    const reserved = [
        'admin', 'administrator', 'root', 'api', 'www', 'mail', 'email',
        'support', 'help', 'info', 'contact', 'about', 'privacy', 'terms',
        'findernate', 'official', 'team', 'staff', 'moderator', 'mod'
    ];
    
    if (reserved.includes(username.toLowerCase())) {
        errors.push('This username is reserved');
    }

    return {
        isValid: errors.length === 0,
        errors
    };
};