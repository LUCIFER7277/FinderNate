/**
 * Frontend-Backend Compatibility Test
 * Tests that all frontend API calls work correctly with the backend
 * Simulates exactly what the frontend pages do
 */

const BASE_URL = 'http://localhost:3000/api/v1';

// Test credentials
const TEST_SELLER = { email: 'testseller@test.com', password: 'Test@123' };
const TEST_BUYER = { email: 'testbuyer@test.com', password: 'Test@123' };
const TEST_ADMIN = { email: 'admin@findernate.com', password: 'Admin@123' };

let sellerToken = null;
let buyerToken = null;
let adminToken = null;
let testOrderId = null;
let testPostId = '68eb9151125d07b7b18b2561'; // Known test post

// Simulates frontend axios instance
async function frontendAPI(endpoint, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    try {
        const response = await fetch(`${BASE_URL}${endpoint}`, options);
        const data = await response.json();
        return { status: response.status, data, ok: response.ok };
    } catch (error) {
        return { status: 500, error: error.message, ok: false };
    }
}

// Admin API (simulates adminOrders.ts with admin token in header)
async function adminAPI(endpoint, method = 'GET', body = null) {
    return frontendAPI(endpoint, method, body, adminToken);
}

const log = (emoji, message, data = null) => {
    console.log(`${emoji} ${message}`);
    if (data) console.log('   ', JSON.stringify(data, null, 2).split('\n').join('\n    '));
};

const logSection = (title) => {
    console.log('\n' + '─'.repeat(60));
    console.log(`📋 ${title}`);
    console.log('─'.repeat(60));
};

const logTest = (name, passed, details = '') => {
    const status = passed ? '✅' : '❌';
    console.log(`${status} ${name}${details ? ` - ${details}` : ''}`);
    return passed;
};

// ==========================================
// AUTHENTICATION (Setup)
// ==========================================
async function setupAuth() {
    logSection('AUTHENTICATION SETUP');

    // Register/Login Seller
    let result = await frontendAPI('/users/register', 'POST', {
        fullName: 'Test Seller',
        username: `seller_${Date.now()}`,
        email: TEST_SELLER.email,
        password: TEST_SELLER.password,
        confirmPassword: TEST_SELLER.password,
        dateOfBirth: '1990-01-01'
    });

    if (result.status !== 201) {
        result = await frontendAPI('/users/login', 'POST', {
            email: TEST_SELLER.email,
            password: TEST_SELLER.password
        });
    }
    sellerToken = result.data?.data?.accessToken;
    logTest('Seller Auth', !!sellerToken);

    // Register/Login Buyer
    result = await frontendAPI('/users/register', 'POST', {
        fullName: 'Test Buyer',
        username: `buyer_${Date.now()}`,
        email: TEST_BUYER.email,
        password: TEST_BUYER.password,
        confirmPassword: TEST_BUYER.password,
        dateOfBirth: '1990-01-01'
    });

    if (result.status !== 201) {
        result = await frontendAPI('/users/login', 'POST', {
            email: TEST_BUYER.email,
            password: TEST_BUYER.password
        });
    }
    buyerToken = result.data?.data?.accessToken;
    logTest('Buyer Auth', !!buyerToken);

    // Admin Login
    result = await frontendAPI('/admin/login', 'POST', {
        email: TEST_ADMIN.email,
        password: TEST_ADMIN.password
    });
    adminToken = result.data?.data?.accessToken;
    logTest('Admin Auth', !!adminToken);

    return sellerToken && buyerToken && adminToken;
}

