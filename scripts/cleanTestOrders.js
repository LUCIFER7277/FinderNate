import mongoose from "mongoose";
import Order from "../src/models/order.models.js";
import { User } from "../src/models/user.models.js";
import dotenv from "dotenv";
import readline from "readline";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => {
    return new Promise(resolve => rl.question(query, resolve));
};

const cleanTestOrders = async () => {
    try {
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        // Get the current user (first user)
        const users = await User.find().limit(1);
        if (users.length === 0) {
            console.log("❌ No users found.");
            process.exit(1);
        }

        const currentUser = users[0];
        console.log(`\n👤 Found user: ${currentUser.username} (${currentUser._id})`);

        // Count test orders
        const orderCount = await Order.countDocuments({ buyerId: currentUser._id });
        console.log(`📦 Found ${orderCount} orders for this buyer.\n`);

        if (orderCount === 0) {
            console.log("ℹ️  No orders to delete.");
            rl.close();
            process.exit(0);
        }

        // Ask for confirmation
        const answer = await askQuestion(`⚠️  Are you sure you want to delete all ${orderCount} orders? (yes/no): `);

        if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
            console.log("\n🗑️  Deleting orders...");
            const result = await Order.deleteMany({ buyerId: currentUser._id });
            console.log(`✅ Successfully deleted ${result.deletedCount} orders!`);
        } else {
            console.log("\n❌ Operation cancelled.");
        }

        rl.close();
        process.exit(0);
    } catch (error) {
        console.error("❌ Error cleaning test orders:", error);
        rl.close();
        process.exit(1);
    }
};

// Run the script
cleanTestOrders();
