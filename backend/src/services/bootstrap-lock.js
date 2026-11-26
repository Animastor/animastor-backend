// ======================================================
// Bootstrap lock — one bootstrap run per book (2026-11-26)
// ======================================================
// ba_1795695606197: two parallel POST /bootstrap → two runs → two chapter-0
// files. Every path into txtImporter.bootstrapImportedText /
// bootstrapNextWindow (and so lazyBook.createFromAnalysis / appendToBook)
// takes this lock first.
//
//   SET animastor:bootstrap-lock:<bookId> <token> NX EX 900
//   released in finally ONLY by its owner (Lua compare-and-del);
//   a heartbeat extends the TTL while the run is alive (compare-and-expire),
//   so a window longer than 900 s keeps the lock.
//
// Busy → BootstrapInProgressError (code 'bootstrap_in_progress'); the HTTP
// routes answer 409 { error: 'bootstrap_in_progress', session_id? }.
// Redis unavailable → the error propagates (fail-closed: no unlocked run).
// Docs: animastor-docs architecture/BOOTSTRAP_IDEMPOTENCY.md.

const crypto = require('crypto');

const LOCK_PREFIX = 'animastor:bootstrap-lock:';
const LOCK_TTL_SEC = 900;
const HEARTBEAT_MS = 300 * 1000;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0`;

const EXTEND_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;

class BootstrapInProgressError extends Error {
    constructor(bookId) {
        super(`bootstrap already in progress for book ${bookId}`);
        this.name = 'BootstrapInProgressError';
        this.code = 'bootstrap_in_progress';
        this.status = 409;
        this.bookId = bookId;
    }
}

function lockKey(bookId) {
    return `${LOCK_PREFIX}${bookId}`;
}

/**
 * Try to take the lock. Returns a handle { token, release() } or null when
 * another run holds it.
 */
async function acquire(redis, bookId, opts = {}) {
    if (!redis) throw new Error(`bootstrap lock: redis client required (book ${bookId})`);
    const ttlSec = opts.ttlSec || LOCK_TTL_SEC;
    const heartbeatMs = opts.heartbeatMs || HEARTBEAT_MS;
    const key = lockKey(bookId);
    const token = crypto.randomBytes(16).toString('hex');

    const ok = await redis.set(key, token, 'EX', ttlSec, 'NX');
    if (ok !== 'OK') return null;

    let lost = false;
    const timer = setInterval(() => {
        redis.eval(EXTEND_LUA, 1, key, token, String(ttlSec)).then((r) => {
            if (Number(r) !== 1 && !lost) {
                lost = true;
                console.warn(`[BOOTSTRAP-LOCK] ${bookId}: lock lost (expired or taken) during the run`);
            }
        }).catch((e) => console.warn(`[BOOTSTRAP-LOCK] ${bookId}: heartbeat failed: ${e.message}`));
    }, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();

    let released = false;
    return {
        token,
        key,
        isLost: () => lost,
        async release() {
            if (released) return;
            released = true;
            clearInterval(timer);
            try {
                await redis.eval(RELEASE_LUA, 1, key, token);
            } catch (e) {
                // TTL frees it anyway; never mask the run's own result
                console.warn(`[BOOTSTRAP-LOCK] ${bookId}: release failed: ${e.message}`);
            }
        },
    };
}

/**
 * Run fn() under the book's bootstrap lock; throws BootstrapInProgressError
 * when it is taken. The lock is released in finally by its owner only.
 */
async function withBootstrapLock(redis, bookId, fn, opts) {
    const handle = await acquire(redis, bookId, opts);
    if (!handle) throw new BootstrapInProgressError(bookId);
    try {
        return await fn(handle);
    } finally {
        await handle.release();
    }
}

function isBootstrapInProgress(err) {
    return !!err && err.code === 'bootstrap_in_progress';
}

module.exports = {
    LOCK_PREFIX,
    LOCK_TTL_SEC,
    HEARTBEAT_MS,
    BootstrapInProgressError,
    lockKey,
    acquire,
    withBootstrapLock,
    isBootstrapInProgress,
};
