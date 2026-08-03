import { ApiError } from "./ApiError.js";

// Proves the Cashfree transaction a caller quoted is actually the one a given
// order is waiting on, before any order state changes.
//
// Why this has to exist: both payment-verification endpoints
// (POST /payments/verify and POST /payments/store/verify) are mounted above
// `router.use(verifyJWT)`, so they are public, and each takes the transaction id
// from the request body. The handlers previously asked Cashfree "is transaction
// T paid?" and, on yes, marked whichever order the body named as settled —
// without ever checking that T was that order's transaction, or that the amount
// collected matched what the order costs.
//
// That let one genuine ₹1 purchase settle unlimited orders of any value: a real
// PAID transaction stays PAID forever and can be re-quoted against any pending
// order. Escrow was then credited from order.amount, backed by no money, and the
// seller was told to ship.
//
// Two independent bindings, both required:
//   order_id     — the transaction must be the one minted for THIS order.
//   order_amount — the gateway must have collected what the order says it costs,
//                  which also catches an order repriced after its link was minted.
//
// The legitimate path is unaffected: order.cashfreeOrderId is written at order
// creation and the Cashfree return URL carries that same id back as txnId, so
// they always agree. This also holds on the webhook-races-verify ordering,
// because the check runs against stored order state, not against who arrived first.
//
// Shared by both verify paths on purpose — a second copy would drift.
export const assertTransactionBelongsToOrder = (cfOrder, order) => {
    const quoted = String(cfOrder?.order_id ?? '');
    const expected = String(order?.cashfreeOrderId ?? '');

    if (!expected || !quoted || quoted !== expected) {
        throw new ApiError(400, "This payment does not belong to this order.");
    }

    // Cashfree returns a number and the order stores one. Compare in paise so a
    // legitimate 1299.50 is not rejected by float equality.
    const paidPaise = Math.round(Number(cfOrder?.order_amount ?? NaN) * 100);
    const duePaise = Math.round(Number(order?.amount ?? NaN) * 100);

    if (!Number.isFinite(paidPaise) || !Number.isFinite(duePaise) || paidPaise !== duePaise) {
        throw new ApiError(400, "Paid amount does not match this order.");
    }
};

export default assertTransactionBelongsToOrder;
