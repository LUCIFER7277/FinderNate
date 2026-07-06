# Subscription Payment Integration with Razorpay

## Overview

The subscription system now uses **real Razorpay payment integration** instead of the test endpoint. Users must complete payment before upgrading to paid plans (Small Business or Corporate).

---

## What Changed

### Before (Test Endpoint)
```
POST /api/v1/subscription/test-upgrade
Body: { "plan": "small_business" }
✅ Instant upgrade without payment
```

### After (Razorpay Integration)
```
1. POST /api/v1/subscription/create-order
   Body: { "plan": "small_business" }
   Returns: razorpayOrderId, razorpayKeyId, amount

2. Frontend: Open Razorpay checkout with order details

3. POST /api/v1/subscription/verify-payment
   Body: {
     "razorpay_order_id": "...",
     "razorpay_payment_id": "...",
     "razorpay_signature": "...",
     "plan": "small_business"
   }
   ✅ Subscription activated after payment verification
```

---

## API Endpoints

### 1. Create Subscription Order
**Endpoint:** `POST /api/v1/subscription/create-order`
**Auth:** Required (verifyJWT)
**Description:** Creates a Razorpay order for subscription upgrade

**Request Body:**
```json
{
  "plan": "small_business"  // or "corporate"
}
```

**Response (200):**
```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "razorpayOrderId": "order_NXj7aBcDeFgHiJ",
    "razorpayKeyId": "rzp_test_xxxxxxxxxxxxx",
    "amount": 99900,  // ₹999 in paise
    "currency": "INR",
    "plan": "small_business",
    "planName": "Small Business",
    "planPrice": 999
  },
  "message": "Razorpay order created for subscription"
}
```

---

### 2. Verify Subscription Payment
**Endpoint:** `POST /api/v1/subscription/verify-payment`
**Auth:** Required (verifyJWT)
**Description:** Verifies payment and activates subscription

**Request Body:**
```json
{
  "razorpay_order_id": "order_NXj7aBcDeFgHiJ",
  "razorpay_payment_id": "pay_NXj7aBcDeFgHiJ",
  "razorpay_signature": "abc123def456...",
  "plan": "small_business"
}
```

**Response (200):**
```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "subscription": {
      "_id": "...",
      "userId": "...",
      "plan": "small_business",
      "status": "active",
      "startDate": "2026-01-21T10:00:00.000Z",
      "endDate": "2026-02-21T10:00:00.000Z",
      "paymentId": "pay_NXj7aBcDeFgHiJ"
    },
    "business": {
      "plan": "plan2",
      "subscriptionStatus": "active"
    },
    "tier": "small_business",
    "features": {
      "calling": {
        "hasAccess": true,
        "audioCall": true,
        "videoCall": true,
        "unlimited": true
      }
    },
    "message": "Successfully upgraded to Small Business plan!",
    "paymentId": "pay_NXj7aBcDeFgHiJ"
  },
  "message": "Subscription activated successfully"
}
```

---

## Subscription Plans & Pricing

| Plan | ID | Price | Features |
|------|-----|-------|----------|
| Free | `free` | ₹0 | Basic features, limited posts |
| Small Business | `small_business` | ₹999/month | Unlimited posts, calling, analytics |
| Corporate | `corporate` | ₹2999/month | All features, API access, dedicated support |

---

## Frontend Integration Example

```javascript
// Step 1: Create Razorpay order
const createSubscriptionOrder = async (plan) => {
  const response = await fetch('/api/v1/subscription/create-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ plan })
  });

  const data = await response.json();
  return data.data;
};

// Step 2: Open Razorpay checkout
const initiatePayment = async (plan) => {
  const orderData = await createSubscriptionOrder(plan);

  const options = {
    key: orderData.razorpayKeyId,
    amount: orderData.amount,
    currency: orderData.currency,
    name: 'FinderNate',
    description: `${orderData.planName} Subscription`,
    order_id: orderData.razorpayOrderId,
    handler: async (response) => {
      // Step 3: Verify payment
      await verifyPayment({
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
        plan: plan
      });
    },
    prefill: {
      name: user.fullName,
      email: user.email,
      contact: user.phoneNumber
    },
    theme: {
      color: '#3399cc'
    }
  };

  const rzp = new Razorpay(options);
  rzp.open();
};

// Step 3: Verify payment
const verifyPayment = async (paymentData) => {
  const response = await fetch('/api/v1/subscription/verify-payment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(paymentData)
  });

  const data = await response.json();

  if (data.success) {
    alert('Subscription upgraded successfully!');
    // Refresh user subscription status
  }
};

// Usage
initiatePayment('small_business');
```

---

## Security Features

### 1. Signature Verification
All payments are verified using HMAC-SHA256 signature:
```javascript
const expectedSignature = crypto
  .createHmac("sha256", RAZORPAY_KEY_SECRET)
  .update(razorpay_order_id + "|" + razorpay_payment_id)
  .digest("hex");

if (expectedSignature !== razorpay_signature) {
  throw new Error("Invalid payment signature");
}
```

