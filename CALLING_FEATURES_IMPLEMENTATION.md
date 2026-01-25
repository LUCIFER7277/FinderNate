# Calling Features Implementation - Paid vs Free Users

## Overview
This implementation adds subscription-based access control for calling features, restricting free users from accessing audio and video calls while granting unlimited access to paid users and business profiles.

## Requirements Implemented

### 1. Free Users
- ❌ **Cannot access audio calls**
- ❌ **Cannot access video calls**
- ✅ **Receive upgrade prompt when attempting to use call features**

### 2. Paid Users (Basic, Pro, Premium)
- ✅ **Unlimited audio calls**
- ✅ **Unlimited video calls**
- ✅ **Full calling feature access**

### 3. Business Users
- ✅ **Unlimited audio calls**
- ✅ **Unlimited video calls**
- ✅ **Full calling feature access**
- ✅ **Automatic access without subscription check**

## Files Modified/Created

### 1. User Model Enhancement
**File:** `src/models/user.models.js`

Added helper methods:
- `hasCallingAccess()` - Checks if user has calling features access
- `getSubscriptionTier()` - Returns user's subscription tier

```javascript
// Business profiles always have calling access
// Paid users (basic, pro, premium, business) have calling access
// Free users don't have calling access
```

### 2. Subscription Middleware
**File:** `src/middlewares/subscription.middleware.js` (New)

Created three middleware functions:
- `verifyCallingAccess` - Blocks free users from calling endpoints with detailed error
- `attachSubscriptionInfo` - Adds subscription info to request without blocking
- `getUserSubscription()` - Helper function to get user subscription details

The error response for free users includes:
```json
{
  "errorCode": "CALLING_FEATURE_RESTRICTED",
  "subscriptionTier": "free",
  "requiresUpgrade": true,
  "availablePlans": ["basic", "pro", "premium", "business"]
}
```

### 3. Subscription Controller
**File:** `src/controllers/subscription.controllers.js` (New)

Implemented endpoints:
- `GET /api/v1/subscription/status` - Get current subscription status
- `GET /api/v1/subscription/upgrade-prompt` - Get upgrade prompt with plan details
- `GET /api/v1/subscription/feature/:feature/access` - Check feature access
- `GET /api/v1/subscription/plans` - Get all available plans

### 4. Subscription Routes
**File:** `src/routes/subscription.routes.js` (New)

Registered subscription endpoints with JWT authentication.

### 5. Call Routes Update
**File:** `src/routes/call.routes.js`

Updated routes to include access control:
```javascript
// Restricted to paid users only
router.post('/initiate', verifyCallingAccess, initiateCall);
router.patch('/:callId/accept', verifyCallingAccess, acceptCall);

// No restriction (users can decline/end calls even if free)
router.patch('/:callId/decline', declineCall);
router.patch('/:callId/end', endCall);

// Attach subscription info for history/stats
router.get('/history', attachSubscriptionInfo, getCallHistory);
router.get('/active', attachSubscriptionInfo, getActiveCall);
router.get('/stats', attachSubscriptionInfo, getCallStats);
```

### 6. App Configuration
**File:** `src/app.js`

Registered subscription router:
```javascript
app.use("/api/v1/subscription", subscriptionRouter);
```

## API Endpoints

### Subscription Endpoints

#### 1. Get Subscription Status
```
GET /api/v1/subscription/status
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "subscription": {
      "userId": "...",
      "plan": "pro",
      "status": "active",
      "endDate": "2026-02-15T00:00:00.000Z"
    },
    "tier": "pro",
    "isBusinessProfile": false,
    "features": {
      "calling": {
        "hasAccess": true,
        "audioCall": true,
        "videoCall": true,
        "unlimited": true
      }
    }
  }
}
```

#### 2. Get Upgrade Prompt
```
GET /api/v1/subscription/upgrade-prompt?feature=calling
Authorization: Bearer <token>
```

Response for free users:
```json
{
  "success": true,
  "data": {
    "requiresUpgrade": true,
    "currentTier": "free",
    "hasAccess": false,
    "feature": "calling",
    "title": "Upgrade to unlock calling features",
    "message": "Audio and video calls are available for paid subscribers. Choose a plan to start calling your connections.",
    "benefits": [
      "Unlimited audio calls",
      "Unlimited video calls",
      "High-quality voice and video",
      "Group calling (coming soon)"
    ],
    "availablePlans": [
      {
        "id": "basic",
        "name": "Basic",
        "price": "$4.99/month",
        "features": [...],
        "recommended": false
      },
      {
        "id": "pro",
        "name": "Pro",
        "price": "$9.99/month",
        "features": [...],
        "recommended": true
      },
      // ... more plans
    ],
    "ctaText": "Upgrade Now",
    "ctaUrl": "/subscription/upgrade"
  }
}
```

#### 3. Check Feature Access
```
GET /api/v1/subscription/feature/calling/access
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "feature": "calling",
    "hasAccess": false,
    "currentTier": "free",
    "requiredTier": "basic",
    "isBusinessProfile": false,
    "requiresUpgrade": true
  }
}
```

