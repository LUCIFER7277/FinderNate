/**
 * Manual Payment Release Script for Demo/Sandbox
 *
 * This script helps you manually release held payments in the escrow system
 * Perfect for demo/sandbox testing where you don't want to wait for buyer confirmation
 *
 * Usage:
 * 1. node manual-release-payment.js list              - List all orders with held payments
 * 2. node manual-release-payment.js release <orderId> - Release a specific order's payment
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from '../src/models/order.models.js';
import EscrowWallet from '../src/models/escrowWallet.models.js';

dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
};

// List all orders with held payments
const listHeldOrders = async () => {
    try {
        const orders = await Order.find({ paymentStatus: 'held' })
            .populate('buyerId', 'fullName username phoneNumber')
            .populate('sellerId', 'fullName username phoneNumber')
            .sort({ createdAt: -1 });

        if (orders.length === 0) {
            console.log('\n📦 No orders with held payments found.\n');
            return;
        }

        console.log(`\n📦 Found ${orders.length} order(s) with held payments:\n`);
        console.log('═'.repeat(100));

        orders.forEach((order, index) => {
            console.log(`\n${index + 1}. Order #${order.orderNumber}`);
            console.log(`   Order ID: ${order._id}`);
            console.log(`   Amount: ₹${order.amount}`);
            console.log(`   Order Status: ${order.orderStatus}`);
            console.log(`   Payment Status: ${order.paymentStatus}`);
            console.log(`   Buyer: ${order.buyerId?.fullName || 'Guest'} (${order.buyerId?.username || order.buyerDetails?.email || 'N/A'})`);
            console.log(`   Seller: ${order.sellerId?.fullName || 'N/A'} (@${order.sellerId?.username || 'N/A'})`);
            console.log(`   Product: ${order.productDetails?.name || 'N/A'}`);
            console.log(`   Created: ${order.createdAt.toLocaleString()}`);
            console.log('   ' + '─'.repeat(98));
        });

        console.log('\n💡 To release a payment, run:');
        console.log('   node manual-release-payment.js release <orderId>\n');
    } catch (error) {
        console.error('❌ Error listing orders:', error.message);
    }
};

// Manually release payment for an order
const releasePayment = async (orderId) => {
    try {
        // Find the order
        const order = await Order.findById(orderId)
            .populate('buyerId', 'fullName username')
            .populate('sellerId', 'fullName username');

        if (!order) {
            console.log(`\n❌ Order not found with ID: ${orderId}\n`);
            return;
        }

        // Check if payment is in held status
        if (order.paymentStatus !== 'held') {
            console.log(`\n⚠️  Cannot release payment. Current status: ${order.paymentStatus}`);
            console.log(`   Only orders with 'held' payment status can be released.\n`);
            return;
        }

        console.log('\n📦 Order Details:');
        console.log('═'.repeat(100));
        console.log(`Order Number: ${order.orderNumber}`);
        console.log(`Amount: ₹${order.amount}`);
        console.log(`Buyer: ${order.buyerId?.fullName || 'Guest'}`);
        console.log(`Seller: ${order.sellerId?.fullName}`);
        console.log(`Product: ${order.productDetails?.name}`);
        console.log('═'.repeat(100));

        // Get escrow wallet
        const escrowWallet = await EscrowWallet.getWallet();

        // Release funds (no platform fee in demo)
        await escrowWallet.releaseFunds(
            order,
            order.amount,
            0,
            'Manual release via script - Demo/Sandbox approval'
        );

        // Update order status
        order.paymentStatus = 'released';
        order.orderStatus = 'confirmed';
        order.paymentReleasedAt = new Date();
        await order.save();

        console.log('\n✅ Payment released successfully!');
        console.log(`   Payment Status: ${order.paymentStatus}`);
        console.log(`   Order Status: ${order.orderStatus}`);
        console.log(`   Released At: ${order.paymentReleasedAt.toLocaleString()}`);
        console.log(`\n💰 Funds have been released to seller: ${order.sellerId?.fullName}\n`);

    } catch (error) {
        console.error('❌ Error releasing payment:', error.message);
    }
};

// Release all held payments at once (bulk operation)
const releaseAllHeldPayments = async () => {
    try {
        const orders = await Order.find({ paymentStatus: 'held' })
            .populate('sellerId', 'fullName');

        if (orders.length === 0) {
            console.log('\n📦 No orders with held payments found.\n');
            return;
        }

        console.log(`\n🚀 Found ${orders.length} order(s) with held payments.`);
        console.log('   Releasing all payments...\n');

        const escrowWallet = await EscrowWallet.getWallet();
        let successCount = 0;
        let failCount = 0;

        for (const order of orders) {
            try {
                // Release funds
                await escrowWallet.releaseFunds(
                    order,
                    order.amount,
                    0,
                    'Bulk manual release - Demo/Sandbox approval'
                );

                // Update order
                order.paymentStatus = 'released';
                order.orderStatus = 'confirmed';
                order.paymentReleasedAt = new Date();
                await order.save();

                successCount++;
                console.log(`   ✅ Released: Order #${order.orderNumber} - ₹${order.amount}`);
            } catch (error) {
                failCount++;
                console.log(`   ❌ Failed: Order #${order.orderNumber} - ${error.message}`);
            }
        }

        console.log('\n═'.repeat(100));
        console.log(`\n📊 Summary:`);
        console.log(`   Total: ${orders.length}`);
        console.log(`   Success: ${successCount}`);
        console.log(`   Failed: ${failCount}\n`);

    } catch (error) {
        console.error('❌ Error in bulk release:', error.message);
    }
};

// Main function
const main = async () => {
    await connectDB();

    const command = process.argv[2];
    const orderId = process.argv[3];

    console.log('\n🔧 Manual Payment Release Tool - Demo/Sandbox Mode');
    console.log('═'.repeat(100));

    switch (command) {
        case 'list':
            await listHeldOrders();
            break;

        case 'release':
            if (!orderId) {
                console.log('\n❌ Please provide an order ID');
                console.log('   Usage: node manual-release-payment.js release <orderId>\n');
            } else {
                await releasePayment(orderId);
            }
            break;

        case 'release-all':
            await releaseAllHeldPayments();
            break;

        case 'help':
        default:
            console.log('\n📖 Available Commands:\n');
            console.log('   list              - List all orders with held payments');
            console.log('   release <orderId> - Release payment for a specific order');
            console.log('   release-all       - Release all held payments at once (bulk)');
            console.log('   help              - Show this help message\n');
            console.log('💡 Examples:');
            console.log('   node manual-release-payment.js list');
            console.log('   node manual-release-payment.js release 507f1f77bcf86cd799439011');
            console.log('   node manual-release-payment.js release-all\n');
            break;
    }

    await mongoose.connection.close();
    console.log('👋 Disconnected from MongoDB\n');
};

// Run the script
main().catch(error => {
    console.error('❌ Script error:', error);
    process.exit(1);
});
