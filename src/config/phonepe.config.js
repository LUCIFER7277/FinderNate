import axios from 'axios';
import crypto from 'crypto';

const PHONEPE_API_BASE = 'https://api.phonepe.com/apis';

const CLIENT_ID     = process.env.PHONEPE_CLIENT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const CLIENT_VERSION = process.env.PHONEPE_CLIENT_VERSION || '1';

// ── Token cache ──────────────────────────────────────────────────────────────
let _cachedToken   = null;
let _tokenExpiresAt = 0;

export const getPhonePeToken = async () => {
    if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) {
        return _cachedToken;
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw new Error('PHONEPE_CLIENT_ID or PHONEPE_CLIENT_SECRET is not configured');
    }

    const params = new URLSearchParams({
        client_id:      CLIENT_ID,
        client_secret:  CLIENT_SECRET,
        grant_type:     'client_credentials',
        client_version: CLIENT_VERSION
    });

    const response = await axios.post(
        `${PHONEPE_API_BASE}/identity-manager/v1/oauth/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    _cachedToken    = response.data.access_token;
    _tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
    return _cachedToken;
};

// ── merchantOrderId generator ─────────────────────────────────────────────────
// Max 38 chars, alphanumeric + hyphen/underscore only
export const generateMerchantTransactionId = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random    = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CASHPAY-${timestamp}-${random}`;
};

// ── Initiate payment ──────────────────────────────────────────────────────────
// paymentData shape:
// {
//   merchantOrderId, amount (paise), expireAfter (seconds),
//   paymentFlow: {
//     type: 'PG_CHECKOUT',
//     message,
//     merchantUrls: { redirectUrl, callbackUrl? }
//   }
// }
export const initiatePhonePePayment = async (paymentData) => {
    const token = await getPhonePeToken();

    const response = await axios.post(
        `${PHONEPE_API_BASE}/pg/checkout/v2/pay`,
        paymentData,
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `O-Bearer ${token}`
            }
        }
    );
    return response.data;
};

// ── Check payment status ──────────────────────────────────────────────────────
// Returns: { merchantOrderId, transactionId, amount, state, paymentDetails }
// state: 'COMPLETED' | 'FAILED' | 'PENDING'
export const checkPhonePePaymentStatus = async (merchantOrderId) => {
    const token = await getPhonePeToken();

    const response = await axios.get(
        `${PHONEPE_API_BASE}/pg/checkout/v2/order/${merchantOrderId}/status`,
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `O-Bearer ${token}`
            }
        }
    );
    return response.data;
};

// ── Verify webhook (SHA256 username:password) ─────────────────────────────────
// PhonePe v2 sends Authorization: SHA256(username:password) on webhook callbacks.
// Configure PHONEPE_WEBHOOK_USERNAME and PHONEPE_WEBHOOK_PASSWORD in .env
// to match what you set in PhonePe Business Dashboard → Webhook settings.
export const verifyPhonePeWebhookSignature = (authHeader) => {
    const username = process.env.PHONEPE_WEBHOOK_USERNAME;
    const password = process.env.PHONEPE_WEBHOOK_PASSWORD;

    if (!username || !password) return true; // skip verification if not configured

    const expected = crypto
        .createHash('sha256')
        .update(`${username}:${password}`)
        .digest('hex');

    return authHeader === expected;
};
