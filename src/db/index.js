import mongoose from "mongoose";

const connectDB = async (retries = 3) => {
    try {
        console.log('🔄 Attempting to connect to MongoDB...');

        if (!process.env.MONGODB_URI) {
            throw new Error('MONGODB_URI environment variable is not defined');
        }

        // Get current IP for diagnostics
        try {
            const response = await fetch('https://ipinfo.io/ip');
            const currentIP = await response.text();
            console.log(`📡 Current IP: ${currentIP.trim()}`);
        } catch (ipError) {
            console.log('📡 Could not determine current IP');
        }

        const connectionInstance = await mongoose.connect(process.env.MONGODB_URI, {
            maxPoolSize: 50, // ✅ OPTIMIZED: Increased from 10 to 50 for better concurrency
            minPoolSize: 10, // ✅ ADDED: Maintain minimum connections for faster response
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            connectTimeoutMS: 30000,
            bufferCommands: false,
            retryWrites: true,
            retryReads: true,
            maxIdleTimeMS: 30000, // ✅ ADDED: Close idle connections after 30s
        });

        console.log(`✅ MongoDB connected successfully! Host: ${connectionInstance.connection.host}`);

        // Handle connection events
        mongoose.connection.on('error', (err) => {
            console.error('❌ MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            console.log('📤 MongoDB disconnected');
        });

        mongoose.connection.on('reconnected', () => {
            console.log('🔄 MongoDB reconnected');
        });

        return connectionInstance;
    }
    catch (error) {
        console.error("❌ MongoDB connection FAILED:", error.message);
        console.error("🔍 MongoDB URI (masked):", process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/:[^:@]*@/, ':***@') : 'undefined');

        // Provide specific guidance for common errors
        if (error.message.includes('IP') || error.message.includes('whitelist')) {
            console.error("💡 SOLUTION: Add your IP (152.57.137.142) to MongoDB Atlas whitelist:");
            console.error("   1. Go to MongoDB Atlas dashboard");
            console.error("   2. Navigate to Network Access");
            console.error("   3. Click 'Add IP Address'");
            console.error("   4. Add 152.57.137.142 or use 0.0.0.0/0 for all IPs (less secure)");
        }

        if (retries > 0) {
            console.log(`🔄 Retrying connection... ${retries} attempts remaining`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            return connectDB(retries - 1);
        }

        throw error;
    }
}
export default connectDB;