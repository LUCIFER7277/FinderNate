import Typesense from 'typesense';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Typesense connection config.
 *
 * Env vars (add these to .env):
 *   TYPESENSE_HOST      e.g. search.yourdomain.com  (Coolify HTTPS domain) OR the
 *                       internal service name "typesense" if the backend runs in the
 *                       same Coolify/Docker network as the Typesense container.
 *   TYPESENSE_PORT      443 for public HTTPS, or 8108 for internal http. Default: 8108.
 *   TYPESENSE_PROTOCOL  "https" for public, "http" for internal. Default: http.
 *   TYPESENSE_API_KEY   the ADMIN api key you set in Coolify (server-side only).
 *
 * If TYPESENSE_HOST or TYPESENSE_API_KEY is missing, the whole integration is treated
 * as DISABLED and every search transparently falls back to the legacy Mongo search.
 */
const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;
const TYPESENSE_PORT = parseInt(process.env.TYPESENSE_PORT) || 8108;
const TYPESENSE_PROTOCOL = process.env.TYPESENSE_PROTOCOL || 'http';

export const isTypesenseEnabled = Boolean(TYPESENSE_HOST && TYPESENSE_API_KEY);

export const typesenseClient = isTypesenseEnabled
    ? new Typesense.Client({
        nodes: [{
            host: TYPESENSE_HOST,
            port: TYPESENSE_PORT,
            protocol: TYPESENSE_PROTOCOL,
        }],
        apiKey: TYPESENSE_API_KEY,
        // Search-path resilience: give up quickly and let the caller fall back to Mongo
        // instead of hanging the request if Typesense is unreachable.
        connectionTimeoutSeconds: 3,
        numRetries: 2,
        retryIntervalSeconds: 0.2,
        healthcheckIntervalSeconds: 15,
        logLevel: 'error',
    })
    : null;

if (!isTypesenseEnabled) {
    console.warn('⚠️  Typesense is DISABLED (TYPESENSE_HOST / TYPESENSE_API_KEY not set). Search will use the legacy MongoDB path.');
} else {
    console.log(`🔎 Typesense configured at ${TYPESENSE_PROTOCOL}://${TYPESENSE_HOST}:${TYPESENSE_PORT}`);
}

/**
 * Returns true if Typesense is reachable and healthy. Never throws.
 */
export const typesenseHealthCheck = async () => {
    if (!isTypesenseEnabled) return false;
    try {
        const res = await typesenseClient.health.retrieve();
        return res?.ok === true;
    } catch (error) {
        console.error('Typesense health check failed:', error.message);
        return false;
    }
};

export default typesenseClient;
