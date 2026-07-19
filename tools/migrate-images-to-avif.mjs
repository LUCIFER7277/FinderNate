#!/usr/bin/env node
/**
 * migrate-images-to-avif.mjs
 * ==========================
 * Converts every EXISTING stored image (jpg/jpeg/png/webp on the Bunny CDN)
 * to web-optimized AVIF and rewrites all MongoDB references to point at the
 * new files. Originals are NEVER deleted, so rollback = restoring the old
 * URLs from the map file this script writes.
 *
 * Safety properties
 *  - Idempotent/resumable: progress persists to tools/avif-migration-map.json
 *    after every conversion; re-running skips completed work.
 *  - Dry-run mode makes ZERO writes (no storage uploads, no DB updates).
 *  - Skips: .gif (animation would be flattened), the KYC 'documents/' folder,
 *    and Order buyerProof / dispute evidence (legal originals must stay
 *    bit-exact). External (non-Bunny) URLs are never touched.
 *  - Thumbnail URLs are query-param variants of the same object — the query
 *    string is preserved when the base URL is swapped.
 *
 * Usage (run from the backend root):
 *   node tools/migrate-images-to-avif.mjs --dry-run          # report only
 *   node tools/migrate-images-to-avif.mjs                    # convert + rewrite
 *   node tools/migrate-images-to-avif.mjs --flush-cache      # also clear fn:* redis keys
 *   node tools/migrate-images-to-avif.mjs --collection posts # single collection
 *   node tools/migrate-images-to-avif.mjs --limit 100        # cap conversions this run
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import mongoose from 'mongoose';
import { convertImageForWeb } from '../src/utils/bunny.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_FILE = path.join(__dirname, 'avif-migration-map.json');

const CDN_URL = (process.env.BUNNY_CDN_URL || '').replace(/\/+$/, '');
const STORAGE_API_URL = (process.env.BUNNY_STORAGE_API_URL || '').replace(/\/+$/, '');
const ACCESS_KEY = process.env.BUNNY_ACCESS_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FLUSH_CACHE = args.includes('--flush-cache');
const onlyCollection = args.includes('--collection')
    ? args[args.indexOf('--collection') + 1]
    : null;
const rawLimit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10)
    : Infinity;
if (Number.isNaN(rawLimit)) {
    console.error('--limit requires a number, e.g. --limit 100');
    process.exit(1);
}
const LIMIT = rawLimit;

// Collections that hold media URLs (from the full model inventory).
// diagnosticlogs intentionally excluded.
const COLLECTIONS = [
    'users', 'admins', 'posts', 'stories', 'reels', 'messages', 'chats',
    // NOTE: mongoose treats 'media' as uncountable, so the Media model's
    // collection is 'media', NOT 'medias'.
    'businesses', 'media', 'drafts', 'orders', 'paymentlinks',
    'advertisements', 'events', 'badges',
];

// Storage folders / document paths whose files must stay untouched.
const SKIP_FOLDER_PREFIXES = ['documents/'];
const SKIP_KEY_PATH_PARTS = ['buyerProof', 'dispute'];

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const CONCURRENCY = 3;

// ── URL helpers ──────────────────────────────────────────────────────────────

/** Splits a stored URL into { base, query } (query keeps its leading '?'). */
const splitUrl = (url) => {
    const qIndex = url.indexOf('?');
    return qIndex === -1
        ? { base: url, query: '' }
        : { base: url.slice(0, qIndex), query: url.slice(qIndex) };
};

/** Storage path for a CDN URL base (no query), or null if not our CDN. */
const storagePathOf = (base) =>
    base.startsWith(`${CDN_URL}/`) ? base.slice(CDN_URL.length + 1) : null;

/** True when this base URL is an eligible stored image we should convert. */
const isEligibleImageBase = (base, keyPath) => {
    const storagePath = storagePathOf(base);
    if (!storagePath) return false;
    if (SKIP_FOLDER_PREFIXES.some((p) => storagePath.startsWith(p))) return false;
    if (SKIP_KEY_PATH_PARTS.some((part) => keyPath.includes(part))) return false;
    const ext = storagePath.split('.').pop().toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
};

