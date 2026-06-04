import cron from 'node-cron';
import Post from '../models/userPost.models.js';
import { redisClient, RedisKeys } from '../config/redis.config.js';


export const syncShareCountsToDB = async () => {
    let synced = 0;
    let failed = 0;
    let cursor = '0';

    try {
        do {
            const [nextCursor, keys] = await redisClient.scan(
                cursor,
                'MATCH', 'fn:post:*:shares:count',
                'COUNT', 100
            );
            cursor = nextCursor;

            if (keys.length === 0) continue;

            const values = await redisClient.mget(...keys);

            const ops = [];
            for (let i = 0; i < keys.length; i++) {
                const count = parseInt(values[i], 10);
                if (isNaN(count) || count <= 0) continue;

                // fn:post:<postId>:shares:count  →  extract postId
                const postId = keys[i].split(':')[2];
                ops.push(
                    Post.findByIdAndUpdate(postId, {
                        $set: { 'engagement.shares': count },
                    }).catch((err) => {
                        console.error(` [ShareSync] Failed to update post ${postId}:`, err.message);
                        failed++;
                    })
                );
            }

            const results = await Promise.allSettled(ops);
            synced += results.filter((r) => r.status === 'fulfilled' && r.value).length;

        } while (cursor !== '0');

        return { synced, failed };
    } catch (err) {
        return { synced, failed, error: err.message };
    }
};

/**
 * Start share-sync cron jobs:
 *  - Every day at 12AM →  full authoritative flush at midnight
 */
export const startShareSyncJob = () => {

    // Every day at 12:00 AM (midnight)
    cron.schedule('0 0 * * *', async () => {
        console.log('[Cron] Share sync (midnight) triggered');
        await syncShareCountsToDB();
    }, {
        scheduled: true,
        timezone: 'Asia/Kolkata',
    });

    console.log('[Cron] Share sync job scheduled (daily midnight IST)');
};
