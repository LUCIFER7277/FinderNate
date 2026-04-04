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

const cfHeaders = () => ({
    'Content-Type': 'application/json',
    'x-client-id': APP_ID,
    'x-client-secret': SECRET_KEY,
    'x-api-version': API_VERSION,
});

// ── Order ID generator ──────────────────────────────────────────────────────────
// Cashfree: alphanumeric + hyphens/underscores, max 50 chars
export const generateCashfreeOrderId = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random    = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CF-${timestamp}-${random}`; // ~18 chars, well within limit
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

    const expiryTime = new Date(Date.now() + expiryMinutes * 60 * 1000)
        .toISOString()
        .replace('Z', '+05:30'); // IST offset

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
            payment_methods: 'cc,dc,upi,nb,wallets'
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

    const data    = `${timestamp}${rawBody}`;
    const computed = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(data)
        .digest('base64');

    return computed === signature;
};