// ── Recursive document walker ────────────────────────────────────────────────
// Visits every string leaf; visit(keyPath, value) may return a replacement.
const walkAndRewrite = (node, visit, keyPath = '', out = []) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
        node.forEach((item, i) => {
            const childPath = keyPath ? `${keyPath}.${i}` : String(i);
            if (typeof item === 'string') {
                const replacement = visit(childPath, item);
                if (replacement !== undefined) out.push({ path: childPath, value: replacement });
            } else {
                walkAndRewrite(item, visit, childPath, out);
            }
        });
        return out;
    }
    if (typeof node === 'object') {
        // Plain objects only — leave ObjectId/Date/Buffer/etc. untouched.
        if (node._bsontype || node instanceof Date) return out;
        for (const [key, value] of Object.entries(node)) {
            if (key === '_id') continue;
            const childPath = keyPath ? `${keyPath}.${key}` : key;
            if (typeof value === 'string') {
                const replacement = visit(childPath, value);
                if (replacement !== undefined) out.push({ path: childPath, value: replacement });
            } else {
                walkAndRewrite(value, visit, childPath, out);
            }
        }
    }
    return out;
};

// ── Conversion map (resume + rollback record) ────────────────────────────────
const loadMap = () => {
    try {
        const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
        // The map doubles as the rollback record — snapshot it before this
        // run appends to it.
        fs.copyFileSync(MAP_FILE, `${MAP_FILE}.${Date.now()}.bak`);
        return map;
    } catch {
        return {};
    }
};
const saveMap = (map) => {
    // Atomic write (temp + rename) so a mid-write kill can't truncate the
    // only record of old->new URLs.
    const tmp = `${MAP_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 1));
    fs.renameSync(tmp, MAP_FILE);
};

// ── Bunny download / upload ──────────────────────────────────────────────────
const downloadImage = async (base) => {
    const response = await axios.get(base, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024,
    });
    return Buffer.from(response.data);
};

const uploadAvif = async (storagePath, buffer) => {
    const response = await axios.put(`${STORAGE_API_URL}/${storagePath}`, buffer, {
        headers: {
            'AccessKey': ACCESS_KEY,
            'Content-Type': 'image/avif',
            'Content-Length': buffer.length,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000,
    });
    if (response.status !== 201) {
        throw new Error(`Bunny upload returned ${response.status}`);
    }
};

// Tiny concurrency pool (avoids adding a p-limit dependency).
const runPool = async (items, worker, concurrency) => {
    const queue = [...items];
    const runners = Array.from({ length: concurrency }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            await worker(item);
        }
    });
    await Promise.all(runners);
};

// ── Main ─────────────────────────────────────────────────────────────────────
const main = async () => {
    for (const [name, value] of Object.entries({ CDN_URL, STORAGE_API_URL, ACCESS_KEY })) {
        if (!value) throw new Error(`Missing env for ${name} — run from the backend root with .env present`);
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

    console.log(`\n=== AVIF migration ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE)'} ===\n`);
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;

    const collections = onlyCollection ? [onlyCollection] : COLLECTIONS;
    const map = loadMap(); // oldBase -> newBase (completed conversions)

    // ── Pass 1: inventory every eligible image base URL ──
    const eligible = new Set();
    for (const collName of collections) {
        const coll = db.collection(collName);
        const count = await coll.countDocuments();
        let found = 0;
        const cursor = coll.find({}, { batchSize: 200 });
        for await (const doc of cursor) {
            walkAndRewrite(doc, (keyPath, value) => {
                const { base } = splitUrl(value);
                if (isEligibleImageBase(base, keyPath)) {
                    eligible.add(base);
                    found += 1;
                }
                return undefined; // inventory only
            });
        }
        console.log(`inventory: ${collName.padEnd(15)} docs=${String(count).padEnd(7)} image refs=${found}`);
    }

    const toConvert = [...eligible].filter((base) => !map[base]);
    console.log(`\nUnique eligible images: ${eligible.size}`);
    console.log(`Already converted (map): ${eligible.size - toConvert.length}`);
    console.log(`To convert this run:     ${Math.min(toConvert.length, LIMIT)}\n`);

    if (DRY_RUN) {
        // Estimate savings from a small sample.
        const sample = toConvert.slice(0, 5);
        for (const base of sample) {
            try {
                const original = await downloadImage(base);
                const avif = await convertImageForWeb(original);
                if (avif) {
                    console.log(`sample: ${storagePathOf(base)}  ${original.length}B -> ${avif.length}B (${Math.round(100 - (avif.length / original.length) * 100)}% smaller)`);
                }
            } catch (error) {
                console.log(`sample failed: ${base}: ${error.message}`);
            }
        }
        await mongoose.disconnect();
        console.log('\nDry run complete — no changes made.');
        return;
    }

    // ── Pass 2: convert + upload (bounded concurrency, resumable) ──
    let converted = 0;
    let failed = 0;
    let processedThisRun = 0;
    await runPool(toConvert, async (base) => {
        if (processedThisRun >= LIMIT) return;
        processedThisRun += 1;
        try {
            const original = await downloadImage(base);
            const avif = await convertImageForWeb(original);
            if (!avif) {
                failed += 1;
                console.warn(`skip (unconvertible): ${base}`);
                return;
            }
            const oldStoragePath = storagePathOf(base);
            const newStoragePath = oldStoragePath.replace(/\.[a-zA-Z0-9]+$/, '.avif');
            await uploadAvif(newStoragePath, avif);
            map[base] = `${CDN_URL}/${newStoragePath}`;
            saveMap(map);
            converted += 1;
            if (converted % 25 === 0) console.log(`converted ${converted}/${toConvert.length}…`);
        } catch (error) {
            failed += 1;
            console.error(`FAILED ${base}: ${error.message}`);
        }
    }, CONCURRENCY);
    console.log(`\nConversion done: ${converted} converted, ${failed} failed/skipped.\n`);

    // ── Pass 3: rewrite every reference in every collection ──
    // Every $set is guarded on the CURRENT old value at that exact path, so a
    // concurrent app write that moved/removed an array element between our
    // snapshot read and the update becomes a harmless no-op (a re-run picks
    // it up) instead of corrupting the wrong element.
    let docsUpdated = 0;
    let pathsRewritten = 0;
    for (const collName of collections) {
        const coll = db.collection(collName);
        let updatedHere = 0;
        const cursor = coll.find({}, { batchSize: 200 });
        for await (const doc of cursor) {
            const changes = [];
            walkAndRewrite(doc, (keyPath, value) => {
                // Legal-evidence fields keep their original references.
                if (SKIP_KEY_PATH_PARTS.some((part) => keyPath.includes(part))) {
                    return undefined;
                }
                const { base, query } = splitUrl(value);
                const newBase = map[base];
                if (newBase) {
                    changes.push({ path: keyPath, oldValue: value, value: `${newBase}${query}` });
                }
                return undefined; // we update guarded per-path below, not via walker output
            });
            if (changes.length > 0) {
                let docChanged = false;
                for (const change of changes) {
                    const result = await coll.updateOne(
                        { _id: doc._id, [change.path]: change.oldValue },
                        { $set: { [change.path]: change.value } },
                    );
                    if (result.modifiedCount > 0) {
                        pathsRewritten += 1;
                        docChanged = true;
                    }
                }
                if (docChanged) {
                    updatedHere += 1;
                    docsUpdated += 1;
                }
            }
        }
        console.log(`rewrite: ${collName.padEnd(15)} docs updated=${updatedHere}`);
    }
    console.log(`\nTotal documents updated: ${docsUpdated} (${pathsRewritten} URL fields rewritten)`);

    // ── Optional: flush app caches so old URLs stop being served from Redis ──
    if (FLUSH_CACHE) {
        const { default: Redis } = await import('ioredis');
        const redis = new Redis({
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT || 6379),
            password: process.env.REDIS_PASSWORD || undefined,
            db: Number(process.env.REDIS_DB || 0),
        });
        let deleted = 0;
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', 'fn:*', 'COUNT', 500);
            cursor = next;
            if (keys.length > 0) {
                await redis.del(...keys);
                deleted += keys.length;
            }
        } while (cursor !== '0');
        await redis.quit();
        console.log(`Redis cache keys cleared: ${deleted}`);
    }

    await mongoose.disconnect();
    console.log(`\nMigration complete. Old->new URL map saved to ${MAP_FILE}`);
    console.log('Originals were NOT deleted — keep the map file for rollback.');
};

main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
});
