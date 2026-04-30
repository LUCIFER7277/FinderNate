# Frontend Changes Needed for Per-Post Privacy Control

## Quick Summary

**Key Feature:** Users can now set individual posts as Public or Private with a dedicated API endpoint.

**Main Frontend Changes:**
1. Add privacy selector to post creation modal
2. Add privacy toggle controls on profile posts section
3. Add privacy indicator icons to posts
4. Update API client to call new privacy endpoint

---

## Backend API Changes (Completed)

### New Endpoint: `PUT /posts/:postId/privacy`

**Purpose:** Toggle the privacy setting of an individual post

**Request:**
```javascript
PUT /api/posts/:postId/privacy
Headers: {
  Authorization: "Bearer <token>"
}
Body: {
  "privacy": "public" | "private"
}
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "postId": "64abc123...",
    "privacy": "private",
    "post": { /* full post object */ }
  },
  "message": "Post privacy updated to private",
  "success": true
}
```

**Error Cases:**
- `400`: Invalid privacy value (must be 'public' or 'private')
- `401`: User not authenticated
- `403`: User doesn't own the post
- `404`: Post not found

---

## Frontend Implementation Guide

### 1. Update API Client (`src/api/post.ts` or similar)

The frontend already has a `togglePostPrivacy` function defined. Verify it matches this implementation:

```typescript
// src/api/post.ts
export const togglePostPrivacy = async (
  postId: string,
  privacy: 'private' | 'public'
) => {
  const response = await axios.put(`/posts/${postId}/privacy`, { privacy });
  return response.data;
};
```

---

### 2. Add Privacy Selector to Post Creation Modal

**File:** `src/components/CreatePostModal.tsx` (or equivalent)

**Current Issue:** Privacy is hardcoded to 'public' in settings

**Required Changes:**

```typescript
// Add state for privacy selection
const [postPrivacy, setPostPrivacy] = useState<'public' | 'private'>('public');

// Add UI component (example using a toggle or select)
<div className="privacy-selector">
  <label>Who can see this post?</label>
  <select
    value={postPrivacy}
    onChange={(e) => setPostPrivacy(e.target.value as 'public' | 'private')}
  >
    <option value="public">Public</option>
    <option value="private">Private</option>
  </select>
  <p className="help-text">
    {postPrivacy === 'public'
      ? 'Everyone can see this post'
      : 'Only your followers can see this post'}
  </p>
</div>

// Update post creation to use selected privacy
const postData = {
  postType: 'photo',
  caption: caption,
  // ... other fields
  settings: {
    visibility: 'public',
    privacy: postPrivacy,  // Use selected value instead of hardcoded 'public'
    allowComments: true,
    allowLikes: true,
  }
};
```

**Recommended UI Styles:**
- Use a globe icon for "Public"
- Use a lock icon for "Private"
- Consider using a toggle switch or radio buttons for better UX

---

### 3. Add Privacy Toggle to Profile Posts Section

**File:** `src/components/ProfilePostsSection.tsx` (or equivalent)

**Current Issue:** Privacy toggle state exists but no UI implementation

**Required Changes:**

Add a context menu or button to each post card:

```typescript
import { togglePostPrivacy } from '@/api/post';
import { useState } from 'react';

const ProfilePostCard = ({ post, onPrivacyChange }) => {
  const [isChangingPrivacy, setIsChangingPrivacy] = useState(false);

  const handlePrivacyToggle = async () => {
    const newPrivacy = post.settings.privacy === 'public' ? 'private' : 'public';

    setIsChangingPrivacy(true);
    try {
      await togglePostPrivacy(post._id, newPrivacy);
      onPrivacyChange(post._id, newPrivacy); // Update local state
      toast.success(`Post is now ${newPrivacy}`);
    } catch (error) {
      toast.error('Failed to update post privacy');
      console.error(error);
    } finally {
      setIsChangingPrivacy(false);
    }
  };

  return (
    <div className="post-card">
      {/* Existing post content */}

      {/* Add privacy toggle button */}
      <button
        onClick={handlePrivacyToggle}
        disabled={isChangingPrivacy}
        className="privacy-toggle-btn"
      >
        {isChangingPrivacy ? 'Updating...' :
          post.settings.privacy === 'public' ? 'Make Private' : 'Make Public'}
      </button>

      {/* Or use a dropdown menu */}
      <DropdownMenu>
        <DropdownMenuItem onClick={handlePrivacyToggle}>
          {post.settings.privacy === 'public' ? (
            <>🔒 Make Private</>
          ) : (
            <>🌐 Make Public</>
          )}
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
};
```

**Best Practice:**
- Show the toggle only on the user's own profile (not on other users' profiles)
- Add confirmation dialog when changing from public to private
- Update the post list locally after successful API call

---

### 4. Add Privacy Indicator Icons to Posts

**Files:** Any component that displays posts (feed, profile grid, post detail)

**Purpose:** Show users which posts are private vs public

