import 'dotenv/config';
import connectDB from './db/index.js';
import { app } from './app.js';
import http from 'http';
import socketManager from './config/socket.js';
import './config/firebase-admin.config.js'; // Initialize Firebase Admin on startup
import { startSubscriptionExpiryJob } from './jobs/subscriptionExpiry.job.js';



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

        server.listen(PORT, '0.0.0.0', () => {

            // Start subscription expiry cron jobs
            startSubscriptionExpiryJob();
        });

        server.on('error', (error) => {
            console.error('❌ Server error:', error);
            process.exit(1);
        });
    })
    .catch((err) => {
        console.error("❌ MONGODB connection error:", err);
        process.exit(1);
    });
