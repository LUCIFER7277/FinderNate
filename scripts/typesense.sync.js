/**
 * MongoDB -> Typesense real-time sync worker (change streams).
 *
 *   npm run typesense:sync
 *
 * Opens ONE database-level change stream and mirrors inserts/updates/deletes for
 * the users, businesses and posts collections into Typesense. Because it watches
 * the oplog, it is AGNOSTIC to how the write happened (save, updateOne,
 * findOneAndUpdate, bulkWrite, insertMany, ...) — unlike Mongoose middleware.
 *
 * Guarantees:
 *   - Events are processed SERIALLY (concurrency 1) in oplog order, so rapid
 *     successive edits to the same doc can't land out of order.
 *   - The resume token is persisted ONLY after a change is successfully indexed.
 *     If a Typesense write fails, we do NOT advance the token; we restart from the
 *     last good token so the change is replayed (at-least-once, idempotent upsert).
 *
 * ⚠️  Run this in EXACTLY ONE process (a dedicated Coolify/PM2 worker). Requires a
 *     MongoDB replica set (Atlas is one) for change streams.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../db/index.js';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import Post from '../models/userPost.models.js';
import { redisClient } from '../config/redis.config.js';
import { isTypesenseEnabled } from '../config/typesense.config.js';
import { ensureCollections, indexUser, indexPost, removeUser, removePost } from '../services/typesense/index.js';

dotenv.config();

const RESUME_KEY = 'typesense:sync:resumeToken';
const BIZ2USER_PREFIX = 'typesense:sync:biz2user:';   // maps businessId -> userId (for business deletes)
const WATCHED = new Set(['users', 'businesses', 'posts']);

let changeStream = null;
let queue = Promise.resolve();   // serialization chain (concurrency 1)
let restarting = false;
let shuttingDown = false;

const saveResumeToken = async (token) => {
    try { await redisClient.set(RESUME_KEY, JSON.stringify(token)); } catch { /* non-fatal */ }
};

/** Re-index all of a user's posts (used when their denormalized author fields change). */
const reindexUserPosts = async (userId, author) => {
    const cursor = Post.find({ userId }).lean().cursor();
    for (let post = await cursor.next(); post != null; post = await cursor.next()) {
        await indexPost(post, author);
    }
};

const reindexUserById = async (userId) => {
    if (!userId) return;
    const user = await User.findById(userId).lean();
    if (!user) return removeUser(userId);
    const business = await Business.findOne({ userId }).lean();
    await indexUser(user, business);
};

const handleUser = async (change) => {
    const id = change.documentKey?._id;
    if (change.operationType === 'delete') return removeUser(id);
    const user = change.fullDocument;
    if (!user) return;

    const business = await Business.findOne({ userId: user._id }).lean();
    await indexUser(user, business);

    // If display fields changed, refresh the denormalized author fields on the user's
    // posts. insert => no posts yet (no-op); replace/update-of-those-fields => refresh.
    const uf = change.updateDescription?.updatedFields;
    const authorFieldsChanged =
        change.operationType !== 'update' ||
        (uf && ('username' in uf || 'profileImageUrl' in uf));
    if (authorFieldsChanged) {
        await reindexUserPosts(user._id, { username: user.username, profileImageUrl: user.profileImageUrl });
    }
};

const handleBusiness = async (change) => {
    const bizId = change.documentKey?._id;
    if (change.operationType === 'delete') {
        // Change streams don't carry the deleted doc; use our cached bizId->userId map.
        let userId = null;
        try { userId = await redisClient.get(BIZ2USER_PREFIX + bizId); } catch { /* ignore */ }
        if (userId) {
            await reindexUserById(userId);            // re-index user, now without a business
            try { await redisClient.del(BIZ2USER_PREFIX + bizId); } catch { /* ignore */ }
        }
        return;
    }
    const biz = change.fullDocument;
    if (!biz?.userId) return;
    try { await redisClient.set(BIZ2USER_PREFIX + bizId, String(biz.userId)); } catch { /* ignore */ }
    await reindexUserById(biz.userId);
};

