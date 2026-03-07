import mongoose from "mongoose";
import Order from "../models/order.models.js";
import { User } from "../models/user.models.js";
import Post from "../models/userPost.models.js";
import type { IUser } from "../types/user.types.js";
import type { IPost } from "../types/userPost.types.js";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI!;

interface TestProduct {
    name: string;
    category: string;
    price: number;
    description: string;
}

interface TestAddress {
    fullName: string;
    phoneNumber: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
}

// Helper to generate order numbers
const generateOrderNumber = (): string => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

// Helper to get random date in the past N days
const getRandomPastDate = (daysAgo: number): Date => {
    const date = new Date();
    date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
    return date;
};

// Test product categories and details
const testProducts: TestProduct[] = [
    { name: "iPhone 14 Pro", category: "Electronics", price: 89999, description: "Latest iPhone with great camera" },
    { name: "Nike Air Max", category: "Fashion", price: 8999, description: "Comfortable running shoes" },
    { name: "MacBook Pro M2", category: "Electronics", price: 179999, description: "Powerful laptop for professionals" },
    { name: "Wooden Coffee Table", category: "Furniture", price: 15999, description: "Handcrafted solid wood table" },
    { name: "Gaming Chair", category: "Furniture", price: 12999, description: "Ergonomic gaming chair with lumbar support" },
    { name: "Vintage Camera", category: "Electronics", price: 25999, description: "Classic film camera in good condition" },
    { name: "Designer Handbag", category: "Fashion", price: 34999, description: "Luxury leather handbag" },
    { name: "Yoga Mat", category: "Sports", price: 1499, description: "Non-slip yoga mat with carrying strap" },
    { name: "Bluetooth Speaker", category: "Electronics", price: 4999, description: "Portable wireless speaker" },
    { name: "Study Desk", category: "Furniture", price: 9999, description: "Compact desk perfect for students" },
    { name: "Smartwatch", category: "Electronics", price: 19999, description: "Fitness tracking smartwatch" },
    { name: "Winter Jacket", category: "Fashion", price: 5999, description: "Warm insulated winter jacket" },
];

// Test addresses
const testAddresses: TestAddress[] = [
    {
        fullName: "John Doe",
        phoneNumber: "+919876543210",
        addressLine1: "123 MG Road",
        addressLine2: "Near City Mall",
        city: "Mumbai",
        state: "Maharashtra",
        postalCode: "400001",
        country: "India"
    },
    {
        fullName: "Jane Smith",
        phoneNumber: "+919876543211",
        addressLine1: "456 Indiranagar",
        addressLine2: "Opposite Metro Station",
        city: "Bangalore",
        state: "Karnataka",
        postalCode: "560038",
        country: "India"
    },
    {
        fullName: "Raj Kumar",
        phoneNumber: "+919876543212",
        addressLine1: "789 Connaught Place",
        city: "New Delhi",
        state: "Delhi",
        postalCode: "110001",
        country: "India"
    }
];

