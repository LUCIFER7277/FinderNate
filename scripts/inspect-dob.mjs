/**
 * READ-ONLY. Reports the current state of User.dateOfBirth before any migration.
 * Writes nothing. Run: node scripts/inspect-dob.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const MIN_AGE = 18;

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGODB_URI missing from environment');
    process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
console.log('connected to database:', db.databaseName);

const users = db.collection('users');

const total = await users.countDocuments({});
const missing = await users.countDocuments({
    $or: [{ dateOfBirth: { $exists: false } }, { dateOfBirth: null }, { dateOfBirth: '' }],
});
const present = total - missing;

console.log('\n--- counts ---');
console.log('total users        :', total);
console.log('with dateOfBirth   :', present);
console.log('without dateOfBirth:', missing);

// What types are actually stored? The schema says String, but data can drift.
const byType = await users
    .aggregate([{ $group: { _id: { $type: '$dateOfBirth' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();
console.log('\n--- BSON type of dateOfBirth ---');
byType.forEach((t) => console.log(String(t._id).padEnd(10), t.n));

// Sample of distinct raw values, to confirm the string format.
const samples = await users
    .find(
        { dateOfBirth: { $nin: [null, ''] } },
        { projection: { dateOfBirth: 1, username: 1, createdAt: 1 }, limit: 15, sort: { createdAt: -1 } }
    )
    .toArray();
console.log('\n--- 15 most recent stored values ---');
samples.forEach((u) => console.log(String(u.dateOfBirth).padEnd(14), u.username));

// How many would fail the new 18+ floor?
const now = new Date();
const cutoff = new Date(now.getFullYear() - MIN_AGE, now.getMonth(), now.getDate());
let underage = 0;
let unparseable = 0;
const all = await users.find({}, { projection: { dateOfBirth: 1 } }).toArray();
for (const u of all) {
    const raw = u.dateOfBirth;
    if (raw === undefined || raw === null || raw === '') continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
        unparseable += 1;
        continue;
    }
    if (d > cutoff) underage += 1;
}
console.log('\n--- against the new 18+ floor ---');
console.log('cutoff (must be born on/before):', cutoff.toISOString().slice(0, 10));
console.log('would now be under 18          :', underage);
console.log('unparseable dateOfBirth values :', unparseable);

await mongoose.disconnect();
