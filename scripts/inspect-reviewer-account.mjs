// Read-only: confirm the Google Play reviewer account can actually reach the
// business-gated parts of the app (Play rejects when a reviewer cannot see a
// restricted feature). Performs no writes.
//
// Usage: node scripts/inspect-reviewer-account.mjs [username ...]
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('no MONGODB_URI in .env'); process.exit(1); }

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['niranjan', 'mnbhat'];

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;
console.log('connected to database:', db.databaseName);

const names = (await db.listCollections().toArray()).map(c => c.name);
const bizColl = names.find(n => /^business/i.test(n));
console.log('business collection:', bizColl || '(none found)');

const users = db.collection('users');

for (const u of targets) {
    const doc = await users.findOne({ username: new RegExp(`^${u}$`, 'i') });
    if (!doc) { console.log(`\n${u}: NOT FOUND`); continue; }

    console.log(`\n${u}:`);
    console.log('  _id              :', doc._id.toString());
    console.log('  isBusinessProfile:', doc.isBusinessProfile);
    console.log('  accountStatus    :', doc.accountStatus, '| isDeleted:', doc.isDeleted, '| isPrivate:', doc.isPrivate);
    console.log('  dateOfBirth      :', doc.dateOfBirth);

    if (bizColl) {
        const biz = await db.collection(bizColl).findOne({ userId: doc._id });
        console.log('  business doc     :', biz
            ? `YES name=${biz.businessName || '(none)'} status=${biz.status || 'n/a'} docs=${(biz.documents || []).length}`
            : 'NONE');
    }

    const sub = names.includes('subscriptions')
        ? await db.collection('subscriptions').findOne({ userId: doc._id })
        : null;
    console.log('  subscription     :', sub ? `${sub.planType || sub.plan} status=${sub.status}` : 'none');
}

await mongoose.disconnect();
