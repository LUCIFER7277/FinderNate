/**
 * Comprehensive Escrow System Test
 * Tests all scenarios for payment links, orders, and escrow management
 */

import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'http://localhost:3000/api/v1';

// Test users - you'll need to update these with actual credentials
const TEST_SELLER = {
  email: 'seller@test.com',
  password: 'Test@123'
};

const TEST_BUYER = {
  email: 'buyer@test.com',
  password: 'Test@123'
};

const TEST_ADMIN = {
  email: 'admin@findernate.com',
  password: 'Admin@123'
};

let sellerToken = null;
let buyerToken = null;
let adminToken = null;
let testPostId = null;
let testOrderId = null;
let testOrderNumber = null;

const log = (emoji, message, data = null) => {
  console.log(`\n${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
};

const logSection = (title) => {
  console.log('\n' + '='.repeat(60));
  console.log(`📋 ${title}`);
  console.log('='.repeat(60));
};

// Helper to make authenticated requests
const authRequest = (token) => ({
  headers: { Authorization: `Bearer ${token}` }
});

async function loginUser(email, password, type) {
  try {
    const endpoint = type === 'admin' ? '/admin/login' : '/auth/login';
    const response = await axios.post(`${BASE_URL}${endpoint}`, { email, password });

    if (type === 'admin') {
      return response.data.data.accessToken;
    }
    return response.data.data.accessToken;
  } catch (error) {
    log('❌', `Login failed for ${email}:`, error.response?.data || error.message);
    return null;
  }
}

async function getBusinessPost(token) {
  try {
    const response = await axios.get(`${BASE_URL}/posts/my-posts?limit=1`, authRequest(token));
    const posts = response.data.data.posts;
    if (posts && posts.length > 0) {
      return posts[0]._id;
    }
    return null;
  } catch (error) {
    log('❌', 'Failed to get posts:', error.response?.data || error.message);
    return null;
  }
}

// ==========================================
// TEST 1: Shareable Payment Link Creation
// ==========================================
async function testShareablePaymentLinkCreation() {
  logSection('TEST 1: Shareable Payment Link Creation');

  if (!sellerToken || !testPostId) {
    log('⚠️', 'Skipping - no seller token or post ID');
    return false;
  }

  try {
    // Create shareable payment link
    const response = await axios.post(
      `${BASE_URL}/payments/create-shareable-link`,
      { postId: testPostId, amount: 5000 },
      authRequest(sellerToken)
    );

    log('✅', 'Shareable payment link created:', response.data.data);
    return true;
  } catch (error) {
    log('❌', 'Failed to create shareable link:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 2: Get Shareable Payment Link Details (Public)
// ==========================================
async function testGetShareablePaymentDetails() {
  logSection('TEST 2: Get Shareable Payment Link Details (Public)');

  if (!testPostId) {
    log('⚠️', 'Skipping - no post ID');
    return false;
  }

  try {
    const response = await axios.get(`${BASE_URL}/payments/post/${testPostId}/pay/5000`);
    log('✅', 'Payment details retrieved (public access):', response.data.data);
    return true;
  } catch (error) {
    log('❌', 'Failed to get payment details:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 3: Create Razorpay Order for Shareable Link (Guest)
// ==========================================
async function testCreateGuestOrder() {
  logSection('TEST 3: Create Razorpay Order for Shareable Link (Guest Checkout)');

  if (!testPostId) {
    log('⚠️', 'Skipping - no post ID');
    return false;
  }

  try {
    const response = await axios.post(`${BASE_URL}/payments/post/create-order`, {
      postId: testPostId,
      amount: 5000,
      shippingAddress: {
        fullName: 'Test Guest Buyer',
        phoneNumber: '9876543210',
        addressLine1: '123 Test Street',
        city: 'Mumbai',
        state: 'Maharashtra',
        postalCode: '400001'
      },
      buyerDetails: {
        fullName: 'Test Guest Buyer',
        email: 'guest@test.com',
        phoneNumber: '9876543210'
      }
    });

    log('✅', 'Guest order created:', {
      orderId: response.data.data.orderId,
      razorpayOrderId: response.data.data.razorpayOrderId,
      amount: response.data.data.amount
    });

    testOrderId = response.data.data.orderId;
    return true;
  } catch (error) {
    log('❌', 'Failed to create guest order:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 4: Create Order as Logged-in Buyer
// ==========================================
async function testCreateBuyerOrder() {
  logSection('TEST 4: Create Razorpay Order (Logged-in Buyer)');

  if (!testPostId || !buyerToken) {
    log('⚠️', 'Skipping - no post ID or buyer token');
    return false;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/payments/post/create-order`,
      {
        postId: testPostId,
        amount: 7500,
        shippingAddress: {
          fullName: 'Test Buyer',
          phoneNumber: '9876543211',
          addressLine1: '456 Buyer Lane',
          city: 'Delhi',
          state: 'Delhi',
          postalCode: '110001'
        }
      },
      authRequest(buyerToken)
    );

    log('✅', 'Buyer order created:', {
      orderId: response.data.data.orderId,
      razorpayOrderId: response.data.data.razorpayOrderId,
      amount: response.data.data.amount
    });

    testOrderId = response.data.data.orderId;
    return true;
  } catch (error) {
    log('❌', 'Failed to create buyer order:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 5: Simulate Payment Verification
// ==========================================
async function testPaymentVerification() {
  logSection('TEST 5: Payment Verification (Simulated)');

  if (!testOrderId) {
    log('⚠️', 'Skipping - no order ID');
    return false;
  }

  try {
    // Get order details first
    const orderResponse = await axios.get(
      `${BASE_URL}/orders/${testOrderId}`,
      authRequest(buyerToken || sellerToken)
    );

    const razorpayOrderId = orderResponse.data.data.order.razorpayOrderId;

    // Simulate payment verification (in real scenario, this comes from Razorpay)
    const razorpayPaymentId = 'pay_test_' + Date.now();
    const razorpaySignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'test_secret')
      .update(razorpayOrderId + '|' + razorpayPaymentId)
      .digest('hex');

    const response = await axios.post(
      `${BASE_URL}/payments/verify`,
      {
        orderId: testOrderId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature
      },
      authRequest(buyerToken)
    );

    log('✅', 'Payment verified:', response.data.data);
    testOrderNumber = response.data.data.order?.orderNumber;
    return true;
  } catch (error) {
    log('❌', 'Payment verification failed (expected in test):', error.response?.data?.message || error.message);
    return false;
  }
}

// ==========================================
// TEST 6: Get Buyer Orders
// ==========================================
async function testGetBuyerOrders() {
  logSection('TEST 6: Get Buyer Orders');

  if (!buyerToken) {
    log('⚠️', 'Skipping - no buyer token');
    return false;
  }

  try {
    const response = await axios.get(`${BASE_URL}/orders/buyer`, authRequest(buyerToken));
    log('✅', 'Buyer orders retrieved:', {
      total: response.data.data.total,
      orders: response.data.data.orders.map(o => ({
        orderNumber: o.orderNumber,
        status: o.orderStatus,
        paymentStatus: o.paymentStatus,
        amount: o.amount
      }))
    });

    // Get first order for testing
    if (response.data.data.orders.length > 0) {
      testOrderId = response.data.data.orders[0]._id;
      testOrderNumber = response.data.data.orders[0].orderNumber;
    }
    return true;
  } catch (error) {
    log('❌', 'Failed to get buyer orders:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 7: Get Seller Orders
// ==========================================
async function testGetSellerOrders() {
  logSection('TEST 7: Get Seller Orders');

  if (!sellerToken) {
    log('⚠️', 'Skipping - no seller token');
    return false;
  }

  try {
    const response = await axios.get(`${BASE_URL}/orders/seller`, authRequest(sellerToken));
    log('✅', 'Seller orders retrieved:', {
      total: response.data.data.total,
      orders: response.data.data.orders.map(o => ({
        orderNumber: o.orderNumber,
        status: o.orderStatus,
        paymentStatus: o.paymentStatus,
        amount: o.amount
      }))
    });

    // Get first held order for testing
    const heldOrder = response.data.data.orders.find(o => o.paymentStatus === 'held');
    if (heldOrder) {
      testOrderId = heldOrder._id;
      testOrderNumber = heldOrder.orderNumber;
    }
    return true;
  } catch (error) {
    log('❌', 'Failed to get seller orders:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 8: Seller Mark Order Shipped
// ==========================================
async function testMarkOrderShipped() {
  logSection('TEST 8: Seller Mark Order Shipped');

  if (!sellerToken || !testOrderId) {
    log('⚠️', 'Skipping - no seller token or order ID');
    return false;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/orders/${testOrderId}/ship`,
      {
        trackingId: 'TRACK123456',
        carrier: 'BlueDart'
      },
      authRequest(sellerToken)
    );

    log('✅', 'Order marked as shipped:', {
      orderNumber: response.data.data.order.orderNumber,
      status: response.data.data.order.orderStatus,
      shippingInfo: response.data.data.order.shippingInfo
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to mark order shipped:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 9: Seller Mark Order Delivered
// ==========================================
async function testMarkOrderDelivered() {
  logSection('TEST 9: Seller Mark Order Delivered');

  if (!sellerToken || !testOrderId) {
    log('⚠️', 'Skipping - no seller token or order ID');
    return false;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/orders/${testOrderId}/deliver`,
      {},
      authRequest(sellerToken)
    );

    log('✅', 'Order marked as delivered:', {
      orderNumber: response.data.data.order.orderNumber,
      status: response.data.data.order.orderStatus
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to mark order delivered:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 10: Buyer Confirm Delivery
// ==========================================
async function testBuyerConfirmDelivery() {
  logSection('TEST 10: Buyer Confirm Delivery (Releases Payment)');

  if (!buyerToken || !testOrderId) {
    log('⚠️', 'Skipping - no buyer token or order ID');
    return false;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/orders/${testOrderId}/confirm`,
      {
        rating: 5,
        review: 'Excellent product and fast delivery!'
      },
      authRequest(buyerToken)
    );

    log('✅', 'Delivery confirmed, payment released:', {
      orderNumber: response.data.data.order.orderNumber,
      orderStatus: response.data.data.order.orderStatus,
      paymentStatus: response.data.data.order.paymentStatus
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to confirm delivery:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 11: Buyer Report Issue (Creates Dispute)
// ==========================================
async function testBuyerReportIssue() {
  logSection('TEST 11: Buyer Report Issue (Creates Dispute)');

  if (!buyerToken || !testOrderId) {
    log('⚠️', 'Skipping - no buyer token or order ID');
    return false;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/orders/${testOrderId}/report`,
      {
        reason: 'Product not as described',
        description: 'The color is different from what was shown in the photos'
      },
      authRequest(buyerToken)
    );

    log('✅', 'Issue reported, dispute created:', {
      orderNumber: response.data.data.order.orderNumber,
      orderStatus: response.data.data.order.orderStatus,
      dispute: response.data.data.order.dispute
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to report issue:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 12: Admin Get All Orders
// ==========================================
async function testAdminGetAllOrders() {
  logSection('TEST 12: Admin Get All Orders');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/escrow/orders`,
      authRequest(adminToken)
    );

    log('✅', 'Admin orders retrieved:', {
      total: response.data.data.total,
      orders: response.data.data.orders.slice(0, 3).map(o => ({
        orderNumber: o.orderNumber,
        status: o.orderStatus,
        paymentStatus: o.paymentStatus,
        amount: o.amount
      }))
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to get admin orders:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 13: Admin Get Disputed Orders
// ==========================================
async function testAdminGetDisputedOrders() {
  logSection('TEST 13: Admin Get Disputed Orders');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/escrow/disputes`,
      authRequest(adminToken)
    );

    log('✅', 'Disputed orders retrieved:', {
      total: response.data.data.total,
      orders: response.data.data.orders.map(o => ({
        orderNumber: o.orderNumber,
        dispute: o.dispute,
        amount: o.amount
      }))
    });

    // Get first disputed order for resolution test
    if (response.data.data.orders.length > 0) {
      testOrderId = response.data.data.orders[0]._id;
    }
    return true;
  } catch (error) {
    log('❌', 'Failed to get disputed orders:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 14: Admin Get Escrow Dashboard
// ==========================================
async function testAdminEscrowDashboard() {
  logSection('TEST 14: Admin Escrow Dashboard');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/escrow/dashboard`,
      authRequest(adminToken)
    );

    log('✅', 'Escrow dashboard:', response.data.data);
    return true;
  } catch (error) {
    log('❌', 'Failed to get escrow dashboard:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 15: Admin Get Escrow Transactions
// ==========================================
async function testAdminEscrowTransactions() {
  logSection('TEST 15: Admin Escrow Transactions');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/escrow/transactions`,
      authRequest(adminToken)
    );

    log('✅', 'Escrow transactions:', {
      total: response.data.data.total,
      transactions: response.data.data.transactions.slice(0, 5).map(t => ({
        type: t.type,
        amount: t.amount,
        orderNumber: t.orderNumber
      }))
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to get escrow transactions:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 16: Admin Manual Release Payment
// ==========================================
async function testAdminManualRelease() {
  logSection('TEST 16: Admin Manual Release Payment');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    // First get a held order
    const ordersResponse = await axios.get(
      `${BASE_URL}/admin/escrow/orders?paymentStatus=held`,
      authRequest(adminToken)
    );

    const heldOrder = ordersResponse.data.data.orders[0];
    if (!heldOrder) {
      log('⚠️', 'No held orders to test manual release');
      return true;
    }

    const response = await axios.post(
      `${BASE_URL}/admin/escrow/orders/${heldOrder._id}/release`,
      { reason: 'Manual release for testing - verified delivery' },
      authRequest(adminToken)
    );

    log('✅', 'Payment manually released:', {
      orderNumber: response.data.data.order.orderNumber,
      paymentStatus: response.data.data.order.paymentStatus
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to manually release payment:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 17: Admin Resolve Dispute
// ==========================================
async function testAdminResolveDispute() {
  logSection('TEST 17: Admin Resolve Dispute');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    // First get a disputed order
    const ordersResponse = await axios.get(
      `${BASE_URL}/admin/escrow/disputes`,
      authRequest(adminToken)
    );

    const disputedOrder = ordersResponse.data.data.orders[0];
    if (!disputedOrder) {
      log('⚠️', 'No disputed orders to test resolution');
      return true;
    }

    const response = await axios.post(
      `${BASE_URL}/admin/escrow/disputes/${disputedOrder._id}/resolve`,
      {
        resolution: 'Verified product was as described. Releasing to seller.',
        action: 'release_seller'
      },
      authRequest(adminToken)
    );

    log('✅', 'Dispute resolved:', {
      orderNumber: response.data.data.order.orderNumber,
      orderStatus: response.data.data.order.orderStatus,
      paymentStatus: response.data.data.order.paymentStatus
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to resolve dispute:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 18: Admin Manual Refund
// ==========================================
async function testAdminManualRefund() {
  logSection('TEST 18: Admin Manual Refund');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    // First get a held order
    const ordersResponse = await axios.get(
      `${BASE_URL}/admin/escrow/orders?paymentStatus=held`,
      authRequest(adminToken)
    );

    const heldOrder = ordersResponse.data.data.orders[0];
    if (!heldOrder) {
      log('⚠️', 'No held orders to test manual refund');
      return true;
    }

    const response = await axios.post(
      `${BASE_URL}/admin/escrow/orders/${heldOrder._id}/refund`,
      {
        reason: 'Manual refund for testing - buyer complaint verified',
        refundPercentage: 100
      },
      authRequest(adminToken)
    );

    log('✅', 'Payment manually refunded:', {
      orderNumber: response.data.data.order.orderNumber,
      paymentStatus: response.data.data.order.paymentStatus
    });
    return true;
  } catch (error) {
    log('❌', 'Failed to manually refund payment:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// TEST 19: Order Analytics
// ==========================================
async function testOrderAnalytics() {
  logSection('TEST 19: Order Analytics');

  if (!adminToken) {
    log('⚠️', 'Skipping - no admin token');
    return false;
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/admin/escrow/analytics`,
      authRequest(adminToken)
    );

    log('✅', 'Order analytics:', response.data.data);
    return true;
  } catch (error) {
    log('❌', 'Failed to get analytics:', error.response?.data || error.message);
    return false;
  }
}

// ==========================================
// MAIN TEST RUNNER
// ==========================================
async function runAllTests() {
  console.log('\n' + '🚀'.repeat(30));
  console.log('COMPREHENSIVE ESCROW SYSTEM TEST');
  console.log('🚀'.repeat(30));

  const results = {
    passed: 0,
    failed: 0,
    skipped: 0
  };

  // Login all users
  logSection('AUTHENTICATION');

  log('🔐', 'Logging in seller...');
  sellerToken = await loginUser(TEST_SELLER.email, TEST_SELLER.password, 'user');
  if (sellerToken) {
    log('✅', 'Seller logged in');
    testPostId = await getBusinessPost(sellerToken);
    if (testPostId) log('✅', `Found seller post: ${testPostId}`);
  }

  log('🔐', 'Logging in buyer...');
  buyerToken = await loginUser(TEST_BUYER.email, TEST_BUYER.password, 'user');
  if (buyerToken) log('✅', 'Buyer logged in');

  log('🔐', 'Logging in admin...');
  adminToken = await loginUser(TEST_ADMIN.email, TEST_ADMIN.password, 'admin');
  if (adminToken) log('✅', 'Admin logged in');

  // Run all tests
  const tests = [
    { name: 'Shareable Payment Link Creation', fn: testShareablePaymentLinkCreation },
    { name: 'Get Shareable Payment Details', fn: testGetShareablePaymentDetails },
    { name: 'Create Guest Order', fn: testCreateGuestOrder },
    { name: 'Create Buyer Order', fn: testCreateBuyerOrder },
    { name: 'Payment Verification', fn: testPaymentVerification },
    { name: 'Get Buyer Orders', fn: testGetBuyerOrders },
    { name: 'Get Seller Orders', fn: testGetSellerOrders },
    { name: 'Mark Order Shipped', fn: testMarkOrderShipped },
    { name: 'Mark Order Delivered', fn: testMarkOrderDelivered },
    { name: 'Buyer Confirm Delivery', fn: testBuyerConfirmDelivery },
    { name: 'Buyer Report Issue', fn: testBuyerReportIssue },
    { name: 'Admin Get All Orders', fn: testAdminGetAllOrders },
    { name: 'Admin Get Disputed Orders', fn: testAdminGetDisputedOrders },
    { name: 'Admin Escrow Dashboard', fn: testAdminEscrowDashboard },
    { name: 'Admin Escrow Transactions', fn: testAdminEscrowTransactions },
    { name: 'Admin Manual Release', fn: testAdminManualRelease },
    { name: 'Admin Resolve Dispute', fn: testAdminResolveDispute },
    { name: 'Admin Manual Refund', fn: testAdminManualRefund },
    { name: 'Order Analytics', fn: testOrderAnalytics },
  ];

  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result === true) results.passed++;
      else if (result === false) results.failed++;
      else results.skipped++;
    } catch (error) {
      log('❌', `Test "${test.name}" threw error:`, error.message);
      results.failed++;
    }
  }

  // Summary
  logSection('TEST SUMMARY');
  console.log(`
  ✅ Passed:  ${results.passed}
  ❌ Failed:  ${results.failed}
  ⚠️ Skipped: ${results.skipped}
  📊 Total:   ${tests.length}
  `);

  if (results.failed === 0) {
    console.log('🎉 All tests passed! Escrow system is working correctly.');
  } else {
    console.log('⚠️ Some tests failed. Please review the errors above.');
  }
}

// Run tests
runAllTests().catch(console.error);
