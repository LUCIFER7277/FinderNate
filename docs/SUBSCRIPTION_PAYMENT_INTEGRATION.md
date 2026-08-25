# Subscription Payment Integration

> **This document previously described a Razorpay integration. That integration
> has been removed from the codebase. Cashfree is the only payment gateway.**
>
> The old contents are not merely out of date, they were actively harmful: they
> instructed operators to put `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` /
> `RAZORPAY_WEBHOOK_SECRET` into `.env` and to point a Razorpay dashboard webhook
> at `POST /api/v1/webhooks/razorpay`. That endpoint no longer exists, and setting
> those variables does nothing.

## Where subscription payments actually live

Everything is Cashfree. There is no second gateway and no fallback.

| Concern | Location |
| --- | --- |
| Gateway client (order create, status, checkout URL) | `src/config/cashfree.config.js` |
| Subscription order creation / verification / webhook | `src/controllers/subscription/payment.js` |
| Routes | `src/routes/subscription.routes.js` |
| Webhook signature verification | `src/utils/cashfreeWebhook.utils.js` |
| Subscription document | `src/models/subscription.models.js` |

### Endpoints

```
GET  /api/v1/subscription/plans            # available plans
GET  /api/v1/subscription/status           # caller's current subscription
POST /api/v1/subscription/create-order     # auth required — creates a Cashfree order
POST /api/v1/subscription/verify-payment   # auth required — confirms after redirect
POST /api/v1/subscription/webhook          # Cashfree S2S, no auth, signature-verified
```

### Environment

Only these gateway variables are read. There are no others.

```env
CASHFREE_APP_ID=...
CASHFREE_SECRET_KEY=...
CASHFREE_ENV=sandbox        # or: production
```

## Things worth knowing before you change this

- **Activation is one code path.** `activateSubscriptionForOrder` in
  `src/controllers/subscription/payment.js` is the only thing that grants a paid
  plan. A second, drifted copy of this logic used to exist in the Razorpay
  webhook; the two renewal paths diverged and only one of them ever got the
  month-overflow fix. Do not reintroduce a second writer — import
  `addOneMonth` rather than copying it.
- **Renewal extends, it does not replace.** Renewing a plan that is still
  running extends `endDate` from the existing `endDate`, not from `now`.
  Resetting to `now + 1 month` silently deletes days the user already paid for.
- **Replay is guarded by history, not by the latest receipt.**
  `Subscription.redeemedPaymentIds` records every gateway payment id ever
  redeemed. `paymentId` alone cannot answer "has this been used before?",
  because renewal overwrites it — and a paid Cashfree order stays `PAID`
  forever, so an old order id could otherwise be re-posted for a free month.
  That array may still contain legacy Razorpay `pay_*` ids; they are kept
  deliberately.

## Testing

Use Cashfree sandbox credentials (`CASHFREE_ENV=sandbox`). Verification is
server-side: `/verify-payment` asks Cashfree what the order's status is rather
than trusting anything the client sends, so there is no signature for a test
harness to forge — a real pass requires completing the hosted checkout.