const createTestOrders = async (): Promise<void> => {
    try {
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        // Get the current user (assuming you're logged in - we'll use the first user we find)
        const users: IUser[] = await User.find().limit(10);

        if (users.length < 2) {
            console.log("❌ Not enough users found. Please ensure you have at least 2 users in the database.");
            process.exit(1);
        }

        const currentUser: IUser = users[0]; // This will be the buyer
        const sellers: IUser[] = users.slice(1); // Other users will be sellers

        console.log(`\n👤 Creating test orders for buyer: ${currentUser.username} (${currentUser._id})`);
        console.log(`👥 Using ${sellers.length} sellers for test orders\n`);

        // Get some posts to link orders to (optional)
        const posts: IPost[] = await Post.find().limit(5);

        const testOrders: object[] = [];

        // TEST CASE 1: Completed Orders (5 orders)
        console.log("✅ Creating COMPLETED orders...");
        for (let i = 0; i < 5; i++) {
            const product = testProducts[i];
            const seller = sellers[i % sellers.length];
            const address = testAddresses[i % testAddresses.length];
            const createdDate = getRandomPastDate(60);
            const shippedDate = new Date(createdDate.getTime() + 2 * 24 * 60 * 60 * 1000);
            const deliveredDate = new Date(shippedDate.getTime() + 3 * 24 * 60 * 60 * 1000);
            const confirmedDate = new Date(deliveredDate.getTime() + 1 * 24 * 60 * 60 * 1000);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[i % posts.length]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'released',
                orderStatus: 'confirmed',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                razorpayPaymentId: `pay_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                shippingInfo: {
                    trackingId: `TRK${Math.floor(Math.random() * 1000000000)}`,
                    carrier: ['BlueDart', 'DTDC', 'FedEx', 'Delhivery'][i % 4],
                    shippedAt: shippedDate,
                    deliveredAt: deliveredDate,
                    packingVideoUrl: `https://example.com/packing-video-${i}.mp4`,
                    packingImages: [`https://via.placeholder.com/400x300?text=Packing+${i}`]
                },
                buyerProof: {
                    openingVideoUrl: `https://example.com/opening-video-${i}.mp4`,
                    uploadedAt: deliveredDate
                },
                deliveryConfirmedAt: confirmedDate,
                paymentReleasedAt: confirmedDate,
                buyerRating: [4, 5, 5, 4, 5][i % 5],
                buyerReview: [
                    "Great product! Fast delivery.",
                    "Excellent quality, highly recommended!",
                    "Good condition, packaging was perfect.",
                    "Product as described. Happy with purchase.",
                    "Amazing seller, will buy again!"
                ][i % 5],
                sellerRating: 5,
                sellerReview: "Great buyer, smooth transaction!",
                createdAt: createdDate,
                updatedAt: confirmedDate
            });
        }

        // TEST CASE 2: Shipped Orders - Awaiting Delivery (3 orders)
        console.log("📦 Creating SHIPPED orders (awaiting delivery)...");
        for (let i = 5; i < 8; i++) {
            const product = testProducts[i];
            const seller = sellers[i % sellers.length];
            const address = testAddresses[i % testAddresses.length];
            const createdDate = getRandomPastDate(10);
            const shippedDate = new Date(createdDate.getTime() + 1 * 24 * 60 * 60 * 1000);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[i % posts.length]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'paid',
                orderStatus: 'shipped',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                razorpayPaymentId: `pay_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                shippingInfo: {
                    trackingId: `TRK${Math.floor(Math.random() * 1000000000)}`,
                    carrier: ['BlueDart', 'DTDC', 'FedEx'][i % 3],
                    shippedAt: shippedDate,
                    packingVideoUrl: `https://example.com/packing-video-${i}.mp4`,
                    packingImages: [`https://via.placeholder.com/400x300?text=Packing+${i}`]
                },
                createdAt: createdDate,
                updatedAt: shippedDate
            });
        }

        // TEST CASE 3: Processing Orders - Payment Received (2 orders)
        console.log("⏳ Creating PROCESSING orders...");
        for (let i = 8; i < 10; i++) {
            const product = testProducts[i];
            const seller = sellers[i % sellers.length];
            const address = testAddresses[i % testAddresses.length];
            const createdDate = getRandomPastDate(3);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[i % posts.length]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'paid',
                orderStatus: 'processing',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                razorpayPaymentId: `pay_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                createdAt: createdDate,
                updatedAt: createdDate
            });
        }

        // TEST CASE 4: Pending Payment Orders (2 orders)
        console.log("⏰ Creating PENDING PAYMENT orders...");
        for (let i = 10; i < 12; i++) {
            const product = testProducts[i % testProducts.length];
            const seller = sellers[i % sellers.length];
            const address = testAddresses[i % testAddresses.length];
            const createdDate = getRandomPastDate(2);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[i % posts.length]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'pending',
                orderStatus: 'payment_pending',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                createdAt: createdDate,
                updatedAt: createdDate
            });
        }

        // TEST CASE 5: Disputed Order (1 order)
        console.log("⚠️ Creating DISPUTED order...");
        {
            const product = testProducts[0];
            const seller = sellers[0];
            const address = testAddresses[0];
            const createdDate = getRandomPastDate(15);
            const shippedDate = new Date(createdDate.getTime() + 2 * 24 * 60 * 60 * 1000);
            const deliveredDate = new Date(shippedDate.getTime() + 3 * 24 * 60 * 60 * 1000);
            const disputeDate = new Date(deliveredDate.getTime() + 1 * 24 * 60 * 60 * 1000);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[0]?._id,
                productDetails: {
                    name: "Defective " + product.name,
                    description: "Product with issues",
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=Defective+Product`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'held',
                orderStatus: 'disputed',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                razorpayPaymentId: `pay_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                shippingInfo: {
                    trackingId: `TRK${Math.floor(Math.random() * 1000000000)}`,
                    carrier: 'BlueDart',
                    shippedAt: shippedDate,
                    deliveredAt: deliveredDate
                },
                dispute: {
                    reason: "Product Not as Described",
                    description: "The product received is damaged and not working properly. It's different from what was shown in the pictures.",
                    evidence: [
                        "https://via.placeholder.com/400x400?text=Evidence+1",
                        "https://via.placeholder.com/400x400?text=Evidence+2"
                    ],
                    status: 'under_review',
                    createdAt: disputeDate
                },
                buyerProof: {
                    openingVideoUrl: `https://example.com/dispute-opening-video.mp4`,
                    uploadedAt: disputeDate
                },
                createdAt: createdDate,
                updatedAt: disputeDate
            });
        }

        // TEST CASE 6: Cancelled Order (1 order)
        console.log("❌ Creating CANCELLED order...");
        {
            const product = testProducts[1];
            const seller = sellers[1];
            const address = testAddresses[1];
            const createdDate = getRandomPastDate(20);
            const cancelledDate = new Date(createdDate.getTime() + 12 * 60 * 60 * 1000);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[1]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'refunded',
                orderStatus: 'cancelled',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                createdAt: createdDate,
                updatedAt: cancelledDate
            });
        }

        // TEST CASE 7: Delivered - Awaiting Confirmation (2 orders)
        console.log("📭 Creating DELIVERED orders (awaiting confirmation)...");
        for (let i = 0; i < 2; i++) {
            const product = testProducts[i + 2];
            const seller = sellers[i % sellers.length];
            const address = testAddresses[i % testAddresses.length];
            const createdDate = getRandomPastDate(7);
            const shippedDate = new Date(createdDate.getTime() + 1 * 24 * 60 * 60 * 1000);
            const deliveredDate = new Date(shippedDate.getTime() + 2 * 24 * 60 * 60 * 1000);

            testOrders.push({
                orderNumber: generateOrderNumber(),
                buyerId: currentUser._id,
                sellerId: seller._id,
                postId: posts[i % posts.length]?._id,
                productDetails: {
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity: 1,
                    images: [`https://via.placeholder.com/300x300?text=${product.name.replace(/ /g, '+')}`],
                    category: product.category
                },
                amount: product.price,
                platformFee: 0,
                sellerAmount: product.price,
                currency: 'INR',
                paymentStatus: 'paid',
                orderStatus: 'delivered',
                razorpayOrderId: `order_${Math.random().toString(36).substr(2, 9)}`,
                razorpayPaymentId: `pay_${Math.random().toString(36).substr(2, 9)}`,
                shippingAddress: address,
                shippingInfo: {
                    trackingId: `TRK${Math.floor(Math.random() * 1000000000)}`,
                    carrier: ['BlueDart', 'DTDC'][i % 2],
                    shippedAt: shippedDate,
                    deliveredAt: deliveredDate,
                    packingVideoUrl: `https://example.com/packing-video-${i}.mp4`
                },
                createdAt: createdDate,
                updatedAt: deliveredDate
            });
        }

        // Insert all test orders
        console.log("\n💾 Inserting test orders into database...");
        const insertedOrders = await Order.insertMany(testOrders);

        console.log(`\n✅ Successfully created ${insertedOrders.length} test orders!`);
        console.log("\n📊 Order Summary:");
        console.log(`   ✅ Completed & Confirmed: 5 orders`);
        console.log(`   📦 Shipped (In Transit): 3 orders`);
        console.log(`   ⏳ Processing: 2 orders`);
        console.log(`   ⏰ Pending Payment: 2 orders`);
        console.log(`   📭 Delivered (Awaiting Confirmation): 2 orders`);
        console.log(`   ⚠️ Disputed: 1 order`);
        console.log(`   ❌ Cancelled: 1 order`);
        console.log(`   📈 TOTAL: ${insertedOrders.length} orders`);

        console.log("\n🎯 Test Scenarios Covered:");
        console.log("   ✓ Different order statuses");
        console.log("   ✓ Different payment statuses");
        console.log("   ✓ Various product categories");
        console.log("   ✓ Multiple carriers");
        console.log("   ✓ Orders with ratings and reviews");
        console.log("   ✓ Orders with shipping tracking");
        console.log("   ✓ Orders with disputes");
        console.log("   ✓ Orders with packing videos");
        console.log("   ✓ Date range spanning 60 days");
        console.log("   ✓ Different price ranges");

        console.log("\n🧪 You can now test:");
        console.log("   • Order filtering by status");
        console.log("   • Order filtering by payment status");
        console.log("   • Date range filters");
        console.log("   • Amount range filters");
        console.log("   • Search functionality");
        console.log("   • Sorting options");
        console.log("   • Pagination");
        console.log("   • Order statistics");
        console.log("   • CSV export");

        process.exit(0);
    } catch (error) {
        console.error("❌ Error creating test orders:", error);
        process.exit(1);
    }
};

// Run the script
createTestOrders();
