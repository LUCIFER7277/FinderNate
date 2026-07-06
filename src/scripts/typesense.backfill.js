/**
 * One-time (re-runnable) backfill of existing MongoDB data into Typesense.
 *
 *   npm run typesense:backfill
 *
 * Streams every User (joined with their Business) into the "users" collection and
 * every Post (with denormalized author) into the "posts" collection, in batches.
 * Related docs are looked up PER BATCH, so memory stays bounded regardless of the
 * user/post count. Uses upsert, so it is safe to run repeatedly.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../db/index.js';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import Post from '../models/userPost.models.js';
import { isTypesenseEnabled } from '../config/typesense.config.js';
import { ensureCollections, importDocs } from '../services/typesense/index.js';
import { USERS_COLLECTION, POSTS_COLLECTION, userToDoc, postToDoc } from '../services/typesense/schemas.js';

dotenv.config();

const BATCH = 500;

const flush = async (collection, docs, counters) => {
    if (docs.length === 0) return;
    const { success, failed } = await importDocs(collection, docs);
    counters.success += success;
    counters.failed += failed;
    console.log(`   ...${collection}: +${success} indexed (${failed} failed) [total ${counters.success}]`);
};

const backfillUsers = async () => {
    console.log('\n👥 Backfilling users (+ business join)...');
    const counters = { success: 0, failed: 0 };
    let batch = [];

    const processBatch = async () => {
        if (batch.length === 0) return;
        const userIds = batch.map((u) => u._id);
        const bizes = await Business.find({ userId: { $in: userIds } }, 'userId businessName category isVerified').lean();
        const bizByUser = new Map(bizes.map((b) => [String(b.userId), b]));
        const docs = batch.map((u) => userToDoc(u, bizByUser.get(String(u._id)) || null)).filter(Boolean);
        await flush(USERS_COLLECTION, docs, counters);
        batch = [];
    };

    const cursor = User.find({}, 'username fullName bio profileImageUrl isBusinessProfile isBlueTickVerified location followers accountStatus createdAt')
        .lean()
        .cursor();
    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        batch.push(user);
        if (batch.length >= BATCH) await processBatch();
    }
    await processBatch();
    console.log(`✅ Users done: ${counters.success} indexed, ${counters.failed} failed`);
};

const backfillPosts = async () => {
    console.log('\n📄 Backfilling posts (+ author denormalization)...');
    const counters = { success: 0, failed: 0 };
    let batch = [];

    const processBatch = async () => {
        if (batch.length === 0) return;
        const authorIds = [...new Set(batch.map((p) => String(p.userId?._id || p.userId)).filter(Boolean))];
        const authors = await User.find({ _id: { $in: authorIds } }, 'username profileImageUrl').lean();
        const authorById = new Map(authors.map((a) => [String(a._id), a]));
        const docs = batch
            .map((p) => postToDoc(p, authorById.get(String(p.userId?._id || p.userId)) || null))
            .filter(Boolean);
        await flush(POSTS_COLLECTION, docs, counters);
        batch = [];
    };

    const cursor = Post.find({}).lean().cursor();
    for (let post = await cursor.next(); post != null; post = await cursor.next()) {
        batch.push(post);
        if (batch.length >= BATCH) await processBatch();
    }
    await processBatch();
    console.log(`✅ Posts done: ${counters.success} indexed, ${counters.failed} failed`);
};

(async () => {
    if (!isTypesenseEnabled) {
        console.error('❌ Typesense is not configured. Set TYPESENSE_HOST and TYPESENSE_API_KEY in .env');
        process.exit(1);
    }
    try {
        await connectDB();
        await ensureCollections();
        const start = Date.now();
        await backfillUsers();
        await backfillPosts();
        console.log(`\n🎉 Backfill complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Backfill failed:', err);
        process.exit(1);
    }
})();
