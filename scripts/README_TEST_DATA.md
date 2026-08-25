# Order History Test Data Scripts

This directory contains scripts to populate your order history with comprehensive test data for testing all possible scenarios.

## 📋 Table of Contents
- [Overview](#overview)
- [Test Data Coverage](#test-data-coverage)
- [Quick Start](#quick-start)
- [Scripts](#scripts)
- [What Gets Created](#what-gets-created)
- [Testing Scenarios](#testing-scenarios)
- [Troubleshooting](#troubleshooting)

---

## 🎯 Overview

These scripts help you populate your order history section with realistic test data covering all possible order states, payment statuses, and edge cases. Perfect for development, testing, and demonstrating features.

## ✅ Test Data Coverage

The seed script creates **16 comprehensive test orders** covering:

### Order Statuses:
- ✅ **Completed & Confirmed** (5 orders) - Full lifecycle with ratings
- 📦 **Shipped** (3 orders) - In transit with tracking
- ⏳ **Processing** (2 orders) - Payment received, preparing
- ⏰ **Pending Payment** (2 orders) - Awaiting payment
- 📭 **Delivered** (2 orders) - Awaiting confirmation
- ⚠️ **Disputed** (1 order) - Under review with evidence
- ❌ **Cancelled** (1 order) - Cancelled with refund

### Payment Statuses:
- `pending` - Payment not yet completed
- `paid` - Payment successful
- `held` - Payment held (disputes)
- `released` - Payment released to seller
- `refunded` - Money returned to buyer

### Additional Features:
- 📊 Multiple product categories (Electronics, Fashion, Furniture, Sports)
- 📍 Different shipping addresses
- 🚚 Various carriers (BlueDart, DTDC, FedEx, Delhivery)
- ⭐ Ratings and reviews
- 📦 Tracking numbers
- 📹 Packing videos and opening videos
- 🗓️ Orders spanning 60 days
- 💰 Different price ranges (₹1,499 - ₹1,79,999)

---

## 🚀 Quick Start

### Prerequisites
1. Ensure MongoDB is running
2. Ensure you have `.env` file with `MONGODB_URI` configured
3. Ensure you have at least 2 users in your database

### Step 1: Install Dependencies (if not already done)
```bash
npm install
```

### Step 2: Run the Seed Script
```bash
npm run seed:orders
```

This will:
1. Connect to your MongoDB database
2. Find existing users (first user becomes the buyer)
3. Create 16 test orders with various statuses
4. Display a summary of created orders

### Step 3: Test Your Order History
Open your application and navigate to the order history section. You should now see all the test orders with different statuses, dates, and details.

---

## 📜 Scripts

### 1. `seedTestOrders.js` - Create Test Data
Creates comprehensive test orders for development and testing.

**Command:**
```bash
npm run seed:orders
```

**What it does:**
- Creates 16 test orders with different statuses
- Links orders to existing users and posts
- Adds realistic product details, addresses, and tracking info
- Generates orders across a 60-day period

**Output:**
```
✅ Successfully created 16 test orders!

📊 Order Summary:
   ✅ Completed & Confirmed: 5 orders
   📦 Shipped (In Transit): 3 orders
   ⏳ Processing: 2 orders
   ⏰ Pending Payment: 2 orders
   📭 Delivered (Awaiting Confirmation): 2 orders
   ⚠️ Disputed: 1 order
   ❌ Cancelled: 1 order
```

### 2. `cleanTestOrders.js` - Remove Test Data
Removes all test orders created for the first user (buyer).

**Command:**
```bash
npm run clean:orders
```

**What it does:**
- Finds all orders for the first user
- Asks for confirmation before deletion
- Deletes all orders for that buyer

**Usage:**
```bash
npm run clean:orders
# Output: ⚠️  Are you sure you want to delete all 16 orders? (yes/no):
# Type 'yes' to confirm
```

---

## 📦 What Gets Created

### Sample Order Structure:

#### 1. Completed Order Example
```javascript
{
  orderNumber: "ORD-1706234567890-123",
  buyerId: "user123...",
  sellerId: "user456...",
  productDetails: {
    name: "iPhone 14 Pro",
    description: "Latest iPhone with great camera",
    price: 89999,
    quantity: 1,
    category: "Electronics",
    images: ["https://via.placeholder.com/300x300"]
  },
  amount: 89999,
  currency: "INR",
  orderStatus: "confirmed",
  paymentStatus: "released",
  shippingAddress: {
    fullName: "John Doe",
    phoneNumber: "+919876543210",
    addressLine1: "123 MG Road",
    city: "Mumbai",
    state: "Maharashtra",
    postalCode: "400001"
  },
  shippingInfo: {
    trackingId: "TRK123456789",
    carrier: "BlueDart",
    shippedAt: "2026-01-20T10:00:00Z",
    deliveredAt: "2026-01-23T14:30:00Z",
    packingVideoUrl: "https://example.com/packing-video.mp4"
  },
  buyerRating: 5,
  buyerReview: "Great product! Fast delivery.",
  deliveryConfirmedAt: "2026-01-23T15:00:00Z"
}
```

#### 2. Disputed Order Example
```javascript
{
  orderStatus: "disputed",
  paymentStatus: "held",
  dispute: {
    reason: "Product Not as Described",
    description: "The product received is damaged...",
    evidence: ["url1", "url2"],
    status: "under_review"
  }
}
```

---

## 🧪 Testing Scenarios

After running the seed script, you can test:

### 1. **Order Listing & Filtering**
- Filter by status: completed, shipped, processing, pending, etc.
- Filter by payment status: paid, pending, held, released
- Search by order number or product name
- Filter by date range
- Filter by amount range

### 2. **Order Details View**
- View complete order information
- See shipping tracking details
- View buyer/seller information
- See product details and images

### 3. **Order Statistics**
Test the statistics endpoints:
```bash
GET /api/orders/buyer/statistics
```
Expected stats:
- Total orders: 16
- Total spent: ₹4,00,000+ (varies)
- Completed: 5
- Pending: 7
- Cancelled: 1
- Disputed: 1

### 4. **Order History with Filters**
```bash
# Get completed orders
GET /api/orders/buyer/history?status=confirmed

# Get orders in date range
GET /api/orders/buyer/history?startDate=2025-12-01&endDate=2026-01-23

# Get orders by amount range
GET /api/orders/buyer/history?minAmount=10000&maxAmount=50000

# Search orders
GET /api/orders/buyer/history?search=iPhone

# Sort orders
GET /api/orders/buyer/history?sortBy=amount&sortOrder=desc
```

### 5. **CSV Export**
Test the CSV export functionality:
```bash
GET /api/orders/export?type=buyer
GET /api/orders/export?type=buyer&status=confirmed
```

### 6. **Pagination**
Test pagination with different page sizes:
```bash
GET /api/orders/buyer/history?page=1&limit=5
GET /api/orders/buyer/history?page=2&limit=5
```

### 7. **Order Actions**
Test actions on delivered orders:
- Confirm delivery
- Rate seller
- Upload opening video
- Report issues

---

## 🐛 Troubleshooting

### Issue: "Not enough users found"
**Solution:** Create at least 2 users in your database first. The script needs:
- 1 buyer (will be your current user)
- 1+ sellers (other users)

```bash
# Register users through your API or create them manually
POST /api/auth/register
```

### Issue: "Connection refused"
**Solution:** Ensure MongoDB is running:
```bash
# Check if MongoDB is running
mongosh

# Or start MongoDB service
sudo systemctl start mongod  # Linux
brew services start mongodb-community  # macOS
net start MongoDB  # Windows
```

### Issue: Script runs but no orders visible
**Solution:**
1. Check that you're logged in as the first user in the database
2. Verify orders were created:
```bash
mongosh
use your_database
db.orders.countDocuments({ buyerId: ObjectId("your_buyer_id") })
```

### Issue: Want to add more orders
**Solution:** Simply run the seed script multiple times. Each run creates new unique orders:
```bash
npm run seed:orders
```

### Issue: Need different test data
**Solution:** Modify [seedTestOrders.js](./seedTestOrders.js):
- Edit `testProducts` array for different products
- Edit `testAddresses` array for different addresses
- Adjust date ranges by modifying `getRandomPastDate()` calls
- Change order quantities and statuses

---

## 📝 Notes

1. **User Selection**: The script uses the first user found as the buyer. Make sure you know which user that is.

2. **Real Posts**: If you have posts in your database, orders will be linked to them. Otherwise, the `postId` field will be undefined.

3. **Gateway IDs**: The script generates fake gateway order/payment IDs for testing. These are random strings and won't work against the real Cashfree API.

4. **Tracking Numbers**: Tracking IDs are randomly generated and won't work with real carrier websites.

5. **Images**: Placeholder images are used. Replace with real product images if needed.

6. **Running Multiple Times**: Safe to run multiple times. Each run creates new orders with unique order numbers.

---

## 🎨 Customization

### Adding More Products
Edit the `testProducts` array in [seedTestOrders.js](./seedTestOrders.js:23):

```javascript
const testProducts = [
    {
        name: "Your Product",
        category: "Your Category",
        price: 9999,
        description: "Product description"
    },
    // Add more...
];
```

### Changing Order Quantities
Modify the test case loops:

```javascript
// Change from 5 to 10 completed orders
for (let i = 0; i < 10; i++) {  // Changed from 5
    // order creation code...
}
```

### Adjusting Date Ranges
Modify the `getRandomPastDate()` parameter:

```javascript
// Orders from last 30 days instead of 60
const createdDate = getRandomPastDate(30);  // Changed from 60
```

---

## 🔗 Related Documentation

- [Order Model Schema](../src/models/order.models.js)
- [Order Controllers](../src/controllers/orders.controllers.js)
- [Order Routes](../src/routes/order.routes.js)
- [Business Features Documentation](../BUSINESS_FEATURES_DOCUMENTATION.md)

---

## 🤝 Need Help?

If you encounter any issues:
1. Check the console output for error messages
2. Verify your `.env` configuration
3. Ensure MongoDB is running and accessible
4. Check that you have users in your database

---

**Happy Testing! 🎉**
