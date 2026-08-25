# 🚀 Quick Start - Subscription System

## What Was Implemented

✅ **Subscription Expiry Cron Job** - Auto-expires subscriptions daily at 2 AM
✅ **Cashfree Subscription Webhook** - Handles payment events asynchronously
✅ **Monitoring & Logging** - Tracks all payments, subscriptions, and errors

> **Gateway note:** Cashfree is the only payment gateway. The Razorpay and
> PhonePe integrations were removed, along with `POST /api/v1/webhooks/razorpay`.
> `RAZORPAY_*` and `PHONEPE_*` environment variables are not read by anything.

---

## Key Files

1. `src/jobs/subscriptionExpiry.job.js` - Cron job for expiring subscriptions
2. `src/controllers/subscription/payment.js` - Cashfree order creation, verification, webhook
3. `src/config/cashfree.config.js` - Cashfree gateway client
4. `src/utils/cashfreeWebhook.utils.js` - Webhook signature verification
5. `src/routes/webhook.routes.js` - Non-payment webhooks only (Bunny Stream)
6. `src/utils/monitoring.utils.js` - Logging and monitoring utilities
7. `src/controllers/monitoring.controllers.js` - Monitoring API endpoints
8. `SUBSCRIPTION_SYSTEM_GUIDE.md` - Complete documentation

---

## Before Production Deployment

### 1️⃣ Set Cashfree Credentials (.env)

```bash
CASHFREE_APP_ID=YOUR_LIVE_APP_ID               # ← Change this!
CASHFREE_SECRET_KEY=YOUR_LIVE_SECRET_KEY       # ← Change this!
CASHFREE_ENV=production                        # ← Change this!
NODE_ENV=production                            # ← Change this!
```

### 2️⃣ Configure the Cashfree Webhook

In the Cashfree merchant dashboard, point the webhook at the endpoint for the
flow you are enabling:

```
https://yourdomain.com/api/v1/subscription/webhook       # subscriptions
https://yourdomain.com/api/v1/payments/webhook           # chat / escrow orders
https://yourdomain.com/api/v1/payments/cashfree/webhook  # online-store orders
```

All three verify the Cashfree signature and reject anything unsigned — the
signature is the only authentication these routes have.

### 3️⃣ Test Before Going Live

```bash
# Test monitoring dashboard
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://yourdomain.com/api/v1/subscription/monitoring/dashboard

# Manually trigger expiry job (verify cron works)
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  https://yourdomain.com/api/v1/subscription/monitoring/test-expiry-job
```

---

## How It Works

### Payment Flow (with Webhook Backup)

```
User clicks "Upgrade"
  ↓
Frontend calls: POST /subscription/create-order
  ↓
Get Cashfree order ID + checkoutUrl
  ↓
Redirect to the Cashfree hosted checkout
  ↓
User completes payment
  ↓
Frontend calls: POST /subscription/verify-payment ← Primary activation
  ↓
Subscription activated ✅

// Backup: If user closes window before verify-payment
Cashfree webhook: POST /subscription/webhook ← Webhook activation
  ↓
Subscription activated ✅
```

Both paths call the same `activateSubscriptionForOrder`. Keep it that way — a
second, drifted copy of this logic is exactly how the two renewal paths once
diverged and why only one of them got the month-overflow fix.

### Daily Expiry Check

```
Every day at 2:00 AM:
  ↓
Find all expired subscriptions (endDate < now)
  ↓
Update subscription status to 'expired'
  ↓
Downgrade business to plan1 (free)
  ↓
Clear cached feeds
  ↓
Log everything for audit
```

---

## Monitoring & Debugging

### Check Logs

```bash
# All logs are in logs/ directory
tail -f logs/payments.log        # Payment transactions
tail -f logs/subscriptions.log   # Subscription events
tail -f logs/errors.log          # Errors
```

### API Monitoring Endpoints

```bash
# Get metrics
GET /api/v1/subscription/monitoring/metrics

# Get payment logs
GET /api/v1/subscription/monitoring/payment-logs?lines=50

# Get subscription logs
GET /api/v1/subscription/monitoring/subscription-logs?lines=50

# Get error logs
GET /api/v1/subscription/monitoring/error-logs?lines=50

# Dashboard (combines all)
GET /api/v1/subscription/monitoring/dashboard
```

### Example Response: Metrics

```json
{
  "statusCode": 200,
  "data": {
    "totalPayments": 150,
    "successfulPayments": 142,
    "failedPayments": 8,
    "totalRevenue": 141858,
    "successRate": "94.67%",
    "subscriptionsByPlan": {
      "small_business": 95,
      "corporate": 47
    }
  }
}
```

---

## Test Endpoints (Development Only)

### Disable test endpoint in production

In `subscription.routes.js`, the test endpoint is already wrapped:

```javascript
if (process.env.NODE_ENV !== 'production') {
    router.post('/test-upgrade', testUpgradeSubscription);
}
```

This means `/subscription/test-upgrade` will NOT work in production. ✅

---

## What Each Component Does

| Component | Purpose | Critical? |
|-----------|---------|-----------|
| **Cron Job** | Auto-expire subscriptions | ⭐⭐⭐⭐⭐ CRITICAL |
| **Webhooks** | Handle payment events if user closes window | ⭐⭐⭐⭐⭐ CRITICAL |
| **Monitoring** | Debug issues, track metrics | ⭐⭐⭐⭐ Important |
| **Logging** | Audit trail, compliance | ⭐⭐⭐⭐ Important |

---

## Deployment Checklist

Before going to production:

- [ ] Update Cashfree keys to **live credentials** and set `CASHFREE_ENV=production`
- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Configure the webhook URLs in the Cashfree dashboard
- [ ] Test webhook endpoint is publicly accessible
- [ ] Verify cron jobs start on server boot
- [ ] Check logs directory is created (automatic)
- [ ] Test complete payment flow with test card
- [ ] Monitor first few real transactions closely

---

## Common Issues & Solutions

### "Payment gateway not configured"
→ Check `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` are set in `.env`

### "Invalid payment signature"
→ Check `CASHFREE_SECRET_KEY` is correct and matches `CASHFREE_ENV`
  (sandbox keys will not verify production callbacks, or vice versa)

### Webhook not activating subscription
→ Verify the webhook URL in the Cashfree dashboard
→ Confirm `express.json`'s raw-body capture is intact in `src/app.js` — the
  signature is computed over the raw body, so any middleware that consumes or
  rewrites it first will make every callback fail verification
→ Check server logs for webhook events

### Cron job not running
→ Check server logs for "Subscription expiry cron jobs started"
→ Manually test: `POST /subscription/monitoring/test-expiry-job`

### Logs not created
→ Check `logs/` directory exists (auto-created)
→ Verify file write permissions

---

## Quick Command Reference

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm run pm2:start:prod

# Check PM2 status
npm run pm2:status

# View logs
npm run pm2:logs

# Restart server
npm run pm2:restart
```

---

## Support

- Full Documentation: `SUBSCRIPTION_SYSTEM_GUIDE.md`
- Server Logs: `npm run pm2:logs`
- Monitoring API: `/api/v1/subscription/monitoring/dashboard`

**🎉 Your subscription system is ready for production!**

Just update the Cashfree credentials and configure the webhook.
