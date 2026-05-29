// Allowed setting keys — only keys listed here can be stored via the settings API
export const SETTING_KEYS = {
    GATEWAY_FEE: 'GATEWAY_FEE',       // Payment gateway fee percentage (e.g. 0.02 = 2%)
    PLATFORM_FEE: 'PLATFORM_FEE',     // Platform fee percentage (e.g. 0.025 = 2.5%)
};

export const ALLOWED_SETTING_KEYS = Object.values(SETTING_KEYS);

// Expected JS typeof for each key's value
export const SETTING_KEY_TYPES = {
    GATEWAY_FEE:  'number',
    PLATFORM_FEE: 'number',
};
