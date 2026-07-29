import { randomUUID } from 'crypto';

/**
 * Gives every request an id, and logs the ones worth looking at.
 *
 * Production ran with no request logging and no error logging: morgan is
 * mounted only when NODE_ENV is development, or when ENABLE_MORGAN is
 * explicitly set, and the error handler responded without recording anything.
 * A 500 in production therefore left no trace at all — the user saw a message,
 * the logs were silent, and there was nothing to go back and read.
 *
 * The id is the thread between the two sides. It goes out on every response as
 * X-Request-Id, is included in the body of a failure, and appears on every log
 * line for that request — so a screenshot of an error can be matched to the
 * exact server-side stack that produced it.
 *
 * An id arriving from the client is honoured (after a format check, since it
 * is echoed into a header and into logs), which lets the app's own diagnostic
 * log line up with the server's for the same call.
 */

const ID_SHAPE = /^[A-Za-z0-9._-]{6,64}$/;

export const requestContext = (req, res, next) => {
    const inbound = req.get('X-Request-Id');
    req.id = inbound && ID_SHAPE.test(inbound)
        ? inbound
        : randomUUID().replace(/-/g, '').slice(0, 12);

    res.setHeader('X-Request-Id', req.id);
    req._startedAt = Date.now();
    next();
};

/**
 * Logged deliberately narrowly: every failed response, plus anything slow
 * enough to be worth noticing. Logging all traffic on a social feed buries the
 * signal and costs real money in log retention, and morgan already covers that
 * case for anyone who sets ENABLE_MORGAN.
 *
 * Health checks are excluded — uptime monitors hit them constantly.
 */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 3000);
const QUIET = new Set(['/', '/health', '/api/v1/health']);

export const requestLogger = (req, res, next) => {
    res.on('finish', () => {
        if (QUIET.has(req.path)) return;

        const ms = Date.now() - (req._startedAt || Date.now());
        const failed = res.statusCode >= 400;

        if (!failed && ms < SLOW_MS) return;

        // The user id, when there is one, is what turns "a 500 happened" into
        // "this account cannot sign up" — which is the question actually being
        // asked when someone reports a problem.
        const who = req.user?._id ? ` user=${req.user._id}` : '';
        const tag = failed ? 'req.fail' : 'req.slow';

        console.warn(
            `[${tag}] id=${req.id} ${req.method} ${req.originalUrl} ` +
            `→ ${res.statusCode} ${ms}ms${who}`
        );
    });

    next();
};
