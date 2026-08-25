/**
 * READ-ONLY. Inventories the current database: collections, document counts,
 * storage size, and index definitions. Writes nothing.
 *
 * Run: node scripts/survey-db.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGODB_URI missing');
    process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
console.log('database:', db.databaseName, '\n');

const stats = await db.command({ dbStats: 1 });
console.log('collections :', stats.collections);
console.log('objects     :', stats.objects);
console.log('dataSize    :', (stats.dataSize / 1024 / 1024).toFixed(2), 'MB');
console.log('storageSize :', (stats.storageSize / 1024 / 1024).toFixed(2), 'MB');
console.log('indexes     :', stats.indexes);
console.log('indexSize   :', (stats.indexSize / 1024 / 1024).toFixed(2), 'MB');

const cols = (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name));

console.log('\n--- collections ---');
let totalDocs = 0;
let nonDefaultIndexes = 0;
for (const c of cols) {
    const coll = db.collection(c.name);
    const n = await coll.countDocuments({});
    totalDocs += n;
    const idx = await coll.indexes();
    const extra = idx.filter((i) => i.name !== '_id_');
    nonDefaultIndexes += extra.length;
    console.log(
        String(c.name).padEnd(28),
        String(n).padStart(7),
        'docs  ',
        `${extra.length} non-_id index(es)`,
        c.type === 'view' ? '  [VIEW]' : ''
    );
    for (const i of extra) {
        const flags = [
            i.unique ? 'unique' : null,
            i.sparse ? 'sparse' : null,
            i.expireAfterSeconds !== undefined ? `ttl=${i.expireAfterSeconds}s` : null,
            i.partialFilterExpression ? 'partial' : null,
            i['2dsphere'] || JSON.stringify(i.key).includes('2dsphere') ? 'geo' : null,
        ]
            .filter(Boolean)
            .join(',');
        console.log('    ', i.name.padEnd(40), JSON.stringify(i.key), flags ? `(${flags})` : '');
    }
}
console.log('\ntotal documents:', totalDocs);
console.log('total non-_id indexes:', nonDefaultIndexes);

await mongoose.disconnect();