```typescript
const PrivacyIndicator = ({ privacy }) => {
  if (privacy === 'private') {
    return (
      <div className="privacy-badge private">
        🔒 Private
      </div>
    );
  }

  return (
    <div className="privacy-badge public">
      🌐 Public
    </div>
  );
};

// Usage in post card
<div className="post-header">
  <span className="post-author">{post.userId.username}</span>
  <PrivacyIndicator privacy={post.settings.privacy || 'public'} />
</div>
```

**Styling Recommendations:**
```css
.privacy-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.privacy-badge.private {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.privacy-badge.public {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
}
```

---

### 5. Update State Management

If using Redux/Context for post state:

```typescript
// Action
const updatePostPrivacy = (postId: string, privacy: 'public' | 'private') => ({
  type: 'UPDATE_POST_PRIVACY',
  payload: { postId, privacy }
});

// Reducer
case 'UPDATE_POST_PRIVACY':
  return {
    ...state,
    posts: state.posts.map(post =>
      post._id === action.payload.postId
        ? {
            ...post,
            settings: {
              ...post.settings,
              privacy: action.payload.privacy
            }
          }
        : post
    )
  };
```

---

### 6. Handle Privacy in Post Filtering

Private posts should only be visible to:
- The post owner (always)
- Users who follow the post owner
- Users who are followed by the post owner

The backend already handles this filtering, but the frontend should:

```typescript
// When displaying posts from API
const displayPosts = posts.filter(post => {
  // If viewing own profile, show all posts
  if (post.userId._id === currentUserId) {
    return true;
  }

  // Otherwise, backend already filtered based on privacy
  // Just display what the API returns
  return true;
});
```

---

## Complete Example: Privacy Control in Profile

```typescript
// ProfilePostsSection.tsx
import { useState } from 'react';
import { togglePostPrivacy } from '@/api/post';

const ProfilePostsSection = ({ userId, isOwnProfile }) => {
  const [posts, setPosts] = useState([]);

  const handlePrivacyChange = async (postId: string, newPrivacy: 'public' | 'private') => {
    try {
      await togglePostPrivacy(postId, newPrivacy);

      // Update local state
      setPosts(prevPosts =>
        prevPosts.map(post =>
          post._id === postId
            ? { ...post, settings: { ...post.settings, privacy: newPrivacy } }
            : post
        )
      );

      toast.success(`Post is now ${newPrivacy}`);
    } catch (error) {
      toast.error('Failed to update privacy');
    }
  };

  return (
    <div className="posts-grid">
      {posts.map(post => (
        <div key={post._id} className="post-card">
          {/* Post content */}
          <img src={post.mediaUrls[0]} alt={post.caption} />

          {/* Privacy indicator */}
          <div className="post-overlay">
            {post.settings.privacy === 'private' && (
              <span className="privacy-icon">🔒</span>
            )}
          </div>

          {/* Privacy toggle (only on own profile) */}
          {isOwnProfile && (
            <button
              className="privacy-toggle"
              onClick={() => handlePrivacyChange(
                post._id,
                post.settings.privacy === 'public' ? 'private' : 'public'
              )}
            >
              {post.settings.privacy === 'public' ? 'Make Private' : 'Make Public'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
```

---

## Testing Checklist

- [ ] Privacy selector appears in post creation modal
- [ ] Privacy selector defaults to 'public'
- [ ] Privacy selector updates post settings correctly
- [ ] Privacy toggle button appears on own profile posts only
- [ ] Privacy toggle successfully changes post privacy
- [ ] Privacy indicator icons display correctly
- [ ] Private posts show lock icon
- [ ] Public posts show globe icon (optional)
- [ ] Error handling works for failed privacy updates
- [ ] Loading states display during privacy changes
- [ ] Private posts are not visible to non-followers
- [ ] Private posts are visible to followers/following users
- [ ] Post owner can always see their own private posts

---

## Migration Notes

### Existing Posts
All existing posts will default to:
- `privacy: 'public'` if not set
- `isPrivacyTouched: false`

### Data Consistency
The backend ensures:
- Privacy values can only be 'public' or 'private'
- Invalid values are rejected with 400 error
- Cache invalidation happens automatically when privacy changes

### Performance
- Privacy changes invalidate relevant caches
- Feed regeneration happens automatically
- No additional frontend optimizations needed

---

## API Endpoint Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/posts/create/normal` | Create post with initial privacy |
| `PUT` | `/posts/:postId/privacy` | Toggle post privacy |
| `PUT` | `/posts/edit/:postId` | Edit post (can also change privacy) |
| `GET` | `/posts/:postId` | Get post (respects privacy) |
| `GET` | `/posts/user/:userId/profile` | Get user posts (filtered by privacy) |

---

## Questions or Issues?

If you encounter any issues implementing these changes:

1. Verify the backend endpoint is accessible: `PUT /api/posts/:postId/privacy`
2. Check authentication token is being sent
3. Ensure privacy value is exactly 'public' or 'private' (lowercase)
4. Check browser console for API errors
5. Verify post ownership (users can only change their own posts)

Backend implementation is complete and tested. Frontend changes are required to enable the UI functionality.
