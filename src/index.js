import dotenv from 'dotenv';
import connectDB from './db/index.js';
import { app } from './app.js';
import http from 'http';
import socketManager from './config/socket.js';
import './config/firebase-admin.config.js'; // Initialize Firebase Admin on startup

dotenv.config({
    path: './.env'
});

console.log('🚀 Starting FinderNate Backend...');
console.log('📊 Environment:', process.env.NODE_ENV);
console.log('🔌 Port:', process.env.PORT);

// Global error handlers to catch unhandled errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        console.log('🔄 Network error detected, continuing...');
        return;
    }
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('🚫 Unhandled Rejection:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        console.log('🔄 Network error detected, continuing...');
        return;
    }
    process.exit(1);
});

const server = http.createServer(app);

// Connect to MongoDB, then start the server
connectDB()
    .then(async () => {
        console.log('✅ Database connected successfully');

        // Initialize Socket.IO with our enhanced manager after DB connection
        try {
            console.log('🔄 Initializing Socket.IO...');
            await socketManager.initialize(server);
            console.log('✅ Socket.IO initialized successfully');
        } catch (error) {
            console.error('❌ Socket.IO initialization error:', error);
            throw error;
        }

        const PORT = process.env.PORT || 3000;
        console.log(`🔧 Attempting to start server on port ${PORT}`);
        console.log(`🔧 Environment: ${process.env.NODE_ENV}`);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`🎉 Server is running on port ${PORT}`);
            console.log(`🌐 Health check: http://localhost:${PORT}/health`);
            console.log(`🌐 Debug endpoint: http://localhost:${PORT}/debug`);
            console.log('🎯 FinderNate Backend is ready to accept connections!');
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
