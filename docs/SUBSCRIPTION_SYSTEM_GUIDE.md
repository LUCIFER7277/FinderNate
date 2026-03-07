# 🚀 Subscription System - Complete Production Guide

## 📋 Table of Contents
1. [Overview](#overview)
2. [Features Implemented](#features-implemented)
3. [Setup & Configuration](#setup--configuration)
4. [API Endpoints](#api-endpoints)
5. [Webhook Configuration](#webhook-configuration)
6. [Cron Jobs](#cron-jobs)
7. [Monitoring & Logging](#monitoring--logging)
8. [Testing Guide](#testing-guide)
9. [Production Deployment](#production-deployment)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The subscription system enables users to upgrade from free tier to paid plans (Small Business ₹999/mo, Corporate ₹2999/mo) with:
- Razorpay payment integration
- Automatic subscription expiry handling
- Webhook support for payment notifications
- Comprehensive logging and monitoring
- Cache invalidation on subscription changes

---

## Features Implemented

### ✅ Core Features
- **3-Tier Subscription Plans**: Free, Small Business (₹999/mo), Corporate (₹2999/mo)
- **Razorpay Payment Gateway**: Secure payment processing with signature verification
- **Subscription Management**: Create, upgrade, and expire subscriptions
- **Business Profile Sync**: Auto-sync subscription status with business profiles
- **Calling Features**: Audio/video calls restricted to paid users

### ✅ Production-Ready Features
- **Webhook Handler**: Processes Razorpay payment events asynchronously
- **Cron Jobs**: Auto-expire subscriptions and send renewal reminders
- **Monitoring System**: Comprehensive logging of payments, subscriptions, and errors
- **Cache Invalidation**: Auto-clear caches when subscription changes
- **Metrics Collection**: Track payment success rates and revenue

---

## Setup & Configuration

### 1. Environment Variables

Add these to your `.env` file:

```bash
# Razorpay Configuration
RAZORPAY_KEY_ID=rzp_test_YOUR_KEY_ID          # Test key (replace with live key in production)
RAZORPAY_KEY_SECRET=YOUR_KEY_SECRET            # Test secret (replace in production)
RAZORPAY_WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET    # For webhook signature verification

# Environment
NODE_ENV=development  # Change to 'production' in production
```

### 2. Install Dependencies

```bash
npm install node-cron razorpay
```

### 3. Database Indexes

The subscription system requires proper indexes. Run:

```bash
npm run db:indexes
```

---

## API Endpoints

### 📊 Subscription Information

#### Get Subscription Status
```http
GET /api/v1/subscription/status
Authorization: Bearer <token>
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "subscription": { /* subscription object */ },
    "tier": "small_business",
    "isBusinessProfile": true,
    "features": {
      "calling": {
        "hasAccess": true,
        "audioCall": true,
        "videoCall": true
      }
    }
  }
}
```

#### Get Available Plans
```http
GET /api/v1/subscription/plans
Authorization: Bearer <token>
```

#### Check Feature Access
```http
GET /api/v1/subscription/feature/:feature/access
Authorization: Bearer <token>
```

Example: `/api/v1/subscription/feature/calling/access`

### 💳 Payment Flow

#### Step 1: Create Razorpay Order
```http
POST /api/v1/subscription/create-order
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan": "small_business"  // or "corporate"
}
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "razorpayOrderId": "order_xyz",
    "razorpayKeyId": "rzp_test_...",
    "amount": 99900,  // in paise (₹999)
    "currency": "INR",
    "plan": "small_business",
    "planPrice": 999
  }
}
```

#### Step 2: Complete Payment on Frontend

Use Razorpay Checkout:

```javascript
const options = {
  key: response.razorpayKeyId,
  amount: response.amount,
  currency: response.currency,
  order_id: response.razorpayOrderId,
  name: "FinderNate",
  description: "Subscription Upgrade",
  handler: function(razorpayResponse) {
    // Send to backend for verification
    verifyPayment(razorpayResponse);
  }
};

const rzp = new Razorpay(options);
rzp.open();
```

#### Step 3: Verify Payment
```http
POST /api/v1/subscription/verify-payment
Authorization: Bearer <token>
Content-Type: application/json

{
  "razorpay_order_id": "order_xyz",
  "razorpay_payment_id": "pay_abc",
  "razorpay_signature": "signature_hash",
  "plan": "small_business"
}
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "subscription": { /* activated subscription */ },
    "business": { "plan": "plan2", "subscriptionStatus": "active" },
    "tier": "small_business",
    "features": { /* feature access */ },
    "message": "Successfully upgraded to Small Business plan!",
    "paymentId": "pay_abc"
  }
}
```

### 📊 Monitoring Endpoints

#### Get Monitoring Dashboard
```http
GET /api/v1/subscription/monitoring/dashboard
Authorization: Bearer <token>
```

#### Get Payment Logs
```http
GET /api/v1/subscription/monitoring/payment-logs?lines=50
Authorization: Bearer <token>
```

#### Get Subscription Logs
```http
GET /api/v1/subscription/monitoring/subscription-logs?lines=50
Authorization: Bearer <token>
```

#### Get Error Logs
```http
GET /api/v1/subscription/monitoring/error-logs?lines=50
Authorization: Bearer <token>
```

#### Get Metrics
```http
GET /api/v1/subscription/monitoring/metrics
Authorization: Bearer <token>
```

**Response:**
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

#### Test Expiry Job
```http
POST /api/v1/subscription/monitoring/test-expiry-job
Authorization: Bearer <token>
```

---

## Webhook Configuration

### 1. Setup Webhook in Razorpay Dashboard

1. Go to: https://dashboard.razorpay.com/app/webhooks
2. Click "Add New Webhook"
3. Enter webhook URL: `https://yourdomain.com/api/v1/webhooks/razorpay`
4. Select events:
   - ✅ payment.captured
   - ✅ payment.failed
   - ✅ order.paid
   - ✅ payment.authorized
5. Set webhook secret in `.env` as `RAZORPAY_WEBHOOK_SECRET`

### 2. Webhook Endpoint

```http
POST /api/v1/webhooks/razorpay
Content-Type: application/json
X-Razorpay-Signature: <signature>

{
  "event": "payment.captured",
  "payload": { /* payment data */ }
}
```

**Supported Events:**
- `payment.captured` - Payment successful (activates subscription)
- `payment.failed` - Payment failed (logs error)
- `order.paid` - Order marked as paid
- `payment.authorized` - Payment authorized (waiting for capture)
- `subscription.cancelled` - Subscription cancelled

### 3. Test Webhook

```http
GET /api/v1/webhooks/test
```

---

## Cron Jobs

### Subscription Expiry Job

**Schedule:** Every day at 2:00 AM (Asia/Kolkata timezone)

**What it does:**
1. Finds all expired subscriptions (endDate < now)
2. Updates subscription status to 'expired'
3. Downgrades business profiles to plan1 (free)
4. Updates business subscriptionStatus to 'pending'
5. Invalidates cache for affected users

**Location:** `src/jobs/subscriptionExpiry.job.js`

### Expiry Reminder Job

**Schedule:** Every day at 10:00 AM

**What it does:**
- Sends reminders 7, 3, and 1 day before subscription expiry
- Currently logs to console (implement email/push notification)

### Manual Testing

Run expiry check manually via API:
```http
POST /api/v1/subscription/monitoring/test-expiry-job
```

---

## Monitoring & Logging

### Log Files

All logs are stored in `logs/` directory:

- `logs/payments.log` - All payment transactions
- `logs/subscriptions.log` - Subscription lifecycle events
- `logs/errors.log` - Error tracking
- `logs/metrics.log` - Performance and business metrics

### Log Format

```json
{
  "timestamp": "2025-01-21T10:30:00.000Z",
  "level": "INFO",
  "message": "Payment Successful",
  "data": {
    "userId": "user123",
    "paymentId": "pay_abc",
    "orderId": "order_xyz",
    "plan": "small_business",
    "amount": 999,
    "status": "success"
  },
  "environment": "production"
}
```

### Metrics Tracked

- Total payment attempts
- Successful vs failed payments
- Total revenue
- Success rate percentage
- Subscriptions by plan tier

---

## Testing Guide

### 1. Test Payment Flow (Development)

Use test endpoint (only available in development):
```http
POST /api/v1/subscription/test-upgrade
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan": "small_business"
}
```

**⚠️ This endpoint is disabled in production!**

### 2. Test Razorpay Integration

Use Razorpay test cards:
- Success: `4111 1111 1111 1111`
- Failure: `4111 1111 1111 1112`

### 3. Test Webhook Locally

Use ngrok to expose local server:
```bash
ngrok http 3000
```

Then update webhook URL in Razorpay dashboard to ngrok URL.

### 4. Test Expiry Job

```http
POST /api/v1/subscription/monitoring/test-expiry-job
```

### 5. Test Cache Invalidation

1. Create subscription
2. Check logs for cache invalidation messages
3. Verify feeds are refreshed

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] Update Razorpay keys to **live credentials**
  ```bash
  RAZORPAY_KEY_ID=rzp_live_YOUR_LIVE_KEY
  RAZORPAY_KEY_SECRET=YOUR_LIVE_SECRET
  ```

- [ ] Set environment to production
  ```bash
  NODE_ENV=production
  ```

- [ ] Configure webhook URL in Razorpay dashboard
  ```
  https://yourdomain.com/api/v1/webhooks/razorpay
  ```

- [ ] Verify webhook secret is set
  ```bash
  RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
  ```

- [ ] Test payment flow end-to-end
- [ ] Verify cron jobs start on server boot
- [ ] Check log files are being created
- [ ] Monitor first few transactions closely

### Deployment Commands

```bash
# Build (if needed)
npm run build

# Start with PM2 (production)
npm run pm2:start:prod

# Check logs
npm run pm2:logs

# Monitor status
npm run pm2:status
```

### Post-Deployment Verification

1. **Check server started correctly:**
   ```bash
   curl https://yourdomain.com/health
   ```

2. **Verify cron jobs are running:**
   - Check server logs for: "✅ Subscription expiry cron jobs started"

3. **Test webhook endpoint:**
   ```bash
   curl https://yourdomain.com/api/v1/webhooks/test
   ```

4. **Monitor first payment:**
   - Watch logs in real-time: `npm run pm2:logs`
   - Check payment logs: `logs/payments.log`

---

## Troubleshooting

### Payment Creation Fails

**Symptom:** Error creating Razorpay order

**Solutions:**
1. Check Razorpay credentials are correct
2. Verify amount is in paise (multiply by 100)
3. Check Razorpay API status
4. Review error logs: `logs/errors.log`

### Payment Verification Fails

**Symptom:** "Invalid payment signature" error

**Solutions:**
1. Ensure `RAZORPAY_KEY_SECRET` is correct
2. Check signature calculation matches Razorpay format
3. Verify payment_id and order_id are correct
4. Review payment logs for details

### Webhook Not Working

**Symptom:** Payments succeed but subscription not activated

**Solutions:**
1. Verify webhook URL is correct in Razorpay dashboard
2. Check `RAZORPAY_WEBHOOK_SECRET` is set
3. Test webhook signature verification
4. Check server logs for webhook events
5. Ensure webhook endpoint is accessible publicly

### Cron Job Not Running

**Symptom:** Expired subscriptions not being processed

**Solutions:**
1. Check server logs for cron job initialization
2. Verify timezone is correct (default: Asia/Kolkata)
3. Manually trigger: `POST /api/v1/subscription/monitoring/test-expiry-job`
4. Check server is not being restarted frequently
5. Verify `node-cron` is installed

### Cache Not Invalidating

**Symptom:** Old subscription data showing in feeds

**Solutions:**
1. Check Redis connection
2. Verify cache keys match pattern: `fn:user:*:feed:*`
3. Check error logs for cache invalidation failures
4. Manually clear Redis: `redis-cli FLUSHDB`

### Logs Not Being Created

**Symptom:** No log files in `logs/` directory

**Solutions:**
1. Verify `logs/` directory exists (created automatically)
2. Check file write permissions
3. Verify monitoring utils are imported correctly
4. Check disk space

---

## Important Notes

### Security

- ✅ Webhook signature verification implemented
- ✅ Payment signature verification implemented
- ✅ JWT authentication on all routes
- ✅ No secrets exposed in code
- ✅ Proper input validation

### Best Practices

1. **Always verify payments** - Never trust client-side payment success
2. **Use webhooks** - Handle edge cases where user closes payment window
3. **Monitor logs** - Regularly check for failed payments
4. **Test thoroughly** - Use Razorpay test mode before going live
5. **Cache invalidation** - Always clear caches after subscription changes

### Financial Compliance

- All payment transactions are logged for audit trail
- Log retention: Consider implementing log rotation
- PCI compliance: Never log full card details
- Refunds: Implement refund tracking if needed

---

## Support & Maintenance

### Regular Tasks

**Daily:**
- Monitor payment success rate
- Check for failed payments
- Review error logs

**Weekly:**
- Analyze subscription metrics
- Check expiry reminder effectiveness
- Review webhook logs

**Monthly:**
- Revenue reconciliation with Razorpay
- Subscription churn analysis
- System performance review

### Need Help?

- Razorpay Documentation: https://razorpay.com/docs/
- Razorpay Support: https://razorpay.com/support/
- Server Logs: `npm run pm2:logs`
- Monitoring Dashboard: `/api/v1/subscription/monitoring/dashboard`

---

## Version History

**v1.0.0** (Current)
- ✅ Core subscription system
- ✅ Razorpay payment integration
- ✅ Webhook handler
- ✅ Cron jobs for expiry
- ✅ Monitoring and logging
- ✅ Cache invalidation

**Future Enhancements:**
- Email/SMS notifications for expiry reminders
- Auto-renewal support
- Promo codes and discounts
- Usage-based billing
- Invoice generation

---

## Quick Reference

### Key Files

```
src/
├── controllers/
│   ├── subscription.controllers.js    # Main subscription logic
│   ├── webhook.controllers.js         # Razorpay webhook handler
│   └── monitoring.controllers.js      # Monitoring endpoints
├── jobs/
│   └── subscriptionExpiry.job.js      # Cron jobs
├── routes/
│   ├── subscription.routes.js         # Subscription routes
│   └── webhook.routes.js              # Webhook routes
├── models/
│   ├── subscription.models.js         # Subscription schema
│   └── business.models.js             # Business schema
├── middlewares/
│   └── subscription.middleware.js     # Access control
└── utlis/
    └── monitoring.utils.js            # Logging utilities
```

### Environment Variables Summary

```bash
RAZORPAY_KEY_ID=rzp_live_XXX
RAZORPAY_KEY_SECRET=XXX
RAZORPAY_WEBHOOK_SECRET=XXX
NODE_ENV=production
```

---

**🎉 Your subscription system is production-ready!**

For questions or issues, check the troubleshooting section or review server logs.
