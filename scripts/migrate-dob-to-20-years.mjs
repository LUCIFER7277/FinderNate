/**
 * Sets User.dateOfBirth for every user to a date exactly 20 years before today.
 *
 * Context: the signup age floor moved from 13 to 18 (see MIN_SIGNUP_AGE in
 * controllers/user/_helpers.js). Existing accounts predate that floor and one of
 * them fails it. Requested behaviour is to normalise every account to 20 years.
 *
 * dateOfBirth is a STRING on the schema, stored as 'yyyy-MM-dd'. This writes the
 * same shape — do not turn it into a Date, the app parses it with split('-').
 *
 * Backs every current value up to a JSON file before writing. Reversible with
 * scripts/restore-dob.mjs <backup-file>.
 *
 * Run: node scripts/migrate-dob-to-20-years.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const TARGET_AGE_YEARS = 20;
const MIN_AGE = 18;

const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const now = new Date();
// Calendar arithmetic, matching defaultPickerBirthDate() in the app and website.
const targetDate = new Date(now.getFullYear() - TARGET_AGE_YEARS, now.getMonth(), now.getDate());
const targetYMD = toYMD(targetDate);

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGODB_URI missing from environment');
    process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
const users = db.collection('users');
console.log('database :', db.databaseName);
console.log('target   :', targetYMD, `(${TARGET_AGE_YEARS} years before today)`);

// ── 1. Back up ──────────────────────────────────────────────────────────────
const before = await users
    .find({}, { projection: { _id: 1, username: 1, email: 1, dateOfBirth: 1 } })
    .toArray();

const backup = {
    takenAt: now.toISOString(),
    database: db.databaseName,
    collection: 'users',
    field: 'dateOfBirth',
    note: `Values immediately before setting every user to ${targetYMD}.`,
    count: before.length,
    users: before.map((u) => ({
        _id: String(u._id),
        username: u.username ?? null,
        email: u.email ?? null,
        dateOfBirth: u.dateOfBirth ?? null,
    })),
};

const backupPath = resolve(
    process.cwd(),
    '..',
    '..',
    `dob-backup-${toYMD(now)}.json`
);
writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
console.log('\nbacked up', before.length, 'records to:\n ', backupPath);

console.log('\n--- before ---');
before.forEach((u) => console.log(String(u.dateOfBirth ?? '(none)').padEnd(14), u.username));

// ── 2. Write ────────────────────────────────────────────────────────────────
const res = await users.updateMany({}, { $set: { dateOfBirth: targetYMD } });
console.log('\nmatched:', res.matchedCount, ' modified:', res.modifiedCount);

// ── 3. Verify ───────────────────────────────────────────────────────────────
const after = await users
    .find({}, { projection: { username: 1, dateOfBirth: 1 } })
    .toArray();
console.log('\n--- after ---');
after.forEach((u) => console.log(String(u.dateOfBirth).padEnd(14), u.username));

const cutoff = new Date(now.getFullYear() - MIN_AGE, now.getMonth(), now.getDate());
const stillUnderage = after.filter((u) => {
    const d = new Date(u.dateOfBirth);
    return Number.isNaN(d.getTime()) || d > cutoff;
});
console.log('\nstill failing the 18+ floor:', stillUnderage.length);

// Informational only — pending registrations are not accounts yet, not touched.
const tempCount = await db.collection('tempusers').countDocuments({}).catch(() => 0);
console.log('tempusers (untouched):', tempCount);

await mongoose.disconnect();
console.log('\ndone.');