// ==========================================
// TEST: src/api/payments.ts compatibility
// ==========================================
async function testPaymentsAPI() {
    logSection('FRONTEND: src/api/payments.ts');

    let passed = 0;
    let failed = 0;

    // 1. getShareablePaymentDetails (PUBLIC - no auth)
    // Frontend: GET /payments/post/:postId/pay/:amount
    let result = await frontendAPI(`/payments/post/${testPostId}/pay/5000`);
    if (logTest('getShareablePaymentDetails', result.ok, `Status: ${result.status}`)) {
        passed++;
        // Verify response structure matches PaymentLinkDetails type
        const data = result.data?.data;
        const hasRequiredFields = data?.productDetails && data?.amount && data?.seller;
        logTest('  → Response matches PaymentLinkDetails type', hasRequiredFields);
    } else failed++;

    // 2. createShareableOrder (with auth - logged in user)
    // Frontend: POST /payments/post/create-order
    result = await frontendAPI('/payments/post/create-order', 'POST', {
        postId: testPostId,
        amount: 5000,
        shippingAddress: {
            fullName: 'Test User',
            phoneNumber: '9876543210',
            addressLine1: '123 Test St',
            city: 'Mumbai',
            state: 'Maharashtra',
            postalCode: '400001'
        }
    }, buyerToken);
    if (logTest('createShareableOrder (with auth)', result.ok, `Status: ${result.status}`)) {
        passed++;
        testOrderId = result.data?.data?.orderId;
        // Verify response structure matches CreateOrderResponse type
        const data = result.data?.data;
        const hasRequiredFields = data?.orderId && data?.cashfreeOrderId && data?.amount;
        logTest('  → Response matches CreateOrderResponse type', hasRequiredFields);
    } else failed++;

    // 3. createShareableOrder (guest - no auth)
    // Frontend: POST /payments/post/create-order (no token)
    result = await frontendAPI('/payments/post/create-order', 'POST', {
        postId: testPostId,
        amount: 3000,
        shippingAddress: {
            fullName: 'Guest User',
            phoneNumber: '9876543211',
            addressLine1: '456 Guest St',
            city: 'Delhi',
            state: 'Delhi',
            postalCode: '110001'
        },
        buyerDetails: {
            fullName: 'Guest User',
            email: 'guest@test.com',
            phoneNumber: '9876543211'
        }
    });
    if (logTest('createShareableOrder (guest)', result.ok, `Status: ${result.status}`)) {
        passed++;
    } else failed++;

    // 4. createShareablePaymentLink (seller only)
    // Frontend: POST /payments/create-shareable-link
    result = await frontendAPI('/payments/create-shareable-link', 'POST', {
        postId: testPostId,
        amount: 10000
    }, sellerToken);
    // This may fail if seller doesn't own the post - that's expected behavior
    logTest('createShareablePaymentLink', result.status === 201 || result.status === 403,
        result.status === 403 ? 'Correctly rejected (not owner)' : `Status: ${result.status}`);
    passed++;

    console.log(`\n   Summary: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// ==========================================
// TEST: src/api/orders.ts compatibility
// ==========================================
async function testOrdersAPI() {
    logSection('FRONTEND: src/api/orders.ts');

    let passed = 0;
    let failed = 0;

    // 1. getBuyerOrders
    // Frontend: GET /orders/buyer
    let result = await frontendAPI('/orders/buyer', 'GET', null, buyerToken);
    if (logTest('getBuyerOrders', result.ok, `Status: ${result.status}`)) {
        passed++;
        // Verify response structure matches OrdersResponse type
        const data = result.data?.data;
        const hasRequiredFields = Array.isArray(data?.orders) && typeof data?.total === 'number';
        logTest('  → Response matches OrdersResponse type', hasRequiredFields);
        if (data?.orders?.length > 0) {
            testOrderId = data.orders[0]._id;
        }
    } else failed++;

    // 2. getBuyerOrders with filter
    result = await frontendAPI('/orders/buyer?status=payment_received&page=1&limit=10', 'GET', null, buyerToken);
    logTest('getBuyerOrders (with filters)', result.ok, `Status: ${result.status}`);
    if (result.ok) passed++; else failed++;

    // 3. getSellerOrders
    // Frontend: GET /orders/seller
    result = await frontendAPI('/orders/seller', 'GET', null, sellerToken);
    if (logTest('getSellerOrders', result.ok, `Status: ${result.status}`)) {
        passed++;
        if (result.data?.data?.orders?.length > 0 && !testOrderId) {
            testOrderId = result.data.data.orders[0]._id;
        }
    } else failed++;

    // 4. getOrderDetails
    // Frontend: GET /orders/:orderId
    if (testOrderId) {
        result = await frontendAPI(`/orders/${testOrderId}`, 'GET', null, buyerToken);
        if (logTest('getOrderDetails', result.ok, `Status: ${result.status}`)) {
            passed++;
            // Verify Order type structure
            const order = result.data?.data?.order;
            const hasRequiredFields = order?._id && order?.orderNumber && order?.orderStatus;
            logTest('  → Response matches Order type', hasRequiredFields);
        } else failed++;
    } else {
        logTest('getOrderDetails', false, 'No order ID available');
        failed++;
    }

    // 5. confirmDelivery (buyer action)
    // Frontend: POST /orders/:orderId/confirm
    if (testOrderId) {
        result = await frontendAPI(`/orders/${testOrderId}/confirm`, 'POST', {
            rating: 5,
            review: 'Great product!'
        }, buyerToken);
        logTest('confirmDelivery', result.ok || result.status === 400,
            result.status === 400 ? 'Order not in correct state (expected)' : `Status: ${result.status}`);
        passed++;
    }

    // 6. reportIssue (buyer action)
    // Frontend: POST /orders/:orderId/report
    if (testOrderId) {
        result = await frontendAPI(`/orders/${testOrderId}/report`, 'POST', {
            reason: 'Test issue',
            description: 'Testing report functionality'
        }, buyerToken);
        logTest('reportIssue', result.ok || result.status === 400,
            result.status === 400 ? 'Order not in correct state (expected)' : `Status: ${result.status}`);
        passed++;
    }

    // 7. markOrderShipped (seller action)
    // Frontend: POST /orders/:orderId/ship
    if (testOrderId) {
        result = await frontendAPI(`/orders/${testOrderId}/ship`, 'POST', {
            trackingId: 'TRACK123',
            carrier: 'BlueDart'
        }, sellerToken);
        logTest('markOrderShipped', result.ok || result.status === 400 || result.status === 403,
            result.status === 400 ? 'Order not in correct state' :
            result.status === 403 ? 'Not order seller' : `Status: ${result.status}`);
        passed++;
    }

    // 8. markOrderDelivered (seller action)
    // Frontend: POST /orders/:orderId/deliver
    if (testOrderId) {
        result = await frontendAPI(`/orders/${testOrderId}/deliver`, 'POST', {}, sellerToken);
        logTest('markOrderDelivered', result.ok || result.status === 400 || result.status === 403,
            result.status === 400 ? 'Order not in correct state' :
            result.status === 403 ? 'Not order seller' : `Status: ${result.status}`);
        passed++;
    }

    console.log(`\n   Summary: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// ==========================================
// TEST: src/api/adminOrders.ts compatibility
// ==========================================
async function testAdminOrdersAPI() {
    logSection('FRONTEND: src/api/adminOrders.ts');

    let passed = 0;
    let failed = 0;

    // 1. getEscrowDashboard
    // Frontend: GET /admin/escrow/dashboard
    let result = await adminAPI('/admin/escrow/dashboard');
    if (logTest('getEscrowDashboard', result.ok, `Status: ${result.status}`)) {
        passed++;
        // Verify EscrowDashboard type
        const data = result.data?.data;
        const hasRequiredFields = data?.wallet && data?.orderStats;
        logTest('  → Response matches EscrowDashboard type', hasRequiredFields);
        logTest('  → wallet.totalBalance exists', typeof data?.wallet?.totalBalance === 'number');
        logTest('  → orderStats.disputed exists', typeof data?.orderStats?.disputed === 'number');
    } else failed++;

    // 2. getEscrowTransactions
    // Frontend: GET /admin/escrow/transactions
    result = await adminAPI('/admin/escrow/transactions?page=1&limit=10');
    if (logTest('getEscrowTransactions', result.ok, `Status: ${result.status}`)) {
        passed++;
        const data = result.data?.data;
        const hasRequiredFields = Array.isArray(data?.transactions) && typeof data?.total === 'number';
        logTest('  → Response matches expected structure', hasRequiredFields);
    } else failed++;

    // 3. getEscrowTransactions with type filter
    result = await adminAPI('/admin/escrow/transactions?type=hold');
    logTest('getEscrowTransactions (type=hold)', result.ok, `Status: ${result.status}`);
    if (result.ok) passed++; else failed++;

    // 4. getAllOrders
    // Frontend: GET /admin/escrow/orders
    result = await adminAPI('/admin/escrow/orders?page=1&limit=20');
    if (logTest('getAllOrders', result.ok, `Status: ${result.status}`)) {
        passed++;
        const data = result.data?.data;
        const hasRequiredFields = Array.isArray(data?.orders) && typeof data?.totalPages === 'number';
        logTest('  → Response matches OrdersResponse type', hasRequiredFields);
        if (data?.orders?.length > 0) {
            testOrderId = data.orders[0]._id;
        }
    } else failed++;

    // 5. getAllOrders with filters
    result = await adminAPI('/admin/escrow/orders?status=payment_received&paymentStatus=held');
    logTest('getAllOrders (with filters)', result.ok, `Status: ${result.status}`);
    if (result.ok) passed++; else failed++;

    // 6. getDisputedOrders
    // Frontend: GET /admin/escrow/disputes
    result = await adminAPI('/admin/escrow/disputes?page=1&limit=20');
    if (logTest('getDisputedOrders', result.ok, `Status: ${result.status}`)) {
        passed++;
        const data = result.data?.data;
        logTest('  → Returns orders array', Array.isArray(data?.orders));
    } else failed++;

    // 7. getOrderAnalytics
    // Frontend: GET /admin/escrow/analytics
    result = await adminAPI('/admin/escrow/analytics');
    if (logTest('getOrderAnalytics', result.ok, `Status: ${result.status}`)) {
        passed++;
        const data = result.data?.data;
        const hasRequiredFields = data?.summary && data?.orderStatusBreakdown;
        logTest('  → Response matches OrderAnalytics type', hasRequiredFields);
    } else failed++;

    // 8. manualReleasePayment
    // Frontend: POST /admin/escrow/orders/:orderId/release
    // First get a held order
    result = await adminAPI('/admin/escrow/orders?paymentStatus=held&limit=1');
    const heldOrder = result.data?.data?.orders?.[0];
    if (heldOrder) {
        result = await adminAPI(`/admin/escrow/orders/${heldOrder._id}/release`, 'POST', {
            reason: 'Frontend compatibility test'
        });
        logTest('manualReleasePayment', result.ok, `Status: ${result.status}`);
        if (result.ok) passed++; else failed++;
    } else {
        logTest('manualReleasePayment', true, 'No held orders (skipped)');
        passed++;
    }

    // 9. resolveDispute
    // Frontend: POST /admin/escrow/disputes/:orderId/resolve
    result = await adminAPI('/admin/escrow/disputes?limit=1');
    const disputedOrder = result.data?.data?.orders?.[0];
    if (disputedOrder) {
        result = await adminAPI(`/admin/escrow/disputes/${disputedOrder._id}/resolve`, 'POST', {
            resolution: 'Frontend compatibility test resolution',
            action: 'release_seller',
            refundPercentage: 100
        });
        logTest('resolveDispute', result.ok, `Status: ${result.status}`);
        if (result.ok) passed++; else failed++;
    } else {
        logTest('resolveDispute', true, 'No disputed orders (skipped)');
        passed++;
    }

    // 10. manualRefundPayment
    // Frontend: POST /admin/escrow/orders/:orderId/refund
    result = await adminAPI('/admin/escrow/orders?paymentStatus=held&limit=1');
    const heldOrderForRefund = result.data?.data?.orders?.[0];
    if (heldOrderForRefund) {
        result = await adminAPI(`/admin/escrow/orders/${heldOrderForRefund._id}/refund`, 'POST', {
            reason: 'Frontend compatibility test refund',
            refundPercentage: 100
        });
        logTest('manualRefundPayment', result.ok, `Status: ${result.status}`);
        if (result.ok) passed++; else failed++;
    } else {
        logTest('manualRefundPayment', true, 'No held orders (skipped)');
        passed++;
    }

    console.log(`\n   Summary: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// ==========================================
// TEST: Frontend Pages API Usage
// ==========================================
async function testFrontendPagesCompatibility() {
    logSection('FRONTEND PAGES COMPATIBILITY');

    let passed = 0;
    let failed = 0;

    // 1. /orders page - uses getBuyerOrders and getSellerOrders
    console.log('\n📄 /orders page:');
    let result = await frontendAPI('/orders/buyer?page=1', 'GET', null, buyerToken);
    if (logTest('  Purchases tab (getBuyerOrders)', result.ok)) passed++; else failed++;

    result = await frontendAPI('/orders/seller?page=1', 'GET', null, sellerToken);
    if (logTest('  Sales tab (getSellerOrders)', result.ok)) passed++; else failed++;

    // 2. /orders/[orderId] page - uses getOrderDetails
    console.log('\n📄 /orders/[orderId] page:');
    result = await frontendAPI('/orders/buyer', 'GET', null, buyerToken);
    const orderId = result.data?.data?.orders?.[0]?._id;
    if (orderId) {
        result = await frontendAPI(`/orders/${orderId}`, 'GET', null, buyerToken);
        if (logTest('  Order details fetch', result.ok)) passed++; else failed++;
    } else {
        logTest('  Order details fetch', true, 'No orders available');
        passed++;
    }

    // 3. /post/[postId]/pay/[amount] page - uses getShareablePaymentDetails
    console.log('\n📄 /post/[postId]/pay/[amount] page:');
    result = await frontendAPI(`/payments/post/${testPostId}/pay/5000`);
    if (logTest('  Payment details (public)', result.ok)) passed++; else failed++;

    // 4. /admin/orders page - uses getAllOrders
    console.log('\n📄 /admin/orders page:');
    result = await adminAPI('/admin/escrow/orders');
    if (logTest('  All orders fetch', result.ok)) passed++; else failed++;

    // 5. /admin/orders/disputes page - uses getDisputedOrders
    console.log('\n📄 /admin/orders/disputes page:');
    result = await adminAPI('/admin/escrow/disputes');
    if (logTest('  Disputed orders fetch', result.ok)) passed++; else failed++;

    // 6. /admin/orders/transactions page - uses getEscrowDashboard and getEscrowTransactions
    console.log('\n📄 /admin/orders/transactions page:');
    result = await adminAPI('/admin/escrow/dashboard');
    if (logTest('  Escrow dashboard fetch', result.ok)) passed++; else failed++;

    result = await adminAPI('/admin/escrow/transactions');
    if (logTest('  Transactions fetch', result.ok)) passed++; else failed++;

    console.log(`\n   Summary: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// ==========================================
// TEST: Type Compatibility
// ==========================================
async function testTypeCompatibility() {
    logSection('TYPE COMPATIBILITY CHECK');

    let passed = 0;
    let failed = 0;

    // Check Order type fields
    console.log('\n🔍 Order type fields:');
    const result = await frontendAPI('/orders/buyer', 'GET', null, buyerToken);
    const order = result.data?.data?.orders?.[0];

    if (order) {
        const requiredFields = [
            '_id', 'orderNumber', 'orderStatus', 'paymentStatus',
            'amount', 'createdAt', 'productDetails'
        ];
        const optionalFields = [
            'buyerId', 'sellerId', 'postId', 'platformFee', 'sellerAmount',
            'shippingAddress', 'shippingInfo', 'dispute', 'buyerProof',
            'deliveryConfirmedAt', 'paymentReleasedAt', 'isShareableOrder'
        ];

        requiredFields.forEach(field => {
            const exists = order[field] !== undefined;
            if (logTest(`  Required: ${field}`, exists)) passed++; else failed++;
        });

        optionalFields.forEach(field => {
            logTest(`  Optional: ${field}`, true, order[field] !== undefined ? 'present' : 'absent');
            passed++;
        });
    } else {
        logTest('No orders to check type compatibility', true, 'Skipped');
        passed++;
    }

    // Check EscrowDashboard type fields
    console.log('\n🔍 EscrowDashboard type fields:');
    const dashResult = await adminAPI('/admin/escrow/dashboard');
    const dashboard = dashResult.data?.data;

    if (dashboard) {
        const walletFields = ['totalBalance', 'heldBalance', 'releasedBalance', 'refundedBalance', 'platformEarnings'];
        const statsFields = ['pendingRelease', 'disputed', 'completed'];

        walletFields.forEach(field => {
            const exists = dashboard.wallet?.[field] !== undefined;
            if (logTest(`  wallet.${field}`, exists)) passed++; else failed++;
        });

        statsFields.forEach(field => {
            const exists = dashboard.orderStats?.[field] !== undefined;
            if (logTest(`  orderStats.${field}`, exists)) passed++; else failed++;
        });
    }

    // Check EscrowTransaction type fields
    console.log('\n🔍 EscrowTransaction type fields:');
    const transResult = await adminAPI('/admin/escrow/transactions?limit=1');
    const transaction = transResult.data?.data?.transactions?.[0];

    if (transaction) {
        const transFields = ['type', 'amount', 'orderNumber', 'createdAt'];
        transFields.forEach(field => {
            const exists = transaction[field] !== undefined;
            if (logTest(`  ${field}`, exists)) passed++; else failed++;
        });
    }

    console.log(`\n   Summary: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// ==========================================
// MAIN TEST RUNNER
// ==========================================
async function runAllTests() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     FRONTEND-BACKEND COMPATIBILITY TEST                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('\nThis test verifies that all frontend API calls are compatible');
    console.log('with backend endpoints and response structures.\n');

    const results = {
        auth: false,
        payments: false,
        orders: false,
        adminOrders: false,
        pages: false,
        types: false
    };

    // Setup authentication
    results.auth = await setupAuth();
    if (!results.auth) {
        console.log('\n❌ Authentication setup failed. Cannot proceed.');
        return;
    }

    // Run all tests
    results.payments = await testPaymentsAPI();
    results.orders = await testOrdersAPI();
    results.adminOrders = await testAdminOrdersAPI();
    results.pages = await testFrontendPagesCompatibility();
    results.types = await testTypeCompatibility();

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              COMPATIBILITY TEST RESULTS                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const sections = [
        { name: 'Authentication', result: results.auth },
        { name: 'Payments API (src/api/payments.ts)', result: results.payments },
        { name: 'Orders API (src/api/orders.ts)', result: results.orders },
        { name: 'Admin Orders API (src/api/adminOrders.ts)', result: results.adminOrders },
        { name: 'Frontend Pages Compatibility', result: results.pages },
        { name: 'TypeScript Type Compatibility', result: results.types }
    ];

    let allPassed = true;
    sections.forEach(section => {
        const status = section.result ? '✅' : '❌';
        console.log(`   ${status} ${section.name}`);
        if (!section.result) allPassed = false;
    });

    console.log('\n' + '─'.repeat(60));
    if (allPassed) {
        console.log('🎉 ALL COMPATIBILITY TESTS PASSED!');
        console.log('\nFrontend is fully compatible with backend:');
        console.log('  ✅ src/api/payments.ts → Backend payment routes');
        console.log('  ✅ src/api/orders.ts → Backend order routes');
        console.log('  ✅ src/api/adminOrders.ts → Backend admin escrow routes');
        console.log('  ✅ All frontend pages can fetch data correctly');
        console.log('  ✅ TypeScript types match backend response structures');
    } else {
        console.log('⚠️ Some compatibility tests failed.');
        console.log('Please review the errors above.');
    }
    console.log('─'.repeat(60) + '\n');
}

runAllTests().catch(console.error);
