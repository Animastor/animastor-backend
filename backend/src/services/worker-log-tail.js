// ======================================================
// Fresh worker logs — one-shot log-tail request flag (ORCHESTRATION_V2 §8.5)
// ======================================================
// The admin/owner asks for a worker's whole buffer with
//   POST /api/v1/workers/:workerId/request-log
// There is no table and no Redis key: the request is a single in-memory
// flag consumed by the very next /internal/gen/beacon response. The worker
// reacts to `send_log_tail:true` once and flushes its ring buffer; a lost
// beacon simply means the request is delivered on a later one.
//
// Single backend container → process-local state is sufficient. A restart
// drops pending requests (fail-safe: nothing is shipped that was not
// explicitly asked for).

'use strict';

const pending = new Map(); // worker_id → requested_at (epoch ms)

/** Mark a one-shot tail request. Idempotent while pending. */
function request(workerId) {
    if (!workerId) return false;
    pending.set(String(workerId), Date.now());
    return true;
}

/** Take (and clear) the pending request. TRUE exactly once. */
function consume(workerId) {
    if (!workerId) return false;
    const key = String(workerId);
    if (!pending.has(key)) return false;
    pending.delete(key);
    return true;
}

/** Is a request waiting? (tests / diagnostics; consume() is the real read) */
function isPending(workerId) {
    return !!workerId && pending.has(String(workerId));
}

/** Drop a pending request without delivering it (revoke/purge paths, tests). */
function clear(workerId) {
    if (workerId == null) return pending.size;
    const key = String(workerId);
    const had = pending.delete(key);
    return had ? 1 : 0;
}

function size() {
    return pending.size;
}

module.exports = { request, consume, isPending, clear, size };