import { ApiResponse } from "./ApiResponse.js";

/**
 * TOMBSTONES FOR DELETED CONTENT
 *
 * Deleting a post removes the row outright (post/delete.controllers.js), but the
 * things that POINT at it survive: payment links, checkout messages, orders,
 * notification deep links, and every share URL somebody already sent. Each of
 * those used to answer 404 — indistinguishable from a mistyped URL — and the
 * clients rendered a blank screen or an error toast for it.
 *
 * So every one of those callers now gets the SAME object back, and it says three
 * things unambiguously: that the thing existed, that it is gone, and what it
 * was. The clients switch on `deleted === true` and render `message`.
 *
 * ── RESPONSE SHAPE (mobile app + website both depend on this verbatim) ────────
 *   {
 *     deleted:        true,                 // always true when this object is present
 *     deletedReason:  "deleted_by_owner",   // DELETED_REASON, the only value today
 *     contentType:    "product" | "service" | "business" | "post" | "reel"
 *                     | "story" | null,     // null == the type could not be known
 *     contentId:      "<id>" | null,
 *     title:          "Product deleted",                      // short heading
 *     message:        "This product was deleted by the owner." // ready to render
 *   }
 *
 * `contentType` is null exactly where the type is genuinely unrecoverable — a
 * PaymentLink stores no discriminator, and the post that held one is gone — and
 * the wording degrades to "This item was deleted by the owner." rather than
 * guessing between product and service.
 *
 * ── HTTP STATUS ──────────────────────────────────────────────────────────────
 * READ endpoints answer 200: the caller legitimately holds a link, and a 404
 * there is exactly what produces today's blank screens. WRITE endpoints (create
 * an order, mint a share link) answer 410 Gone — the request genuinely cannot be
 * performed — but carry the identical body so the client can say the same thing.
 */

export const DELETED_REASON = 'deleted_by_owner';

// Every value `contentType` may take. `normal` is the Post schema's name for a
// plain post; nobody calls it that, so it is folded into "post".
const CONTENT_NOUNS = {
    product: 'product',
    service: 'service',
    business: 'business',
    post: 'post',
    reel: 'reel',
    story: 'story',
};

const normalizeContentType = (hint) => {
    const key = typeof hint === 'string' ? hint.trim().toLowerCase() : '';
    if (key === 'normal') return 'post';
    return CONTENT_NOUNS[key] ? key : null;
};

/**
 * Builds the tombstone. `contentType` accepts anything — an unknown or missing
 * hint degrades to the neutral "item" wording instead of naming the wrong thing.
 */
export const buildDeletedTombstone = ({ contentType = null, contentId = null } = {}) => {
    const type = normalizeContentType(contentType);
    const noun = type ? CONTENT_NOUNS[type] : 'item';

    return {
        deleted: true,
        deletedReason: DELETED_REASON,
        contentType: type,
        contentId: contentId ? String(contentId) : null,
        title: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted`,
        message: `This ${noun} was deleted by the owner.`,
    };
};

/**
 * Sends the tombstone.
 *
 * `extra` is merged INTO the tombstone for endpoint-specific keys the client
 * already reads on the happy path (linkId, actions.canProceedToPay, …), so a
 * page that reaches for one of those does not crash before it gets to check
 * `deleted`. It can never overwrite the marker fields — they are spread last.
 */
export const sendDeletedTombstone = (res, { contentType = null, contentId = null, status = 200, extra = {} } = {}) => {
    const tombstone = buildDeletedTombstone({ contentType, contentId });
    return res
        .status(status)
        .json(new ApiResponse(status, { ...extra, ...tombstone }, tombstone.message));
};
