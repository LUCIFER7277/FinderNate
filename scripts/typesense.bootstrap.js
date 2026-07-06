/**
 * Create (or recreate) the Typesense collections.
 *
 *   npm run typesense:bootstrap           # create missing collections (idempotent)
 *   npm run typesense:bootstrap -- --force # DROP and recreate (wipes the index)
 *
 * Only touches Typesense — no MongoDB connection needed. After bootstrapping,
 * run `npm run typesense:backfill` to load existing data.
 */
import { isTypesenseEnabled } from '../config/typesense.config.js';
import { ensureCollections, recreateCollections } from '../services/typesense/index.js';

const force = process.argv.includes('--force');

(async () => {
    if (!isTypesenseEnabled) {
        console.error('❌ Typesense is not configured. Set TYPESENSE_HOST and TYPESENSE_API_KEY in .env');
        process.exit(1);
    }
    try {
        if (force) {
            console.log('⚠️  --force: dropping and recreating all Typesense collections...');
            await recreateCollections();
        } else {
            await ensureCollections();
        }
        console.log('✅ Typesense collections are ready.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Bootstrap failed:', err.message);
        process.exit(1);
    }
})();
