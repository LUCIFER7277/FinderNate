/**
 * Branded layout for transactional email.
 *
 * WHY THIS IS TABLE-BASED AND INLINE-STYLED, in 2026:
 * Outlook on Windows still renders mail through Microsoft Word's HTML engine,
 * which has no flexbox, no grid, and no reliable `max-width` on divs. Gmail
 * strips `<style>` blocks entirely in a few contexts (notably when forwarding
 * and in some Android webviews). So: nested tables for structure, every visual
 * rule inline, and `<style>` used only for progressive enhancement that the
 * message still reads correctly without.
 *
 * Colours are the app's own gold ramp (lib/core/constants/appColors.dart), and
 * they follow the contrast rule declared alongside those tokens: gold300–gold500
 * NEVER carry text on a light background because they fail WCAG badly. Text on a
 * gold surface is ink; gold text on white is gold700 or darker. The OTP itself
 * is therefore ink-on-gold-wash, not gold-on-white.
 */

// Local copy rather than an import from shareUtils.js: that module's escapeHtml
// is not exported, and an email template reaching into a link-preview helper for
// its escaping is the kind of coupling that gets one of them "cleaned up" later.
const escapeHtml = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

// ── Brand tokens ─────────────────────────────────────────────────────────────
const GOLD_500 = '#FDC700'; // primary surface
const GOLD_50 = '#FFFBEB';  // wash behind the code
// gold800, NOT gold700, for the footer link. The app's token file recommends
// "gold700 or darker" for gold text on white, but measured against white
// gold700 is only 3.22:1 — which clears WCAG AA for LARGE text (3:1) and fails
// it for body copy (4.5:1). The footer link is 12px, so it takes gold800 at
// 5.37:1. Worth knowing if that same rule gets applied to small text elsewhere.
const GOLD_800 = '#8A6414';
const INK = '#1A1A1A';
const MUTED = '#6B7280';
const BORDER = '#E0E0E0';
const PAGE_BG = '#F5F5F5';

/**
 * Wrap body content in the branded shell.
 *
 * @param {object}  opts
 * @param {string}  opts.title      Headline shown above the content.
 * @param {string}  opts.preheader  The grey line mail clients show next to the
 *                                  subject in the inbox list. Without one, they
 *                                  scrape the first text in the body — which for
 *                                  a code email means the inbox preview leaks
 *                                  the OTP itself onto a lock screen.
 * @param {string}  opts.bodyHtml   Pre-escaped inner HTML.
 * @returns {string}
 */
