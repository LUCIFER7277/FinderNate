/**
 * Restores User.dateOfBirth from a backup written by migrate-dob-to-20-years.mjs.
 *
 * Run: node scripts/restore-dob.mjs "../../dob-backup-2026-08-24.json"
 *
 * Only touches users listed in the backup, and only the dateOfBirth field. Users
 * whose backed-up value was null are skipped rather than having the field
 * cleared, so a restore cannot invent an absence that wasn't there.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const backupArg = process.argv[2];
if (!backupArg) {
    console.error('usage: node scripts/restore-dob.mjs <backup-file.json>');
    process.exit(1);
}

const backupPath = resolve(process.cwd(), backupArg);
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));

if (backup.field !== 'dateOfBirth' || !Array.isArray(backup.users)) {
    console.error('That file does not look like a dateOfBirth backup.');
    process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGODB_URI missing from environment');
    process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
const users = db.collection('users');

console.log('database   :', db.databaseName);
console.log('backup from:', backup.takenAt, `(${backup.count} records)`);

if (backup.database && backup.database !== db.databaseName) {
    console.error(
        `\nREFUSING: backup was taken from database "${backup.database}" but ` +
        `the current connection is "${db.databaseName}".`
    );
    await mongoose.disconnect();
    process.exit(1);
}

let restored = 0;
let skipped = 0;
for (const u of backup.users) {
    if (u.dateOfBirth === null || u.dateOfBirth === undefined) {
        skipped += 1;
        continue;
    }
    const res = await users.updateOne(
        { _id: new mongoose.Types.ObjectId(u._id) },
        { $set: { dateOfBirth: u.dateOfBirth } }
    );
    if (res.matchedCount) {
        restored += 1;
        console.log('restored', String(u.dateOfBirth).padEnd(14), u.username);
    } else {
        console.log('NOT FOUND (skipped)', u.username, u._id);
    }
}

console.log(`\nrestored: ${restored}  skipped (no stored value): ${skipped}`);
await mongoose.disconnect();
