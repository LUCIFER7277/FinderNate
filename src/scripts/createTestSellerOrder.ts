import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from '../models/order.models.js';
import { User } from '../models/user.models.js';
import type { IUser } from '../types/user.types.js';
import type { IOrder } from '../types/order.types.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI!;

async function createTestSellerOrder(): Promise<void> {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Find the seller (darksuryansh)
        const seller: IUser | null = await User.findOne({ username: 'darksuryansh' });
        if (!seller) {
            console.log('❌ Seller "darksuryansh" not found!');
            process.exit(1);
        }
        console.log(`✅ Found seller: ${seller.fullName} (@${seller.username})`);

        // Find a different user to be the buyer
        const buyer: IUser | null = await User.findOne({
            _id: { $ne: seller._id },
            username: { $exists: true }
        });
        if (!buyer) {
            console.log('❌ No buyer found!');
            process.exit(1);
        }
        console.log(`✅ Found buyer: ${buyer.fullName} (@${buyer.username})`);

        // Generate a unique order number
        const orderNumber: string = `ORD-TEST-${Date.now()}`;

        // Create a test order with payment_received status (this triggers the count)
        const testOrder: IOrder = new Order({
            orderNumber,
            buyerId: buyer._id,
            sellerId: seller._id,
            productDetails: {
                name: 'Test Product for Notification',
                description: 'This is a test product to verify seller order notification count',
                price: 999,
                images: [],
                category: 'Electronics'
            },
            amount: 999,
            platformFee: 50,
            sellerAmount: 949,
            shippingAddress: {
                fullName: buyer.fullName || 'Test Buyer',
                phoneNumber: buyer.phoneNumber || '9999999999',
                addressLine1: '123 Test Street',
                city: 'Test City',
                state: 'Test State',
                postalCode: '123456',
                country: 'India'
            },
            orderStatus: 'payment_received', // This status triggers the new orders count
            paymentStatus: 'held',
            razorpayOrderId: `test_order_${Date.now()}`,
            razorpayPaymentId: `test_payment_${Date.now()}`
        });

        await testOrder.save();
        console.log('\n🎉 Test order created successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`   Order Number: ${orderNumber}`);
        console.log(`   Order ID: ${testOrder._id}`);
        console.log(`   Seller: ${seller.username}`);
        console.log(`   Buyer: ${buyer.username}`);
        console.log(`   Status: payment_received (NEW ORDER!)`);
        console.log(`   Amount: ₹${testOrder.amount}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('\n📱 Now login as "darksuryansh" to see the notification count on Orders!');

        // Count total new orders for this seller
        const newOrdersCount: number = await Order.countDocuments({
            sellerId: seller._id,
            orderStatus: 'payment_received'
        });
        console.log(`\n📊 Total new orders for ${seller.username}: ${newOrdersCount}`);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n✅ Disconnected from MongoDB');
    }
}

createTestSellerOrder();
