/**
 * Post Privacy Utility Functions
 * Handles post visibility based on account privacy and individual post privacy settings
 */

/**
 * Determines who can view a post based on account privacy and post privacy
 * @param {Object} post - Post object with settings.privacy field
 * @param {Object} postOwner - User object (post owner) with privacy and isFullPrivate fields
 * @param {Object} viewer - Current user viewing the post (null for anonymous)
 * @param {Array} viewerFollowing - Array of user IDs that the viewer is following
 * @param {Array} viewerFollowers - Array of user IDs that follow the viewer
 * @returns {boolean} - Whether the viewer can see this post
 */
export const canViewPost = (post, postOwner, viewer, viewerFollowing = [], viewerFollowers = []) => {
    if (!post || !postOwner) return false;

    // Post owner can always see their own posts
    if (viewer && viewer._id.toString() === postOwner._id.toString()) {
        return true;
    }

    // FULL PRIVATE MODE: Overrides all other privacy settings
    if (postOwner.isFullPrivate) {
        if (!viewer) return false; // Anonymous users cannot see any posts

        const viewerId = viewer._id.toString();
        const postOwnerId = postOwner._id.toString();

        // Only followers/following can see posts from full private accounts
        const isFollowing = viewerFollowing.includes(postOwnerId);
        const isFollowedBy = viewerFollowers.includes(postOwnerId);

        return isFollowing || isFollowedBy;
    }

    // NORMAL PRIVACY MODE: Use individual post privacy settings
    const postPrivacy = post.settings?.privacy || 'public';

    // If post is explicitly public, everyone can see it regardless of account privacy
    if (postPrivacy === 'public') {
        return true;
    }

    // If post is private, only followers/following can see it
    if (postPrivacy === 'private') {
        if (!viewer) return false; // Anonymous users cannot see private posts

        const viewerId = viewer._id.toString();
        const postOwnerId = postOwner._id.toString();

        // Check if viewer follows the post owner OR post owner follows the viewer
        const isFollowing = viewerFollowing.includes(postOwnerId);
        const isFollowedBy = viewerFollowers.includes(postOwnerId);

        return isFollowing || isFollowedBy;
    }

    return false;
};

/**
 * Filters an array of posts based on privacy settings and viewer permissions
 * @param {Array} posts - Array of posts (should be populated with userId)
 * @param {Object} viewer - Current user viewing the posts (null for anonymous)
 * @param {Array} viewerFollowing - Array of user IDs that the viewer is following
 * @param {Array} viewerFollowers - Array of user IDs that follow the viewer
 * @returns {Array} - Filtered posts that the viewer can see
 */
export const filterPostsByPrivacy = (posts, viewer, viewerFollowing = [], viewerFollowers = []) => {
    return posts.filter(post => {
        return canViewPost(post, post.userId, viewer, viewerFollowing, viewerFollowers);
    });
};

/**
 * Gets the default post privacy based on user's account privacy
 * @param {Object} user - User object with privacy field
 * @param {string} explicitPrivacy - Explicitly set privacy ('public', 'private', or null)
 * @returns {string} - 'public' or 'private'
 */
export const getDefaultPostPrivacy = (user, explicitPrivacy = null) => {
    if (explicitPrivacy && ['public', 'private'].includes(explicitPrivacy)) {
        return explicitPrivacy;
    }

    // Default to account privacy
    return user?.privacy || 'public';
};

/**
 * Determines post visibility level for UI display
 * @param {Object} post - Post object with settings.privacy field
 * @param {Object} postOwner - User object (post owner) with privacy and isFullPrivate fields
 * @returns {Object} - Visibility info for UI
 */
export const getPostVisibilityInfo = (post, postOwner) => {
    // Full private mode overrides everything
    if (postOwner?.isFullPrivate) {
        return {
            level: 'full-private',
            description: 'Full private account - visible to followers/following only',
            icon: '🔒'
        };
    }

    const postPrivacy = post.settings?.privacy || 'public';

    if (postPrivacy === 'public') {
        return {
            level: 'public',
            description: 'Visible to everyone',
            icon: '🌍'
        };
    }

    if (postPrivacy === 'private') {
        return {
            level: 'followers',
            description: 'Visible to followers and following only',
            icon: '👥'
        };
    }

    return {
        level: 'public',
        description: 'Visible to everyone',
        icon: '🌍'
    };
};