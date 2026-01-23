import mongoose from "mongoose";
import Order from "../src/models/order.models.js";
import { User } from "../src/models/user.models.js";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

const transferOrders = async () => {
    try {
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(MONGODB_URI);
        console.log("✅ Connected to MongoDB\n");

        // Find both users
        const fromUser = await User.findOne({ username: "lucifer7277" });
        const toUser = await User.findOne({ username: "darksuryansh" });

        if (!fromUser) {
            console.log("❌ Source user 'lucifer7277' not found");
            process.exit(1);
        }

        if (!toUser) {
            console.log("❌ Target user 'darksuryansh' not found");
            process.exit(1);
        }

        console.log(`👤 From: ${fromUser.username} (${fromUser._id})`);
        console.log(`👤 To: ${toUser.username} (${toUser._id})\n`);

        // Count orders to transfer
        const orderCount = await Order.countDocuments({ buyerId: fromUser._id });
        console.log(`📦 Found ${orderCount} orders to transfer\n`);

        if (orderCount === 0) {
            console.log("ℹ️  No orders to transfer.");
            process.exit(0);
        }

        // Transfer orders
        console.log("🔄 Transferring orders...");
        const result = await Order.updateMany(
            { buyerId: fromUser._id },
            { $set: { buyerId: toUser._id } }
        );

        console.log(`✅ Successfully transferred ${result.modifiedCount} orders!`);
        console.log(`\n🎉 All orders are now under user: ${toUser.username}`);
        console.log(`\nYou can now log in as 'darksuryansh' to see the order history.`);

        process.exit(0);
    } catch (error) {
        console.error("❌ Error transferring orders:", error);
        process.exit(1);
    }
};

// Run the script
transferOrders();
