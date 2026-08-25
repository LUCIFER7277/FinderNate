import axios from 'axios';
import { ApiError } from './ApiError.js';

/**
 * The 10-digit national number Fast2SMS will be given, or null when it cannot
 * address this number at all.
 *
 * Accepts a number in ANY of the shapes this codebase stores and passes around
 * — "+919876543210", "919876543210", "9876543210", "+91 98765 43210" — because
 * `user.phoneNumber` predates normalizePhone() and exists both bare and
 * prefixed in the data (see resolveUserByIdentifier in controllers/user/_helpers.js).
 */
const fast2smsNumber = (phone) => {
    // Strip everything except digits
    const digits = String(phone ?? '').replace(/\D/g, '');

    let mobileNumber = digits;
    if (digits.startsWith('91') && digits.length === 12) {
        mobileNumber = digits.slice(2); // strip country code
    }

    const isIndianNumber = mobileNumber.length === 10 && /^[6-9]/.test(mobileNumber);
    return isIndianNumber ? mobileNumber : null;
};

/**
 * Refuses a number Fast2SMS can never deliver to; returns the national number
 * it will be sent as.
 *
 * THE SINGLE DEFINITION of "can we address this number". sendSms() below calls
 * it too, so a caller's pre-flight answer and the real send can never drift.
 *
 * Exported because the OTP controllers have to ask BEFORE they spend anything.
 * sendSms() is reached only after rateCheckAndUpsertOtp(), which burns one of
 * the account's OTPs for the day AND arms the 60s resend cooldown — so on a
 * number that can never work the person was told "use an Indian number", and
 * their next attempt (or a plain retry of the same one) was answered with
 * "please wait N seconds before requesting a new OTP": a wait for a code that
 * was never coming. Called early, nothing is charged for a request that is
 * doomed by construction.
 *
 * Fast2SMS only supports Indian numbers. For international numbers you would
 * integrate Twilio / AWS SNS here.
 *
 * The old code logged a warning and RETURNED `{ return: true }` — byte for byte
 * the success shape Fast2SMS itself replies with. Every caller read that as
 * "delivered", so registration answered "OTP sent to your phone number" and
 * parked the person on a PIN screen that no SMS would ever satisfy, and
 * password reset did the same. Nothing looked broken from the outside; anyone
 * outside India simply could not create an account or recover one, with no
 * error to explain why.
 *
 * Raised as an ApiError so this wording is what the client shows, rather than a
 * bare Error that errorHandler.js turns into a 500 "something went wrong on our
 * end" — the number is the problem, and the person needs to be told that so
 * they can act on it.
 *
 * Deliberately NO field-level `errors` entry, unlike the validation failures in
 * auth.js: this rule has callers whose request bodies name the number
 * differently (`phoneNumber`, `phone`, `identifier`), so any one field name here
 * would mis-target the others. The message carries it instead.
 *
 * @param {string} phone - Full phone number as stored (e.g. "+919876543210" or "+14155552671")
 * @returns {string} The 10-digit national number Fast2SMS is addressed with
 */
export const assertSmsDeliverable = (phone) => {
    const mobileNumber = fast2smsNumber(phone);
    if (mobileNumber) return mobileNumber;

    console.warn(`[SMS] Fast2SMS cannot deliver to non-Indian number: ${phone}`);
    throw new ApiError(400, "SMS verification is currently available only for Indian mobile numbers. Please use an Indian (+91) number to continue.");
};

/**
 * Send SMS OTP via Fast2SMS.
 *
 * Fast2SMS supports Indian numbers only (+91 / 10-digit mobile).
 * An international number THROWS — see assertSmsDeliverable above.
 * (Swap in Twilio or another provider there to actually serve them.)
 *
 * @param {string} phone  - Full phone number as stored (e.g. "+919876543210" or "+14155552671")
 * @param {string} otp    - Plain 6-digit OTP string to deliver
 */
export const sendSms = async ({ phone, otp, request_type }) => {
    //* Same gate the controllers run before charging the OTP quota, so the two
    //* cannot disagree. Still enforced here: guestCheckout.utils.js reaches
    //* sendSms without a pre-flight check (it swallows the throw on purpose).
    const mobileNumber = assertSmsDeliverable(phone);

    const BASE_FAST2SMS_URL='https://www.fast2sms.com/dev/bulkV2'
    const paramsObject= request_type =='password_reset' ?  {
    authorization: process.env.FAST2SMS_API_KEY,
    route: 'dlt',
    sender_id: process.env.FAST2SMS_SENDER_ID || '',
    message: process.env.FAST2SMS_PASSWORD_RESET_VERIFICATION_TEMPLATE_ID || '',
    variables_values: `${otp}|`,
    flash: 0,
    numbers: mobileNumber
  }:request_type=='phonenumber_verify' || request_type=='password_reset' ?  
   { 
      authorization: process.env.FAST2SMS_API_KEY,
      route: 'dlt',
      sender_id: process.env.FAST2SMS_SENDER_ID || '',
      message: process.env.FAST2SMS_PHONE_NUMBER_VERIFICATION_TEMPLATE_ID || '',
      variables_values: `${otp}|`,
      flash: 0,
      numbers: mobileNumber
    }:  {}  
    try {
        const response = await axios.get(BASE_FAST2SMS_URL, {
            params: paramsObject,
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
