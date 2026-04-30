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

/**
 * Find and remove duplicate chats
 * Keeps the oldest chat for each unique pair of participants
 */
const cleanupDuplicateChats = async () => {
    try {
        const db = mongoose.connection.db;
        const chatsCollection = db.collection('chats');


        // Find all chats
        const allChats = await chatsCollection.find({}).toArray();

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


                for (const chat of deleteChats) {
                    chatIdsToDelete.push(chat._id);
                }

                chatsDeleted += deleteChats.length;
            }
        }

        if (chatIdsToDelete.length === 0) {
            return;
        }


        // Ask for confirmation in production
        if (process.env.NODE_ENV === 'production') {

            if (process.env.CONFIRM_DELETE !== 'true') {
                return;
            }
        }

        // Delete duplicate chats
        const deleteResult = await chatsCollection.deleteMany({
            _id: { $in: chatIdsToDelete }
        });


        // Also clean up related data

        const messagesCollection = db.collection('messages');
        const messageDeleteResult = await messagesCollection.deleteMany({
            chatId: { $in: chatIdsToDelete.map(id => id.toString()) }
        });



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

    } catch (error) {
        if (error.code === 11000) {
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

        await connectDB();
        await cleanupDuplicateChats();
        await createUniqueIndex();


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
