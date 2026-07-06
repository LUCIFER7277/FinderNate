# 🚀 Quick Start - Subscription System

## What Was Implemented

✅ **Subscription Expiry Cron Job** - Auto-expires subscriptions daily at 2 AM
✅ **Razorpay Webhook Handler** - Handles payment events asynchronously
✅ **Monitoring & Logging** - Tracks all payments, subscriptions, and errors

---

## Files Created/Modified

### New Files Created:
1. `src/jobs/subscriptionExpiry.job.js` - Cron job for expiring subscriptions
2. `src/controllers/webhook.controllers.js` - Razorpay webhook handler
3. `src/routes/webhook.routes.js` - Webhook routes
4. `src/utlis/monitoring.utils.js` - Logging and monitoring utilities
5. `src/controllers/monitoring.controllers.js` - Monitoring API endpoints
6. `SUBSCRIPTION_SYSTEM_GUIDE.md` - Complete documentation

### Modified Files:
1. `src/controllers/subscription.controllers.js` - Added logging
2. `src/routes/subscription.routes.js` - Added monitoring routes
3. `src/app.js` - Added webhook routes
4. `src/index.js` - Added cron job initialization
5. `package.json` - Added node-cron dependency

---

## Before Production Deployment

### 1️⃣ Update Razorpay Credentials (.env)

```bash
# Replace test keys with LIVE keys
RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY        # ← Change this!
RAZORPAY_KEY_SECRET=YOUR_LIVE_SECRET           # ← Change this!
RAZORPAY_WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET    # ← Set this!
NODE_ENV=production                            # ← Change this!
```

### 2️⃣ Configure Razorpay Webhook

1. Go to https://dashboard.razorpay.com/app/webhooks
2. Add webhook URL: `https://yourdomain.com/api/v1/webhooks/razorpay`
3. Select events: `payment.captured`, `payment.failed`, `order.paid`
4. Copy webhook secret to `.env`

### 3️⃣ Test Before Going Live

```bash
# Test webhook endpoint is accessible
curl https://yourdomain.com/api/v1/webhooks/test

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
Get Razorpay order ID
  ↓
Open Razorpay checkout
  ↓
User completes payment
  ↓
Frontend calls: POST /subscription/verify-payment ← Primary activation
  ↓
Subscription activated ✅

// Backup: If user closes window before verify-payment
Razorpay webhook: POST /webhooks/razorpay ← Webhook activation
  ↓
Subscription activated ✅
```

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

- [ ] Update Razorpay keys to **live credentials**
- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Configure webhook in Razorpay dashboard
- [ ] Test webhook endpoint is publicly accessible
- [ ] Verify cron jobs start on server boot
- [ ] Check logs directory is created (automatic)
- [ ] Test complete payment flow with test card
- [ ] Monitor first few real transactions closely

---

## Common Issues & Solutions

### "Payment gateway not configured"
→ Check `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set in `.env`

### "Invalid payment signature"
→ Check `RAZORPAY_KEY_SECRET` is correct

### Webhook not activating subscription
→ Verify webhook URL in Razorpay dashboard
→ Check `RAZORPAY_WEBHOOK_SECRET` is set
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

Just update the Razorpay credentials and configure the webhook.
