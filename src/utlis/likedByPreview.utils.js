/**
 * Utility function to generate "Liked by" preview information
 * similar to Instagram's like display
 */

/**
 * Determines which user to show in the "Liked by..." text
 * Prioritizes followers/following, then falls back to first liker
 *
 * @param {Array} likedByUsers - Array of user objects who liked the post [{_id, username, fullName, profileImageUrl}]
 * @param {String} currentUserId - ID of the user viewing the post
 * @param {Array} userFollowing - Array of user IDs that current user is following
 * @param {Array} userFollowers - Array of user IDs that follow the current user
 * @returns {Object} { previewUser, othersCount, likedByText }
 */
const getLikedByPreview = (likedByUsers, currentUserId, userFollowing = [], userFollowers = []) => {
  // If no likes, return null
  if (!likedByUsers || likedByUsers.length === 0) {
    return {
      previewUser: null,
      othersCount: 0,
      likedByText: null
    };
  }

  // Convert ObjectIds to strings for comparison
  const followingIds = userFollowing.map(id => id.toString());
  const followerIds = userFollowers.map(id => id.toString());

  // Combine followers and following into one set for easier lookup
  const connectionIds = new Set([...followingIds, ...followerIds]);

  let previewUser = null;

  // First, try to find a follower/following who liked the post
  const connectionWhoLiked = likedByUsers.find(user =>
    connectionIds.has(user._id.toString())
  );

  if (connectionWhoLiked) {
    // Prefer showing a follower/following
    previewUser = connectionWhoLiked;
  } else {
    // Fall back to the first person who liked (most recent or first in list)
    previewUser = likedByUsers[0];
  }

  // Calculate how many others liked (total - 1 for the preview user)
  const othersCount = likedByUsers.length - 1;

  // Generate the "Liked by" text
  let likedByText = null;
  if (previewUser) {
    if (othersCount === 0) {
      // Only one person liked
      likedByText = `Liked by ${previewUser.username}`;
    } else if (othersCount === 1) {
      // Two people liked
      likedByText = `Liked by ${previewUser.username} and 1 other`;
    } else {
      // Multiple people liked
      likedByText = `Liked by ${previewUser.username} and ${othersCount} others`;
    }
  }

  return {
    previewUser: previewUser ? {
      _id: previewUser._id,
      username: previewUser.username,
      fullName: previewUser.fullName,
      profileImageUrl: previewUser.profileImageUrl
    } : null,
    othersCount,
    likedByText
  };
};

/**
 * Batch process liked by preview for multiple posts
 *
 * @param {Array} posts - Array of posts with their likedBy users
 * @param {String} currentUserId - ID of the user viewing the posts
 * @param {Array} userFollowing - Array of user IDs that current user is following
 * @param {Array} userFollowers - Array of user IDs that follow the current user
 * @returns {Map} Map of postId -> likedByPreview data
 */
const getLikedByPreviewBatch = (posts, currentUserId, userFollowing = [], userFollowers = []) => {
  const previewMap = new Map();

  posts.forEach(post => {
    const preview = getLikedByPreview(
      post.likedBy || [],
      currentUserId,
      userFollowing,
      userFollowers
    );

    previewMap.set(post._id.toString(), preview);
  });

  return previewMap;
};

export {
  getLikedByPreview,
  getLikedByPreviewBatch
};