### 2. Authentication
- All endpoints require valid JWT token
- User identity is verified before processing payment

### 3. Business Model Sync
- Updates both `Subscription` model and `Business` model
- Ensures consistency across the platform

### 4. Cache Invalidation
- Automatically invalidates feed caches after subscription change
- Ensures business posts appear/disappear immediately

---

## Subscription Features by Plan

### Free (₹0)
- ❌ No calling features
- ❌ Limited posts (10/month)
- ✅ Basic profile
- ✅ Community support

### Small Business (₹999/month)
- ✅ **Audio & Video Calling**
- ✅ Unlimited posts
- ✅ Advanced analytics
- ✅ Product catalog (50 items)
- ✅ Priority support
- ✅ Basic advertising tools

### Corporate (₹2999/month)
- ✅ **Audio & Video Calling**
- ✅ Everything unlimited
- ✅ Advanced analytics & insights
- ✅ Unlimited product catalog
- ✅ Dedicated account manager
- ✅ Advanced advertising
- ✅ API access
- ✅ White-label options

---

## Test Endpoint (Deprecated)

The old test endpoint is still available but **should not be used in production**:

```
POST /api/v1/subscription/test-upgrade
Body: { "plan": "small_business" }
```

**⚠️ Warning:** This endpoint bypasses payment and should only be used for development/testing purposes.

---

## What Happens After Payment

1. **Payment Verification** - Razorpay signature is validated
2. **Subscription Created/Updated** - Database record created with:
   - Active status
   - Start date (now)
   - End date (1 month from now)
   - Payment ID stored
3. **Business Model Updated** - If user has business profile:
   - Plan updated (plan2/plan3)
   - Subscription status set to "active"
4. **Cache Invalidated** - All feed caches cleared for immediate effect
5. **Features Unlocked** - User gets access to:
   - Calling features
   - Unlimited posts
   - Advanced analytics
   - Other premium features

---

## Error Handling

### Invalid Payment Signature
```json
{
  "success": false,
  "statusCode": 400,
  "message": "Invalid payment signature"
}
```

### Invalid Plan
```json
{
  "success": false,
  "statusCode": 400,
  "message": "Invalid plan. Must be one of: small_business, corporate"
}
```

### Missing Fields
```json
{
  "success": false,
  "statusCode": 400,
  "message": "Missing required payment verification fields"
}
```

---

## Environment Variables Required

Make sure these are set in your `.env` file:

```env
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_secret_key_here
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret (optional)
FRONTEND_URL=https://findernate.com
```

---

## Migration Guide for Existing Code

If you have existing code using the test endpoint, update it:

### Old Code (Test Endpoint)
```javascript
const upgradeSubscription = async (plan) => {
  await fetch('/api/v1/subscription/test-upgrade', {
    method: 'POST',
    body: JSON.stringify({ plan })
  });
};
```

### New Code (Razorpay Integration)
```javascript
const upgradeSubscription = async (plan) => {
  // 1. Create order
  const orderData = await fetch('/api/v1/subscription/create-order', {
    method: 'POST',
    body: JSON.stringify({ plan })
  }).then(r => r.json());

  // 2. Open Razorpay
  const rzp = new Razorpay({
    key: orderData.data.razorpayKeyId,
    amount: orderData.data.amount,
    order_id: orderData.data.razorpayOrderId,
    handler: async (response) => {
      // 3. Verify payment
      await fetch('/api/v1/subscription/verify-payment', {
        method: 'POST',
        body: JSON.stringify({
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
          plan: plan
        })
      });
    }
  });
  rzp.open();
};
```

---

## Testing Checklist

- [ ] Test Small Business plan upgrade with real payment
- [ ] Test Corporate plan upgrade with real payment
- [ ] Test payment failure scenarios
- [ ] Test signature verification
- [ ] Verify subscription is created in database
- [ ] Verify business model is updated
- [ ] Verify cache is invalidated
- [ ] Verify calling features are unlocked
- [ ] Test with Razorpay test cards
- [ ] Test payment verification with invalid signature

---

## Razorpay Test Cards

Use these for testing:

| Card Type | Card Number | CVV | Expiry | Result |
|-----------|-------------|-----|--------|--------|
| Success | 4111 1111 1111 1111 | Any | Future | Payment Success |
| Failure | 4000 0000 0000 0002 | Any | Future | Payment Failed |

---

## Summary

✅ **Real Razorpay Integration** - No more test endpoints for production
✅ **Secure Payment Flow** - HMAC-SHA256 signature verification
✅ **Automatic Feature Unlock** - Calling and premium features enabled immediately
✅ **Database Sync** - Subscription and Business models updated
✅ **Cache Management** - Feed caches invalidated automatically
✅ **Guest Checkout Support** - Already implemented for product payments
✅ **Webhook Ready** - System supports Razorpay webhooks (optional)

Your subscription system is now production-ready with real payment processing! 🚀
