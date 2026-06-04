import axios from 'axios';
import crypto from 'crypto';

const CASHFREE_ENV = process.env.CASHFREE_ENV || 'sandbox'; // 'sandbox' | 'production'

const BASE_URL =
    CASHFREE_ENV === 'production'
        ? 'https://api.cashfree.com/pg'
        : 'https://sandbox.cashfree.com/pg';

const APP_ID     = process.env.CASHFREE_APP_ID;
const SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const API_VERSION = '2023-08-01';

// ── RSA private key for dynamic-IP signature auth ──────────────────────────────
// Store the PEM in CASHFREE_PRIVATE_KEY env var with literal \n for newlines.
// If not set, falls back to client-secret-only auth (static IP / sandbox).
const getRawPrivateKey = () => {
    const raw = process.env.CASHFREE_PRIVATE_KEY;
    if (!raw) return null;
    // Support both real newlines and escaped \n (common in .env files)
    return raw.replace(/\\n/g, '\n');
};

// ── Generate x-cf-signature ────────────────────────────────────────────────────
// Cashfree dynamic-IP auth (API v2023-08-01):
//   signedData = "{clientId}.{timestampSeconds}"
//   signature  = Base64( RSA-SHA256( signedData, privateKey ) )
//   headers    = { x-cf-signature, x-timestamp }
const generateCfSignature = (timestampSec) => {
    const privateKey = getRawPrivateKey();
    if (!privateKey) return null;

    const dataToSign = `${APP_ID}.${timestampSec}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(dataToSign);
    sign.end();
    return sign.sign(privateKey, 'base64');
};

// ── Build request headers ──────────────────────────────────────────────────────
export const cfHeaders = () => {
    const timestampSec = Math.floor(Date.now() / 1000).toString();
    const signature    = generateCfSignature(timestampSec);

    const headers = {
        'Content-Type': 'application/json',
        'x-client-id': APP_ID,
        'x-client-secret': SECRET_KEY,
        'x-api-version': API_VERSION,
    };

    // Add signature headers only when a private key is configured (dynamic IP)
    if (signature) {
        headers['x-cf-signature'] = signature;
        headers['x-timestamp']    = timestampSec;
    }

    return headers;
};

// ── Order ID generator ──────────────────────────────────────────────────────────
// Cashfree: alphanumeric + hyphens/underscores, max 50 chars
export const generateCashfreeOrderId = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random    = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CF-${timestamp}-${random}`; // ~18 chars, well within limit
};

// RefundId generator
export const generateCashfreeRefundId = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random    = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `refund-${timestamp}-${random}`;
};

// ── Create a Cashfree payment order ────────────────────────────────────────────
// Returns the order object including payment_session_id for the checkout redirect
export const createCashfreeOrder = async ({
    orderId,
    amount,        // in INR (not paise)
    currency = 'INR',
    customerId,
    customerName,
    customerEmail,
    customerPhone,
    returnUrl,     // where to redirect after payment
    notifyUrl,     // S2S webhook URL
    expiryMinutes = 20,
    orderNote
}) => {
    if (!APP_ID || !SECRET_KEY) {
        throw new Error('CASHFREE_APP_ID or CASHFREE_SECRET_KEY is not configured');
    }

    const expiryTime = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

    const payload = {
        order_id: orderId,
        order_amount: Number(amount.toFixed(2)),
        order_currency: currency,
        order_note: orderNote || `Payment order ${orderId}`,
        order_expiry_time: expiryTime,
        customer_details: {
            customer_id: customerId || `guest_${Date.now()}`,
            customer_name: customerName || 'Customer',
            customer_email: customerEmail || 'noreply@findernate.com',
            customer_phone: customerPhone || '9999999999'
        },
        order_meta: {
            return_url: returnUrl,
            notify_url: notifyUrl || undefined,
            payment_methods: 'cc,dc,upi,nb,app,paylater'
        }
    };

    const response = await axios.post(`${BASE_URL}/orders`, payload, {
        headers: cfHeaders()
    });

    return response.data; // { cf_order_id, order_id, order_status, payment_session_id, ... }
};

// ── Get Cashfree order status ───────────────────────────────────────────────────
// state: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELLED'
export const getCashfreeOrderStatus = async (orderId) => {
    const response = await axios.get(`${BASE_URL}/orders/${orderId}`, {
        headers: cfHeaders()
    });
    return response.data;
};

// ── Get a specific refund for an order ─────────────────────────────────────────
export const getCashfreeRefund = async (orderId, refundId) => {
    const response = await axios.get(`${BASE_URL}/orders/${orderId}/refunds/${refundId}`, {
        headers: cfHeaders()
    });
    return response.data; // single refund object
};

// ── Create a refund for an order ───────────────────────────────────────────────
export const createCashfreeRefund = async (orderId, refundId, amount, note = 'Admin initiated refund') => {
    const response = await axios.post(
        `${BASE_URL}/orders/${orderId}/refunds`,
        {
            refund_id: refundId,
            refund_amount: Number(Number(amount).toFixed(2)),
            refund_note: note,
            refund_speed: 'STANDARD'
        },
        { headers: cfHeaders() }
    );
    return response.data; // single refund object with refund_status
};

// ── Get payments for an order ───────────────────────────────────────────────────
export const getCashfreePayments = async (orderId) => {
    const response = await axios.get(`${BASE_URL}/orders/${orderId}/payments`, {
        headers: cfHeaders()
    });
    return response.data; // array of payment objects
};

// ── Build checkout redirect URL ─────────────────────────────────────────────────
export const buildCashfreeCheckoutUrl = (paymentSessionId) => {
    if (CASHFREE_ENV === 'production') {
        return `https://payments.cashfree.com/order/#${paymentSessionId}`;
    }
    return `https://sandbox.cashfree.com/pg/view/sessions/${paymentSessionId}`;
};

// ── Verify Cashfree webhook signature ──────────────────────────────────────────
// Cashfree v2023-08-01:
//   x-webhook-timestamp: unix timestamp (string)
//   x-webhook-signature: base64(HMAC-SHA256(timestamp + rawBody, secretKey))
export const verifyCashfreeWebhook = (timestamp, signature, rawBody) => {
    if (!SECRET_KEY) return true; // skip if not configured

    const data     = `${timestamp}${rawBody}`;
    const computed = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(data)
        .digest('base64');

    return computed === signature;
};
