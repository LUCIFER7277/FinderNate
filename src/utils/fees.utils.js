import Setting from '../models/settings.models.js';

const DEFAULTS = {
    GATEWAY_FEE: 0.02,   // 2%
    PLATFORM_FEE: 0.025, // 2.5%
};

/**
 * Fetches GATEWAY_FEE and PLATFORM_FEE from DB.
 * Falls back to hardcoded defaults if a key is missing.
 */
export async function getFeeRates() {
    const docs = await Setting.find({ key: { $in: ['GATEWAY_FEE', 'PLATFORM_FEE'] } }).lean();
    const map = Object.fromEntries(docs.map((d) => [d.key, Number(d.value)]));

    return {
        gatewayFeeRate: map.GATEWAY_FEE ?? DEFAULTS.GATEWAY_FEE,
        platformFeeRate: map.PLATFORM_FEE ?? DEFAULTS.PLATFORM_FEE,
    };
}
