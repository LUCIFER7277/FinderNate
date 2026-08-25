# Business Features Documentation

## Overview
This document explains the implementation of business features including priority posting, subscription-based calling, paid badges, and visibility rules.

---

## Table of Contents
1. [Business Post Priority System](#1-business-post-priority-system)
2. [Paid vs Free User Calling Features](#2-paid-vs-free-user-calling-features)
3. [Paid Plan Badge](#3-paid-plan-badge)
4. [Business Account Visibility Rule](#4-business-account-visibility-rule)
5. [Database Schema](#5-database-schema)
6. [API Endpoints](#6-api-endpoints)

---

## 1. Business Post Priority System

### Feature Description
Business accounts with active subscriptions get the highest priority for their posts, ads, and stories. Their content appears above normal posts and is prioritized in search results.

### Business Logic
- **Priority Ranking:**
  1. Business posts (active subscription)
  2. Normal user posts
  3. Reels

- **Visibility Rules:**
  - Business posts with active subscriptions appear first in feeds
  - Business posts appear in search results for related tags/categories
  - If both paid and free users post similar content, only paid business posts are visible
  - Business posts without active plans are hidden from ALL users (including followers)

### Implementation Location

#### Files:
- `src/controllers/business.controllers.js` - Business post creation and priority logic
- `src/controllers/post.controllers.js` - Post feed with priority sorting
- `src/controllers/searchAllContent.controllers.js` - Search with business priority
- `src/middlewares/subscription.middleware.js` - Subscription validation

#### Key Code Logic:
```javascript
// In post feed controller
const posts = await Post.find()
  .populate('author')
  .sort({ createdAt: -1 });

// Apply priority sorting
const prioritizedPosts = posts.sort((a, b) => {
  const aIsPaidBusiness = a.author.accountType === 'business' &&
                          a.author.subscriptionStatus === 'active';
  const bIsPaidBusiness = b.author.accountType === 'business' &&
                          b.author.subscriptionStatus === 'active';

  if (aIsPaidBusiness && !bIsPaidBusiness) return -1; # a comes before b
  if (!aIsPaidBusiness && bIsPaidBusiness) return 1; # b comes before a
  return 0;
});

// Filter out inactive business posts
const visiblePosts = prioritizedPosts.filter(post => {
  if (post.author.accountType === 'business') {
    return post.author.subscriptionStatus === 'active';
  }
  return true;
});
```

#### Database Fields:
- `User.accountType` - enum: ['normal', 'business']
- `User.subscriptionStatus` - enum: ['free', 'active', 'expired', 'cancelled']
- `User.subscriptionTier` - enum: ['free', 'paid', 'business']

---

## 2. Paid vs Free User Calling Features

### Feature Description
Audio and video calling features are restricted to paid users. Free users see an upgrade prompt when attempting to use call features.

### Business Logic
- **Free users:** Cannot access audio or video calls (blocked with upgrade prompt)
- **Paid users:** Unlimited audio + video calls
- **Business users:** Full calling features included

### Implementation Location

#### Files:
- `src/routes/call.routes.js` - Call routes with subscription middleware
- `src/middlewares/subscription.middleware.js` - Subscription check middleware
- `src/controllers/user.controllers.js` - User subscription status

#### Key Code Logic:
```javascript
// In call routes
router.post('/initiate-call',
  verifyJWT,
  checkSubscription(['paid', 'business']),
  initiateCall
);

// In subscription middleware
const checkSubscription = (allowedTiers) => {
  return async (req, res, next) => {
    const user = await User.findById(req.user._id);

    if (!allowedTiers.includes(user.subscriptionTier)) {
      return res.status(403).json({
        success: false,
        message: "Upgrade to paid plan to access calling features",
        upgradeRequired: true
      });
    }

    next();
  };
};

```

#### API Endpoints:
- `POST /api/calls/initiate-call` - Requires paid/business subscription
- `POST /api/calls/video-call` - Requires paid/business subscription
- `POST /api/calls/audio-call` - Requires paid/business subscription

---

## 3. Paid Plan Badge

### Feature Description
A visual badge displayed on paid and business accounts to help users identify premium accounts.

### Business Logic
- Badge appears on:
  - User profiles
  - Posts
  - Comments
  - Search results
  - Stories
  - Reels

### Implementation Location

#### Files:
- `src/models/user.models.js` - User schema with badge field
- `src/controllers/user.controllers.js` - User data serialization
- `src/controllers/post.controllers.js` - Post data with user badge
- `src/controllers/comment.controllers.js` - Comment data with user badge
- `src/utlis/userBadge.utils.js` - Badge utility functions

#### Key Code Logic:
```javascript
// In user model
const userSchema = new Schema({
  // ... other fields
  subscriptionTier: {
    type: String,
    enum: ['free', 'paid', 'business'],
    default: 'free'
  },
  hasPaidBadge: {
    type: Boolean,
    default: false
  }
});

// Virtual field or method to compute badge
userSchema.virtual('showBadge').get(function() {
  return this.subscriptionTier !== 'free';
});

// In response serialization
const serializeUser = (user) => {
  return {
    _id: user._id,
    username: user.username,
    avatar: user.avatar,
    accountType: user.accountType,
    hasPaidBadge: user.subscriptionTier !== 'free',
    // ... other fields
  };
};
```

#### Database Fields:
- `User.hasPaidBadge` - Boolean (computed from subscriptionTier)
- `User.subscriptionTier` - enum: ['free', 'paid', 'business']

---

## 4. Business Account Visibility Rule

### Feature Description
Business accounts without active subscriptions have ALL their content hidden from everyone, including followers.

### Business Logic
- **Active Subscription:** All content visible with priority
- **Inactive Subscription:**
  - All posts hidden
  - All stories hidden
  - All ads hidden
  - Profile still visible but shows "inactive" status
  - Even followers cannot see content
- **Instant Restoration:** Content becomes visible immediately upon subscription activation

### Implementation Location

#### Files:
- `src/controllers/post.controllers.js` - Post visibility filtering
- `src/controllers/business.controllers.js` - Business content filtering
- `src/controllers/reel.controllers.js` - Reel visibility filtering
- `src/middlewares/subscription.middleware.js` - Subscription status checks

#### Key Code Logic:
```javascript
// In post/content fetching
const getVisiblePosts = async (userId) => {
  const posts = await Post.find()
    .populate('author');

  // Filter out inactive business posts
  const visiblePosts = posts.filter(post => {
    // If author is business account
    if (post.author.accountType === 'business') {
      // Only show if subscription is active
      return post.author.subscriptionStatus === 'active';
    }
    // Show all non-business posts
    return true;
  });

  return visiblePosts;
};

// In user profile viewing
const getUserProfile = async (profileUserId, viewerUserId) => {
  const user = await User.findById(profileUserId);

  let posts = [];
  if (user.accountType === 'business') {
    if (user.subscriptionStatus === 'active') {
      posts = await Post.find({ author: profileUserId });
    }
    // If inactive, posts remain empty array
  } else {
    posts = await Post.find({ author: profileUserId });
  }

  return { user, posts };
};
```

#### Applies To:
- Feed posts
- Profile posts
- Stories
- Reels
- Ads
- Search results

---

## 5. Database Schema

### User Model Schema
```javascript
{
  username: String,
  email: String,
  accountType: {
    type: String,
    enum: ['normal', 'business'],
    default: 'normal'
  },
  subscriptionTier: {
    type: String,
    enum: ['free', 'paid', 'business'],
    default: 'free'
  },
  subscriptionStatus: {
    type: String,
    enum: ['free', 'active', 'expired', 'cancelled'],
    default: 'free'
  },
  subscriptionPlan: {
    planId: String,
    startDate: Date,
    endDate: Date,
    autoRenew: Boolean
  },
  hasPaidBadge: Boolean,
  // ... other fields
}
```

### Post Model Schema
```javascript
{
  author: {
    type: ObjectId,
    ref: 'User'
  },
  content: String,
  images: [String],
  tags: [String],
  category: String,
  isPriority: Boolean, // Computed based on author's subscription
  // ... other fields
}
```

---

## 6. API Endpoints

### Subscription Management
```
POST   /api/subscription/create          - Create new subscription
POST   /api/subscription/upgrade          - Upgrade subscription tier
POST   /api/subscription/cancel           - Cancel subscription
GET    /api/subscription/status           - Get current subscription status
POST   /api/subscription/renew            - Renew expired subscription
```

### Business Features
```
POST   /api/business/create-post          - Create priority business post
GET    /api/business/analytics            - Get business analytics
GET    /api/posts/feed                    - Get prioritized feed
GET    /api/search                        - Search with business priority
```

### Calling Features
```
POST   /api/calls/initiate-call           - Initiate call (paid only)
POST   /api/calls/video-call              - Start video call (paid only)
POST   /api/calls/audio-call              - Start audio call (paid only)
POST   /api/calls/end-call                - End active call
```

---

## Implementation Checklist

### Completed Features
- [x] User subscription schema
- [x] Subscription middleware
- [x] Business post priority system
- [x] Call feature restrictions
- [x] Paid badge implementation
- [x] Business visibility rules

### Testing Checklist
- [ ] Test business post priority in feed
- [ ] Test free user call blocking
- [ ] Test paid badge visibility
- [ ] Test business content hiding on subscription expiry
- [ ] Test content restoration on subscription renewal
- [ ] Test search results with business priority
- [ ] Test duplicate content filtering (paid vs free)

---

## Common Scenarios

### Scenario 1: Business User Posts Content
1. User creates post
2. System checks: `accountType === 'business'` and `subscriptionStatus === 'active'`
3. If valid → Post gets priority flag
4. Post appears at top of relevant feeds
5. Badge shows on post

### Scenario 2: Free User Attempts Call
1. User clicks call button
2. Backend receives request
3. Middleware checks `subscriptionTier`
4. Returns 403 with upgrade prompt
5. Frontend shows upgrade modal

### Scenario 3: Business Subscription Expires
1. Subscription status changes to 'expired'
2. All business posts filtered out in next fetch
3. User profile shows inactive status
4. Badge removed from all content
5. Call features disabled

### Scenario 4: User Upgrades Subscription
1. Payment processed successfully
2. `subscriptionStatus` → 'active'
3. `subscriptionTier` → 'paid' or 'business'
4. `hasPaidBadge` → true
5. Content immediately visible
6. Call features unlocked

---

## Environment Variables
```env
# Subscription settings
SUBSCRIPTION_CHECK_ENABLED=true
FREE_TIER_CALL_ENABLED=false
BUSINESS_PRIORITY_ENABLED=true

# Payment gateway — Cashfree is the only supported gateway
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key
CASHFREE_ENV=sandbox   # or: production
```

---

## Notes for Developers

1. **Always populate author** when fetching posts to access subscription status
2. **Check subscription status** before rendering any business content
3. **Apply filters at database level** when possible for performance
4. **Cache subscription status** for frequently accessed user data
5. **Handle subscription webhooks** for real-time status updates
6. **Test edge cases** like subscription expiring during active session

---

## Support & Maintenance

For questions or issues related to business features:
- Check middleware logs for subscription validation errors
- Verify user subscription status in database
- Test payment webhook integration
- Review post filtering logic in controllers

---

**Last Updated:** 2026-01-19
**Version:** 1.0
