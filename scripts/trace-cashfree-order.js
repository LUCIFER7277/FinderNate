/**
 * Trace one Cashfree payment end to end: what our DB thinks happened, and what
 * Cashfree actually did. Written for the case where a buyer was shown "Payment
 * Failed" but their bank debited them anyway — the two sides disagree and you
 * need to know which one is right before refunding or apologising.
 *
 *   node scripts/trace-cashfree-order.js CF-MS7UDU6J-W65D53
 *
 * Read-only. It changes nothing; it prints a verdict and, if the order needs
 * repairing, the exact update to run.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Order from '../src/models/order.models.js';
import { getCashfreeOrderStatus } from '../src/config/cashfree.config.js';

const ref = process.argv[2];

if (!ref) {
    console.error('Usage: node scripts/trace-cashfree-order.js <cashfreeOrderId>');
    console.error('The reference is shown on the failure screen, e.g. CF-MS7UDU6J-W65D53');
    process.exit(1);
}

/** Money is held under `held`; `paid` is the webhook's intermediate state. */
const SETTLED = ['held', 'released', 'paid'];

async function main() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set — run this with the backend .env loaded.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);

    // The webhook and the verify endpoint both key off cashfreeOrderId, so that
    // is the field to search. Fall back to _id in case a raw order id is passed.
    let order = await Order.findOne({ cashfreeOrderId: ref });
    if (!order && mongoose.isValidObjectId(ref)) {
        order = await Order.findById(ref);
    }

    console.log('\n=== OUR DATABASE ===');
    if (!order) {
        console.log(`No Order found for "${ref}".`);
        console.log('That means create-order never persisted, so the charge is');
        console.log('unlinked on our side and Cashfree is the only record.');
    } else {
        console.log(`orderNumber    : ${order.orderNumber}`);
        console.log(`_id            : ${order._id}`);
        console.log(`buyerId        : ${order.buyerId ?? '(none — guest checkout)'}`);
        console.log(`amount         : ${order.amount}`);
        console.log(`paymentStatus  : ${order.paymentStatus}`);
        console.log(`orderStatus    : ${order.orderStatus}`);
        console.log(`cashfreeOrderId: ${order.cashfreeOrderId}`);
        console.log(`createdAt      : ${order.createdAt?.toISOString?.() ?? 'n/a'}`);
    }

    console.log('\n=== CASHFREE (source of truth) ===');
    let cf = null;
    try {
        cf = await getCashfreeOrderStatus(order?.cashfreeOrderId || ref);
        console.log(`order_status   : ${cf?.order_status}`);
        console.log(`order_amount   : ${cf?.order_amount}`);
    } catch (err) {
        console.log(`Lookup failed: ${err?.message || err}`);
        console.log('Check CASHFREE_ENV and the API credentials in .env.');
    }

    console.log('\n=== VERDICT ===');
    const cfPaid = cf?.order_status === 'PAID';
    const oursSettled = order ? SETTLED.includes(order.paymentStatus) : false;

    if (cfPaid && oursSettled) {
        console.log('Money taken, order recorded. Nothing to repair — the buyer');
        console.log('saw a failure screen but their order is real. Tell them it');
        console.log('went through; do NOT refund on the strength of that screen.');
    } else if (cfPaid && order && !oursSettled) {
        console.log('MISMATCH: Cashfree took the money, our order is still');
        console.log(`"${order.paymentStatus}". The webhook did not land. Either replay`);
        console.log('it from the Cashfree dashboard, or repair directly:');
        console.log('');
        console.log(`  db.orders.updateOne({ _id: ObjectId("${order._id}") },`);
        console.log(`    { $set: { paymentStatus: "held", orderStatus: "payment_received" } })`);
        console.log('');
        console.log('Confirm the seller payout/escrow side after repairing.');
    } else if (cfPaid && !order) {
        console.log('MISMATCH: Cashfree took the money and we have no order at');
        console.log('all. This one needs a manual refund — there is nothing to');
        console.log('fulfil against.');
    } else {
        console.log('Cashfree does not report this as PAID, so no money is owed');
        console.log('to the buyer. If their bank still debited them, it is a');
        console.log('pending authorisation that will drop off on its own.');
    }

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
