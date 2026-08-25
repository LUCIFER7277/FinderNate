/**
 * Copies every collection — documents AND index definitions — from the database
 * in MONGODB_URI into a new database on the same cluster.
 *
 * MongoDB has no "rename database". This is the copy half of a rename; it does
 * NOT drop the source. Cutover is:
 *
 *   1. node scripts/copy-db.mjs findernate      (this script)
 *   2. point MONGODB_URI at /findernate locally AND on the host, redeploy
 *   3. verify the running app
 *   4. only then drop the old database, by hand
 *
 * Re-runnable: pass --force to copy into a target that already has collections.
 * Existing documents are matched on _id and skipped, so a second run tops up
 * rather than duplicating.
 *
 * Run: node scripts/copy-db.mjs <targetDbName> [--force]
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const targetName = process.argv[2];
const force = process.argv.includes('--force');

if (!targetName) {
    console.error('usage: node scripts/copy-db.mjs <targetDbName> [--force]');
    process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,63}$/.test(targetName)) {
    console.error('Target database name has characters MongoDB will reject.');
    process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGODB_URI missing');
    process.exit(1);
}

const sourceName = new URL(uri).pathname.replace(/^\//, '') || 'test';
if (sourceName === targetName) {
    console.error('Source and target are the same database.');
    process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const src = client.db(sourceName);
const dst = client.db(targetName);

console.log(`copying  ${sourceName}  ->  ${targetName}\n`);

const existing = await dst.listCollections().toArray();
if (existing.length && !force) {
    console.error(
        `REFUSING: "${targetName}" already has ${existing.length} collection(s). ` +
        `Re-run with --force to copy into it anyway.`
    );
    await client.close();
    process.exit(1);
}

/**
 * A text index reports its key as {_fts:'text',_ftsx:1}; that form cannot be
 * passed back to createIndex. Rebuild the real key from `weights`.
 */
function normaliseIndex(idx) {
    const { v, ns, key, name, weights, background, ...rest } = idx;
    let realKey = key;
    if (key._fts === 'text' && weights) {
        realKey = {};
        for (const field of Object.keys(weights)) realKey[field] = 'text';
    }
    return { key: realKey, options: { name, ...(weights ? { weights } : {}), ...rest } };
}

const collections = (await src.listCollections().toArray())
    .filter((c) => c.type !== 'view')
    .sort((a, b) => a.name.localeCompare(b.name));

const views = (await src.listCollections().toArray()).filter((c) => c.type === 'view');

let totalCopied = 0;
let totalSkipped = 0;
let totalIndexes = 0;
const problems = [];

for (const c of collections) {
    const from = src.collection(c.name);
    const to = dst.collection(c.name);

    const srcCount = await from.countDocuments({});
    let copied = 0;
    let skipped = 0;

    if (srcCount > 0) {
        // Skip _ids already present, so --force re-runs top up instead of failing.
        const presentIds = new Set(
            (await to.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id))
        );

        const cursor = from.find({});
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            try {
                await to.insertMany(batch, { ordered: false });
                copied += batch.length;
            } catch (e) {
                // Duplicate-key races still count as present; anything else is real.
                const wrote = e?.result?.insertedCount ?? 0;
                copied += wrote;
                const dupsOnly = (e.writeErrors ?? []).every((w) => w.err?.code === 11000);
                if (!dupsOnly) problems.push(`${c.name}: ${e.message}`);
            }
            batch = [];
        };

        for await (const doc of cursor) {
            if (presentIds.has(String(doc._id))) {
                skipped += 1;
                continue;
            }
            batch.push(doc);
            if (batch.length >= 500) await flush();
        }
        await flush();
    }

    // Indexes, after the documents so unique builds see the final data.
    const idxs = (await from.indexes()).filter((i) => i.name !== '_id_');
    let madeIdx = 0;
    for (const idx of idxs) {
        const { key, options } = normaliseIndex(idx);
        try {
            await to.createIndex(key, options);
            madeIdx += 1;
        } catch (e) {
            problems.push(`${c.name} index ${idx.name}: ${e.message}`);
        }
    }

    totalCopied += copied;
    totalSkipped += skipped;
    totalIndexes += madeIdx;

    console.log(
        c.name.padEnd(28),
        `${String(copied).padStart(6)} copied`,
        skipped ? `${String(skipped).padStart(6)} already there` : ''.padStart(13),
        `${madeIdx}/${idxs.length} indexes`
    );
}

if (views.length) {
    console.log('\nviews NOT copied (recreate by hand if needed):');
    views.forEach((v) => console.log('  ', v.name));
}

// ── Verify ──────────────────────────────────────────────────────────────────
console.log('\n--- verification ---');
let mismatches = 0;
for (const c of collections) {
    const a = await src.collection(c.name).countDocuments({});
    const b = await dst.collection(c.name).countDocuments({});
    const ai = (await src.collection(c.name).indexes()).length;
    const bi = (await dst.collection(c.name).indexes()).length;
    if (a !== b || ai !== bi) {
        mismatches += 1;
        console.log(`MISMATCH ${c.name}: docs ${a} vs ${b}, indexes ${ai} vs ${bi}`);
    }
}
console.log(mismatches === 0 ? 'all collections match on document and index counts' : `${mismatches} mismatch(es)`);

console.log('\ndocuments copied:', totalCopied, ' already present:', totalSkipped, ' indexes created:', totalIndexes);
if (problems.length) {
    console.log('\nproblems:');
    problems.forEach((p) => console.log('  -', p));
}
console.log(`\nSource "${sourceName}" is untouched. Nothing was dropped.`);

await client.close();
