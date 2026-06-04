import { SETTING_KEY_TYPES } from '../../constants/settings.js';

/**
 * Validates that `value` matches the expected type for `key`.
 * Returns { valid: true } or { valid: false, message: string }.
 */
export function validateSettingValue(key, value) {
    const expectedType = SETTING_KEY_TYPES[key];
    if (!expectedType) {
        return { valid: false, message: `No type rule defined for key '${key}'` };
    }

    const actualType = typeof value;

    if (actualType !== expectedType) {
        return {
            valid: false,
            message: `'${key}' expects a ${expectedType}, got ${actualType}`,
        };
    }

    // Extra numeric sanity checks for fee keys
    if (expectedType === 'number') {
        if (isNaN(value) || !isFinite(value)) {
            return { valid: false, message: `'${key}' must be a finite number` };
        }
        if (value < 0) {
            return { valid: false, message: `'${key}' must be non-negative` };
        }
    }

    return { valid: true };
}
