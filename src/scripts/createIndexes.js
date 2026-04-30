import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/findernate';

const connectDB = async () => {
    try {
        
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 10000,
        });
        
        
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        process.exit(1);
    }
};

// Helper function to safely create index
const safeCreateIndex = async (collection, indexSpec, options = {}) => {
    try {
        await collection.createIndex(indexSpec, options);
        return { created: true, skipped: false };
    } catch (error) {
        if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
            return { created: false, skipped: true };
        } else {
            throw error;
        }
    }
};

const createIndexes = async () => {
    try {
        const db = mongoose.connection.db;
        
        let totalCreated = 0;
        let totalSkipped = 0;

        // =============================================================================
        // USER COLLECTION INDEXES
        // =============================================================================
        const userCollection = db.collection('users');
        
        const userIndexes = [
            [{ fullNameLower: 'text', username: 'text' }, { name: 'idx_user_search', weights: { fullNameLower: 2, username: 3 } }],
            [{ isBusinessProfile: 1 }, { name: 'idx_business_flag' }],
            [{ accountStatus: 1 }, { name: 'idx_account_status' }],
            [{ createdAt: -1 }, { name: 'idx_user_created' }],
            [{ accountStatus: 1, isBusinessProfile: 1 }, { name: 'idx_status_business' }],
        ];

        for (const [indexSpec, options] of userIndexes) {
            const result = await safeCreateIndex(userCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // POST COLLECTION INDEXES
        // =============================================================================
        const postCollection = db.collection('posts');
        
        const postIndexes = [
            [{ userId: 1, createdAt: -1 }, { name: 'idx_user_posts_time' }],
            [{ postType: 1, createdAt: -1 }, { name: 'idx_type_time' }],
            [{ contentType: 1, createdAt: -1 }, { name: 'idx_content_time' }],
            [{ hashtags: 1 }, { name: 'idx_hashtags' }],
            [{ mentions: 1 }, { name: 'idx_mentions' }],
            [{ 'engagement.likes': -1 }, { name: 'idx_likes_desc' }],
            [{ 'engagement.views': -1 }, { name: 'idx_views_desc' }],
            [{ isPromoted: 1, 'engagement.likes': -1, createdAt: -1 }, { name: 'idx_trending' }],
            [{ status: 1, publishedAt: -1 }, { name: 'idx_published' }],
            // New performance indexes
            [{ status: 1 }, { name: 'idx_status' }],
            [{ contentType: 1 }, { name: 'idx_content_type' }],
            [{ userId: 1, status: 1, createdAt: -1 }, { name: 'idx_user_status_time' }],
            [{ 'settings.privacy': 1 }, { name: 'idx_privacy' }],
            [{ 'settings.visibility': 1 }, { name: 'idx_visibility' }],
        ];

        for (const [indexSpec, options] of postIndexes) {
            const result = await safeCreateIndex(postCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // CHAT & MESSAGE INDEXES
        // =============================================================================
        const chatCollection = db.collection('chats');
        
        const chatIndexes = [
            [{ participants: 1, lastMessageAt: -1 }, { name: 'idx_user_chats' }],
            [{ chatType: 1, status: 1 }, { name: 'idx_chat_status' }],
        ];

        for (const [indexSpec, options] of chatIndexes) {
            const result = await safeCreateIndex(chatCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        const messageCollection = db.collection('messages');
        
        const messageIndexes = [
            [{ chatId: 1, createdAt: -1 }, { name: 'idx_chat_messages_time' }],
            [{ senderId: 1, createdAt: -1 }, { name: 'idx_sender_messages' }],
            [{ messageStatus: 1 }, { name: 'idx_message_status' }],
        ];

        for (const [indexSpec, options] of messageIndexes) {
            const result = await safeCreateIndex(messageCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // ENGAGEMENT INDEXES
        // =============================================================================
        const likeCollection = db.collection('likes');
        
        const likeIndexes = [
            [{ postId: 1, createdAt: -1 }, { name: 'idx_post_likes_time' }],
            [{ userId: 1, createdAt: -1 }, { name: 'idx_user_likes_time' }],
        ];

        for (const [indexSpec, options] of likeIndexes) {
            const result = await safeCreateIndex(likeCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        const commentCollection = db.collection('comments');
        
        const commentIndexes = [
            [{ postId: 1, createdAt: -1 }, { name: 'idx_post_comments_time' }],
            [{ userId: 1, createdAt: -1 }, { name: 'idx_user_comments_time' }],
            [{ parentCommentId: 1 }, { name: 'idx_comment_replies' }],
        ];

        for (const [indexSpec, options] of commentIndexes) {
            const result = await safeCreateIndex(commentCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // NOTIFICATION INDEXES
        // =============================================================================
        const notificationCollection = db.collection('notifications');
        
        const notificationIndexes = [
            [{ userId: 1, isRead: 1, createdAt: -1 }, { name: 'idx_user_notifications' }],
            [{ senderId: 1, createdAt: -1 }, { name: 'idx_sender_notifications' }],
            [{ type: 1, createdAt: -1 }, { name: 'idx_notification_type' }],
        ];

        for (const [indexSpec, options] of notificationIndexes) {
            const result = await safeCreateIndex(notificationCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // BUSINESS INDEXES
        // =============================================================================
        const businessCollection = db.collection('businesses');
        
        const businessIndexes = [
            [{ category: 1, 'location.city': 1, 'rating.average': -1 }, { name: 'idx_business_discovery' }],
            [{ status: 1, isVerified: 1 }, { name: 'idx_business_status' }],
            [{ ownerId: 1 }, { name: 'idx_business_owner' }],
        ];

        for (const [indexSpec, options] of businessIndexes) {
            const result = await safeCreateIndex(businessCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // STORY INDEXES (with TTL)
        // =============================================================================
        const storyCollection = db.collection('stories');

        const storyIndexes = [
            [{ createdAt: 1 }, { name: 'idx_story_expire', expireAfterSeconds: 86400 }], // 24 hours
            [{ userId: 1, createdAt: -1 }, { name: 'idx_user_stories' }],
            [{ isHighlight: 1 }, { name: 'idx_story_highlights' }],
        ];

        for (const [indexSpec, options] of storyIndexes) {
            const result = await safeCreateIndex(storyCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // BLOCK COLLECTION INDEXES
        // =============================================================================
        const blockCollection = db.collection('blocks');

        const blockIndexes = [
            [{ blockerId: 1, blockedId: 1 }, { name: 'idx_blocker_blocked', unique: true }],
            [{ blockerId: 1, createdAt: -1 }, { name: 'idx_blocker_time' }],
            [{ blockedId: 1, createdAt: -1 }, { name: 'idx_blocked_time' }],
        ];

        for (const [indexSpec, options] of blockIndexes) {
            const result = await safeCreateIndex(blockCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // FOLLOWER COLLECTION INDEXES
        // =============================================================================
        const followerCollection = db.collection('followers');

        const followerIndexes = [
            [{ userId: 1, followerId: 1 }, { name: 'idx_user_follower', unique: true }],
            [{ userId: 1, createdAt: -1 }, { name: 'idx_user_followers_time' }],
            [{ followerId: 1, createdAt: -1 }, { name: 'idx_follower_following_time' }],
            [{ status: 1 }, { name: 'idx_follower_status' }],
        ];

        for (const [indexSpec, options] of followerIndexes) {
            const result = await safeCreateIndex(followerCollection, indexSpec, options);
            totalCreated += result.created ? 1 : 0;
            totalSkipped += result.skipped ? 1 : 0;
        }

        // =============================================================================
        // SUMMARY
        // =============================================================================

    } catch (error) {
        console.error('❌ Error creating indexes:', error);
        throw error;
    }
};

const listExistingIndexes = async () => {
    try {
        await connectDB();
        
        const collections = await mongoose.connection.db.listCollections().toArray();
        const importantCollections = ['users', 'posts', 'chats', 'messages', 'likes', 'comments', 'notifications', 'businesses', 'stories', 'blocks', 'followers'];
        
        for (const collection of collections) {
            if (importantCollections.includes(collection.name)) {
                const indexes = await mongoose.connection.db.collection(collection.name).indexes();
                indexes.forEach(index => {
                });
            }
        }
        
        await mongoose.connection.close();
    } catch (error) {
        console.error('❌ Error listing indexes:', error);
    }
};

// Main execution
const main = async () => {
    try {
        await connectDB();
        await createIndexes();
        await mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        console.error('❌ Script failed:', error);
        process.exit(1);
    }
};

// Run the script
main();

export { createIndexes, listExistingIndexes };