#### 4. Get Available Plans
```
GET /api/v1/subscription/plans
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "plans": [
      {
        "id": "free",
        "name": "Free",
        "price": "$0/month",
        "features": [...],
        "limitations": [
          "No audio calls",
          "No video calls",
          "Ads supported"
        ]
      },
      // ... more plans
    ]
  }
}
```

### Call Endpoints Behavior

#### Initiate Call (Restricted)
```
POST /api/v1/calls/initiate
Authorization: Bearer <token>

Body:
{
  "receiverId": "...",
  "chatId": "...",
  "callType": "video" // or "voice"
}
```

**Free user response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Calling features are not available for free users. Please upgrade your subscription to access audio and video calls.",
  "data": {
    "errorCode": "CALLING_FEATURE_RESTRICTED",
    "subscriptionTier": "free",
    "requiresUpgrade": true,
    "availablePlans": ["basic", "pro", "premium", "business"]
  }
}
```

**Paid user response (201 Created):**
```json
{
  "success": true,
  "data": {
    "callId": "...",
    "status": "initiated",
    "callType": "video",
    // ... call details
  }
}
```

## Subscription Tiers

### Free (Default)
- No calling features
- Basic profile features
- Post updates
- Follow users
- Limited messaging

### Basic ($4.99/month)
- ✅ Unlimited audio calls
- ✅ Unlimited video calls
- Ad-free experience
- Priority support

### Pro ($9.99/month) - Recommended
- All Basic features
- Advanced profile customization
- Analytics dashboard
- Blue tick verification
- Early access to new features

### Premium ($14.99/month)
- All Pro features
- Unlimited storage
- Custom branding
- API access
- Dedicated account manager

### Business ($29.99/month)
- All Premium features
- Business profile tools
- Team collaboration
- Advanced analytics
- White-label options

## How It Works

### Access Control Flow

1. **User Authentication**
   - User sends request with JWT token
   - `verifyJWT` middleware authenticates user

2. **Subscription Check** (for calling endpoints)
   - `verifyCallingAccess` middleware checks subscription
   - Business profiles: ✅ Auto-approved
   - Paid subscriptions: ✅ Check active subscription
   - Free users: ❌ Blocked with upgrade prompt

3. **Call Initiation/Accept**
   - Only paid users and business profiles can initiate or accept calls
   - Free users receive 403 error with upgrade information

4. **Call Decline/End**
   - No restriction - all users can decline or end calls
   - This allows free users to reject incoming calls

### Frontend Integration

When a free user tries to access calling:

```javascript
// Example frontend code
try {
  await initiateCall({ receiverId, chatId, callType: 'video' });
} catch (error) {
  if (error.response?.data?.data?.errorCode === 'CALLING_FEATURE_RESTRICTED') {
    // Show upgrade prompt
    const upgradeInfo = await fetch('/api/v1/subscription/upgrade-prompt?feature=calling');
    showUpgradeModal(upgradeInfo);
  }
}
```

## Testing

### Test Cases

1. **Free User - Initiate Call**
   - ❌ Should return 403 with upgrade prompt

2. **Free User - Accept Call**
   - ❌ Should return 403 with upgrade prompt

3. **Free User - Decline Call**
   - ✅ Should work (no restriction)

4. **Free User - View Call History**
   - ✅ Should work (subscription info attached)

5. **Paid User - Initiate Call**
   - ✅ Should create call successfully

6. **Paid User - Accept Call**
   - ✅ Should accept call successfully

7. **Business Profile - Initiate Call**
   - ✅ Should work without subscription check

8. **Business Profile - Accept Call**
   - ✅ Should work without subscription check

## Database Schema

The existing `Subscription` model is used:
```javascript
{
  userId: ObjectId,
  plan: 'free' | 'basic' | 'pro' | 'premium' | 'business',
  status: 'active' | 'expired' | 'cancelled',
  startDate: Date,
  endDate: Date,
  paymentId: String,
  autoRenew: Boolean
}
```

## Security Considerations

1. **Server-Side Validation**: All subscription checks happen on the server
2. **JWT Authentication**: All endpoints require valid authentication
3. **Rate Limiting**: General rate limiting applies to all endpoints
4. **No Client Bypass**: Frontend cannot override subscription restrictions

## Future Enhancements

- [ ] Add group calling with tier-based participant limits
- [ ] Add call duration limits for Small Business tier (if needed)
- [ ] Add call quality settings based on subscription tier
- [ ] Track calling usage/analytics per user
- [ ] Add grace period for expired subscriptions
- [ ] WebSocket integration for real-time upgrade prompts

## Notes

- Business profiles (`isBusinessProfile: true`) automatically have calling access without needing a subscription
- Users can view their call history and stats regardless of subscription tier
- Free users can still decline or end calls (important for UX)
- The subscription check happens at the middleware level for clean separation of concerns
- Error responses include detailed information for frontend to show appropriate upgrade prompts
