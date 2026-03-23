import axios from 'axios';

/**
 * Send SMS OTP via Fast2SMS.
 *
 * Fast2SMS supports Indian numbers only (+91 / 10-digit mobile).
 * For international numbers we log a warning and skip sending
 * (you can swap in Twilio or another provider here).
 *
 * @param {string} phone  - Full phone number as stored (e.g. "+919876543210" or "+14155552671")
 * @param {string} otp    - Plain 6-digit OTP string to deliver
 */
export const sendSms = async ({ phone, otp }) => {
    // Strip everything except digits
    const digits = phone.replace(/\D/g, '');

    let mobileNumber = digits;
    if (digits.startsWith('91') && digits.length === 12) {
        mobileNumber = digits.slice(2); // strip country code
    }

    const isIndianNumber = mobileNumber.length === 10 && /^[6-9]/.test(mobileNumber);

    if (!isIndianNumber) {
        // Fast2SMS only supports Indian numbers.
        // For international numbers you would integrate Twilio / AWS SNS here.
        console.warn(`[SMS] Skipping Fast2SMS for non-Indian number: ${phone}`);
        return { return: true, message: 'SMS skipped for non-Indian number' };
    }

    try {
        const response = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
            params: {
                authorization: process.env.FAST2SMS_API_KEY,
                route: 'dlt',
                sender_id: process.env.FAST2SMS_SENDER_ID || 'FRNATE',
                message: process.env.FAST2SMS_TEMPLATE_ID || '211818',
                variables_values: `${otp}|`,
                flash: 0,
                numbers: mobileNumber,
            },
            headers: {
                'cache-control': 'no-cache',
            },
        });

        if (!response.data.return) {
            const msg = Array.isArray(response.data.message)
                ? response.data.message.join(', ')
                : response.data.message || 'SMS sending failed';
            console.error(`[SMS] Fast2SMS rejected request: ${msg}`);
            throw new Error(msg);
        }

        return response.data;
    } catch (err) {
        // Axios throws on 4xx/5xx — extract the actual Fast2SMS error body
        if (err.response) {
            const body = err.response.data;
            const msg = Array.isArray(body?.message)
                ? body.message.join(', ')
                : body?.message || `Fast2SMS error ${err.response.status}`;
            console.error(`[SMS] Fast2SMS HTTP ${err.response.status}: ${msg}`, body);
            throw new Error(msg);
        }
        // Network error or similar
        console.error('[SMS] Failed to reach Fast2SMS:', err.message);
        throw err;
    }
};
