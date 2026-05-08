import 'dotenv/config';
import connectDB from './db/index.js';
import { app } from './app.js';
import http from 'http';
import socketManager from './config/socket.js';
import './config/firebase-admin.config.js'; // Initialize Firebase Admin on startup
import { startSubscriptionExpiryJob } from './jobs/subscriptionExpiry.job.js';
import { startLikeWorker } from './queues/likeQueue.js';
// import { seedLikesToRedis } from './scripts/seedLikesToRedis.js';
import { redisClient } from './config/redis.config.js';
import { startCacheWarmer } from './utils/cacheWarmer.utils.js';



// Global error handlers to catch unhandled errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        return;
    }
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('🚫 Unhandled Rejection:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        return;
    }
    process.exit(1);
});

const server = http.createServer(app);

// Connect to MongoDB, then start the server
connectDB()
    .then(async () => {

        // Initialize Socket.IO with our enhanced manager after DB connection
        try {
            await socketManager.initialize(server);
        } catch (error) {
            console.error('❌ Socket.IO initialization error:', error);
            throw error;
        }

        const PORT = process.env.PORT || 3000;

        // Seed Redis with DB like state once — cron keeps it in sync after that.
        // Key has no TTL so it persists until Redis is flushed/restarted.
        // redisClient.get('fn:redis:likes:seeded').then(seeded => {
        //     if (!seeded) {
        //         seedLikesToRedis()
        //             .then(() => redisClient.set('fn:redis:likes:seeded', '1'))
        //             .catch(err => console.error('❌ Redis like seed failed:', err));
        //     }
        // });

        const warmerSubscriber = startCacheWarmer();

        server.listen(PORT, '0.0.0.0', () => {

            // Start cron jobs and queue workers
            startSubscriptionExpiryJob();
            startLikeWorker();
        });

        server.on('close', () => warmerSubscriber.quit());

        server.on('error', (error) => {
            console.error('❌ Server error:', error);
            process.exit(1);
        });
    })
    .catch((err) => {
        console.error("❌ MONGODB connection error:", err);
        process.exit(1);
    });