const handlePost = async (change) => {
    const id = change.documentKey?._id;
    if (change.operationType === 'delete') return removePost(id);
    const post = change.fullDocument;
    if (!post) return;
    const author = await User.findById(post.userId).select('username profileImageUrl').lean();
    await indexPost(post, author);
};

/**
 * Process one change to completion, THEN persist its resume token. On failure we
 * throw so the queue stops advancing and the stream restarts from the last good token.
 */
const dispatch = async (change) => {
    if (restarting || shuttingDown) return;
    const coll = change.ns?.coll;
    if (!WATCHED.has(coll)) { await saveResumeToken(change._id); return; }

    if (coll === 'users') await handleUser(change);
    else if (coll === 'businesses') await handleBusiness(change);
    else if (coll === 'posts') await handlePost(change);

    await saveResumeToken(change._id); // only advance AFTER successful index
};

const triggerRestart = async () => {
    if (restarting || shuttingDown) return;
    restarting = true;
    console.warn('↻ Restarting change stream from last saved token in 3s...');
    try { if (changeStream) await changeStream.close(); } catch { /* ignore */ }
    setTimeout(() => {
        restarting = false;
        // Self-heal: if start() itself throws (e.g. transient DB blip), schedule another
        // attempt rather than leaving the worker alive-but-not-syncing.
        start().catch((e) => {
            console.error('restart failed:', e.message);
            triggerRestart();
        });
    }, 3000);
};

/** Serialize: append each change to the promise chain so they run one at a time, in order. */
const enqueue = (change) => {
    queue = queue.then(async () => {
        if (restarting || shuttingDown) return;
        try {
            await dispatch(change);
        } catch (err) {
            console.error(`sync dispatch error [${change.ns?.coll}/${change.operationType}]:`, err.message);
            await triggerRestart(); // do NOT advance token; last good token replays this change
        }
    });
};

const start = async () => {
    let resumeAfter;
    try {
        const raw = await redisClient.get(RESUME_KEY);
        if (raw) resumeAfter = JSON.parse(raw);
    } catch { /* ignore */ }

    const fresh = !resumeAfter;
    const options = { fullDocument: 'updateLookup' };
    if (resumeAfter) {
        options.resumeAfter = resumeAfter;
        console.log('🔄 Resuming change stream from saved token');
    } else {
        console.log('🟢 Starting change stream from now (no saved token)');
    }

    // Server-side filter: only stream the 3 collections we mirror.
    const pipeline = [{ $match: { 'ns.coll': { $in: [...WATCHED] } } }];
    changeStream = mongoose.connection.db.watch(pipeline, options);

    // Fresh start: persist the FIRST resume token (the position just BEFORE the first
    // change) as a baseline, so if the very first change fails to index we can replay
    // it instead of skipping. Fires once; success-based saves take over afterwards.
    if (fresh) {
        let baselineDone = false;
        changeStream.on('resumeTokenChanged', (token) => {
            if (!baselineDone) { baselineDone = true; saveResumeToken(token); }
        });
    }

    changeStream.on('change', enqueue);

    changeStream.on('error', async (err) => {
        console.error('❌ Change stream error:', err.message);
        // A stale/invalid resume token (e.g. rotated oplog) can't be resumed — reset and
        // recommend a backfill so nothing is permanently missed.
        if (err.code === 286 || /resume/i.test(err.message)) {
            console.warn('⚠️  Resume token invalid — clearing it. Re-run `npm run typesense:backfill` to reconcile.');
            try { await redisClient.del(RESUME_KEY); } catch { /* ignore */ }
        }
        await triggerRestart();
    });

    console.log('👂 Typesense sync worker is live (watching users, businesses, posts).');
};

const shutdown = async () => {
    shuttingDown = true;
    console.log('\n🛑 Shutting down sync worker...');
    try { if (changeStream) await changeStream.close(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(0);
};

(async () => {
    if (!isTypesenseEnabled) {
        console.error('❌ Typesense is not configured. Set TYPESENSE_HOST and TYPESENSE_API_KEY in .env');
        process.exit(1);
    }
    try {
        await connectDB();
        await ensureCollections();
        await start();
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    } catch (err) {
        console.error('❌ Sync worker failed to start:', err);
        process.exit(1);
    }
})();
