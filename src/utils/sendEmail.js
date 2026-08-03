import nodemailer from 'nodemailer';

/**
 * Send a transactional email.
 *
 * Returns a RESULT rather than throwing. Every caller (password-reset OTP,
 * email-change OTP, notifications, the guest-checkout claim link) sits on a
 * path where a bounced email must not take the whole operation down with it —
 * a failed claim email may not fail a payment that has already settled. But
 * the previous version swallowed the error and returned `undefined`, so those
 * callers reported success unconditionally and a silently dead mailbox was
 * indistinguishable from a delivered message. Check `success`.
 *
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export const sendEmail = async ({ to, subject, html }) => {
    // ⚠ SENDER DOMAIN MISMATCH — needs aligning.
    // Mail is sent as EMAIL_USER over Zoho, and that address is not on
    // findernate.com. A From: domain that does not match the product's domain
    // (and has no SPF/DKIM/DMARC alignment for it) is scored as spoofing by
    // Gmail and Outlook, so these messages land in spam or are rejected
    // outright — which for the guest-checkout claim link means the buyer never
    // learns how to set their password. Move sending to a findernate.com
    // mailbox and publish SPF + DKIM + DMARC for it.
    try {
        const transporter = nodemailer.createTransport({
            host: "smtp.zoho.com",
            port: 465,
            secure: true,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const info = await transporter.sendMail({
            from: `"FinderNate" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html,
        });

        return { success: true, messageId: info?.messageId };
    } catch (error) {
        // Still not thrown — but no longer invisible. Logged with the recipient
        // and subject so a delivery failure can actually be traced, and handed
        // back to the caller so it can decide what to do about it.
        console.error(`❌ Email send failed (to=${to}, subject="${subject}"):`, error);
        return { success: false, error: error?.message || 'Email send failed' };
    }
};
