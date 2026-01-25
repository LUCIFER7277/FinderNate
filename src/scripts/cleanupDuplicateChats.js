import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/findernate';

const connectDB = async () => {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 10000,
        });
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        process.exit(1);
    }
};

/**
 * Find and remove duplicate chats
 * Keeps the oldest chat for each unique pair of participants
 */
const cleanupDuplicateChats = async () => {
    try {
        const db = mongoose.connection.db;
        const chatsCollection = db.collection('chats');

        console.log('\n🔍 Finding duplicate chats...\n');

        // Find all chats
        const allChats = await chatsCollection.find({}).toArray();
        console.log(`📊 Total chats found: ${allChats.length}`);

        // Group chats by participants (for 1-on-1 chats only)
        const chatGroups = new Map();

        for (const chat of allChats) {
            // Only process 1-on-1 chats (exactly 2 participants)
            if (chat.participants && chat.participants.length === 2) {
                // Sort participant IDs to create a consistent key
                const participantKey = [...chat.participants]
                    .map(id => id.toString())
                    .sort()
                    .join(',');

                if (!chatGroups.has(participantKey)) {
                    chatGroups.set(participantKey, []);
                }
                chatGroups.get(participantKey).push(chat);
            }
        }

        console.log(`📊 Unique participant pairs: ${chatGroups.size}`);

        // Find and remove duplicates
        let duplicatesFound = 0;
        let chatsDeleted = 0;
        const chatIdsToDelete = [];

        for (const [participantKey, chats] of chatGroups.entries()) {
            if (chats.length > 1) {
                duplicatesFound++;

                // Sort by createdAt to keep the oldest one
                chats.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

                const keepChat = chats[0];
                const deleteChats = chats.slice(1);

                console.log(`\n⚠️  Duplicate chats found for participants: ${participantKey}`);
                console.log(`   📌 Keeping oldest chat: ${keepChat._id} (created: ${keepChat.createdAt})`);
                console.log(`   🗑️  Deleting ${deleteChats.length} duplicate(s):`);

                for (const chat of deleteChats) {
                    console.log(`      - ${chat._id} (created: ${chat.createdAt})`);
                    chatIdsToDelete.push(chat._id);
                }

                chatsDeleted += deleteChats.length;
            }
        }

        if (chatIdsToDelete.length === 0) {
            console.log('\n✅ No duplicate chats found! Database is clean.');
            return;
        }

        console.log(`\n📊 Summary:`);
        console.log(`   - Participant pairs with duplicates: ${duplicatesFound}`);
        console.log(`   - Total duplicate chats to delete: ${chatsDeleted}`);

        // Ask for confirmation in production
        if (process.env.NODE_ENV === 'production') {
            console.log('\n⚠️  WARNING: Running in production mode!');
            console.log('Please review the list above carefully.');
            console.log('To proceed, set CONFIRM_DELETE=true environment variable.\n');

            if (process.env.CONFIRM_DELETE !== 'true') {
                console.log('❌ Deletion cancelled. No changes made.');
                return;
            }
        }

        // Delete duplicate chats
        console.log('\n🗑️  Deleting duplicate chats...');
        const deleteResult = await chatsCollection.deleteMany({
            _id: { $in: chatIdsToDelete }
        });

        console.log(`✅ Deleted ${deleteResult.deletedCount} duplicate chats`);

        // Also clean up related data
        console.log('\n🧹 Cleaning up related message data...');

        const messagesCollection = db.collection('messages');
        const messageDeleteResult = await messagesCollection.deleteMany({
            chatId: { $in: chatIdsToDelete.map(id => id.toString()) }
        });

        console.log(`✅ Deleted ${messageDeleteResult.deletedCount} messages from duplicate chats`);

        console.log('\n🎉 Cleanup completed successfully!');
        console.log(`\n📊 Final Stats:`);
        console.log(`   - Chats deleted: ${deleteResult.deletedCount}`);
        console.log(`   - Messages deleted: ${messageDeleteResult.deletedCount}`);

    } catch (error) {
        console.error('\n❌ Error during cleanup:', error);
        throw error;
    }
};

/**
 * Create unique index to prevent future duplicates
 */
const createUniqueIndex = async () => {
    try {
        console.log('\n🔧 Creating unique index to prevent future duplicates...');

        const db = mongoose.connection.db;
        const chatsCollection = db.collection('chats');

        // Create a unique compound index on sorted participants
        // This prevents duplicate chats between the same 2 users
        await chatsCollection.createIndex(
            { participants: 1 },
            {
                unique: true,
                partialFilterExpression: {
                    participants: { $size: 2 } // Only for 1-on-1 chats
                },
                name: 'idx_unique_participants'
            }
        );

        console.log('✅ Unique index created successfully');
    } catch (error) {
        if (error.code === 11000) {
            console.log('ℹ️  Unique index already exists');
        } else {
            console.error('❌ Error creating unique index:', error.message);
        }
    }
};

/**
 * Main execution
 */
const main = async () => {
    try {
        console.log('═══════════════════════════════════════════════════');
        console.log('  🧹 DUPLICATE CHAT CLEANUP SCRIPT');
        console.log('═══════════════════════════════════════════════════\n');

        await connectDB();
        await cleanupDuplicateChats();
        await createUniqueIndex();

        console.log('\n✅ All cleanup tasks completed!');
        console.log('═══════════════════════════════════════════════════\n');

        await mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { cleanupDuplicateChats, createUniqueIndex };