export const renderEmail = ({ title, preheader = '', bodyHtml }) => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<!-- Declares the mail as light-only. Gmail and Apple Mail auto-invert an
     unlabelled message in dark mode, which turns the gold header muddy and can
     drop the ink-on-gold contrast below legibility. -->
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(title)}</title>
<!--[if mso]>
<style type="text/css">
  body, table, td, p, a { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  /* Progressive enhancement only — the layout is already correct without it. */
  @media only screen and (max-width: 620px) {
    .fn-wrap { width: 100% !important; }
    .fn-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .fn-code { font-size: 30px !important; letter-spacing: 6px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:${PAGE_BG}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

<!-- Preheader: shown in the inbox list, never in the opened message. The
     zero-width joiners stop clients padding the preview with body text. -->
<div style="display:none; font-size:1px; color:${PAGE_BG}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">
${escapeHtml(preheader)}&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;&#8204;
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" class="fn-wrap" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px; max-width:600px; background-color:#FFFFFF; border:1px solid ${BORDER}; border-radius:12px; overflow:hidden;">

        <!-- Wordmark. Deliberately TEXT, not an image: most clients block
             remote images by default, so an <img> logo is a broken icon on
             first open — on the exact email where a user is deciding whether
             the message is genuine. -->
        <tr>
          <td align="center" style="background-color:${GOLD_500}; padding:22px 24px;">
            <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:23px; font-weight:700; letter-spacing:0.3px; color:${INK};">FinderNate</span>
          </td>
        </tr>

        <tr>
          <td class="fn-pad" style="padding:32px 40px 36px 40px; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <h1 style="margin:0 0 18px 0; font-size:20px; line-height:28px; font-weight:600; color:${INK};">${escapeHtml(title)}</h1>
            ${bodyHtml}
          </td>
        </tr>

        <tr>
          <td class="fn-pad" style="padding:20px 40px 26px 40px; border-top:1px solid ${BORDER}; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <p style="margin:0; font-size:12px; line-height:18px; color:${MUTED};">
              This is an automated message from FinderNate &mdash; please don't reply to it.
            </p>
            <p style="margin:8px 0 0 0; font-size:12px; line-height:18px; color:${MUTED};">
              &copy; FinderNate &middot; <a href="https://findernate.com" style="color:${GOLD_800}; text-decoration:underline;">findernate.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

// ── Body-content helpers ─────────────────────────────────────────────────────
//
// Every one of these takes PLAIN TEXT and escapes it. That is the point: the
// callers interpolate display names, admin remarks and product titles, and the
// previous hand-written templates dropped all of them straight into the markup
// unescaped. Making escaping the default — rather than something each call site
// remembers — is what stops the next email from reintroducing it.
//
// Nothing here is XSS in the browser sense; mail clients do not run scripts.
// The real damage is a name or a product title containing a stray `<` silently
// eating the rest of the message, or a crafted one closing the layout early and
// appending its own link under FinderNate's branding.

/** A body paragraph. */
export const emailParagraph = (text, { muted = false, topGap = 16 } = {}) =>
    `<p style="margin:${topGap}px 0 0 0; font-size:15px; line-height:23px; color:${muted ? MUTED : INK};">${escapeHtml(text)}</p>`;

/**
 * A call-to-action button.
 *
 * Built from a table cell, not a styled <a>: the Word engine behind Outlook on
 * Windows ignores padding on inline elements, so a padded anchor collapses to
 * bare underlined text there. A td with bgcolor and cellpadding renders
 * everywhere. Outlook drops the rounded corners and shows a square button,
 * which is the intended degradation.
 *
 * The URL is always accompanied by a visible plain-text copy at the call site —
 * a button whose target cannot be read is indistinguishable from a phishing
 * button, and some clients strip the link entirely.
 */
export const emailButton = ({ label, url }) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;">
              <tr>
                <td align="center" bgcolor="${GOLD_500}" style="background-color:${GOLD_500}; border-radius:8px;">
                  <a href="${escapeHtml(url)}" style="display:inline-block; padding:13px 30px; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; font-weight:600; line-height:20px; color:${INK}; text-decoration:none;">${escapeHtml(label)}</a>
                </td>
              </tr>
            </table>`;

/**
 * A label/value block — order number, amount, username and the like.
 * @param {Array<[string, string]>} rows
 */
export const emailDetails = (rows) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 0 0; background-color:${GOLD_50}; border:1px solid ${BORDER}; border-radius:10px;">
              ${rows.map(([label, value], i) => `<tr>
                <td style="padding:${i === 0 ? '16' : '0'}px 18px ${i === rows.length - 1 ? '16' : '10'}px 18px; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:19px; color:${MUTED};">${escapeHtml(label)}</td>
                <td align="right" style="padding:${i === 0 ? '16' : '0'}px 18px ${i === rows.length - 1 ? '16' : '10'}px 18px; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:19px; font-weight:600; color:${INK};">${escapeHtml(value)}</td>
              </tr>`).join('\n              ')}
            </table>`;

/**
 * A tinted notice. `tone: 'warning'` is for the internal action-required alert
 * — it is the one email a human is expected to act on, and it should not look
 * like the transactional mail around it in a busy inbox.
 */
export const emailCallout = (text, { tone = 'neutral' } = {}) => {
    const bg = tone === 'warning' ? '#FEF2F2' : GOLD_50;
    const edge = tone === 'warning' ? '#DC2626' : GOLD_500;
    return `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 0 0;">
              <tr>
                <td style="background-color:${bg}; border-left:4px solid ${edge}; border-radius:6px; padding:14px 18px; font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:21px; color:${INK};">${escapeHtml(text)}</td>
              </tr>
            </table>`;
};

/**
 * The one-time code, in its own tinted box.
 *
 * A table cell rather than a styled div so the Word engine behind Outlook still
 * renders the wash and the border. `user-select:all` lets a desktop user grab
 * the whole code in one click and is harmless where unsupported.
 */
export const emailCodeBlock = (code) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 0 0;">
              <tr>
                <td align="center" style="background-color:${GOLD_50}; border:1px solid ${GOLD_500}; border-radius:10px; padding:22px 16px;">
                  <div class="fn-code" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace; font-size:34px; line-height:42px; font-weight:700; letter-spacing:9px; text-indent:9px; color:${INK}; -webkit-user-select:all; user-select:all;">${escapeHtml(code)}</div>
                </td>
              </tr>
            </table>`;

/**
 * The one-time-code email, HTML and plain text.
 *
 * Both parts are returned because a message sent as HTML-only scores worse with
 * spam filters, and this account's mail was already landing in spam for an
 * unrelated reason (a From: domain with no aligned SPF/DKIM). Sending
 * multipart/alternative removes one more reason to be filtered — which matters
 * more here than on any other email, since a password-reset code in the spam
 * folder is an account someone cannot get back into.
 *
 * @param {object} opts
 * @param {string} opts.title       Headline, e.g. "Reset your password".
 * @param {string} opts.intro       One line of context above the code.
 * @param {string} opts.code        The OTP. Digits only, generated server-side.
 * @param {number} opts.expiryMs    Lifetime, taken from OTP_EXPIRY_MS so the
 *                                  copy cannot drift from the real value.
 * @param {string} opts.disclaimer  What to do if this wasn't you.
 * @returns {{html: string, text: string}}
 */
export const renderOtpEmail = ({ title, intro, code, expiryMs, disclaimer }) => {
    const minutes = Math.max(1, Math.round(expiryMs / 60000));
    const unit = minutes === 1 ? 'minute' : 'minutes';
    // Raw `code` — emailCodeBlock escapes it. Pre-escaping here would
    // double-encode anything non-alphanumeric the day a code format changes.
    const bodyHtml = `
            <p style="margin:0; font-size:15px; line-height:23px; color:${INK};">${escapeHtml(intro)}</p>
${emailCodeBlock(code)}

            <p style="margin:20px 0 0 0; font-size:14px; line-height:21px; color:${MUTED};">
              This code expires in <strong style="color:${INK};">${minutes} ${unit}</strong>.
            </p>
            <p style="margin:14px 0 0 0; font-size:14px; line-height:21px; color:${MUTED};">
              ${escapeHtml(disclaimer)}
            </p>
            <p style="margin:14px 0 0 0; font-size:13px; line-height:20px; color:${MUTED};">
              FinderNate staff will never ask you for this code.
            </p>`;

    // Wrapped at a sane width; some text-mode clients do not soft-wrap.
    const text = [
        title,
        '',
        intro,
        '',
        `Your code: ${code}`,
        '',
        `This code expires in ${minutes} ${unit}.`,
        disclaimer,
        'FinderNate staff will never ask you for this code.',
        '',
        '--',
        "This is an automated message from FinderNate — please don't reply to it.",
        'findernate.com',
    ].join('\n');

    return {
        html: renderEmail({
            title,
            // Says a code arrived WITHOUT putting the digits in the inbox
            // preview or on a lock screen.
            preheader: `Your FinderNate verification code is inside. It expires in ${minutes} ${unit}.`,
            bodyHtml,
        }),
        text,
    };
};

export { escapeHtml };
