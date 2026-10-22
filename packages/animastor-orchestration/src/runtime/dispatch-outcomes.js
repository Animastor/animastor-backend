// ======================================================
// DISPATCH OUTCOMES — the shared taxonomy of "nothing was enqueued"
//
// Stage 118 (audit 117 · D3/M4/M5): the classification of an executor
// outcome lives in ONE module so the dispatch engine (runtime tier) and the
// stage executors (orchestration tier) cannot drift apart.
//
// Buckets
// ───────
// • capacity   — the GPU capacity is not there right now:
//                'no_worker_available' | 'duplicate_pending' | 'ambiguous_post'
//                ⇒ a BOUNDED retry (deferral window) is the right response.
//
// • idempotent — the logical task is ALREADY COMPLETE (the completion marker
//                exists): 'already_completed'.
//                This is NOT a capacity problem and MUST NOT be classified as
//                one (audit 117 · M4): mixing it into the capacity bucket
//                turned "this task will never run" into an endless retry
//                loop. It gets its own, much longer backoff window and its
//                own reporting class.
//
// The host side (@animastor/generation → backend/src/helpers/queue-idempotency)
// mirrors these sets for the transport-level reasons it produces; the two
// lists must stay in sync (see queue-idempotency.cjs · CAPACITY_REASONS).
// ======================================================

const CAPACITY_OUTCOMES = new Set([
    'no_worker_available',   // no live, type-compatible worker
    'duplicate_pending',     // the job is already pending in the lane
    'ambiguous_post',        // the POST outcome was ambiguous (the hub may have taken the task)
]);

const IDEMPOTENT_OUTCOMES = new Set([
    'already_completed',     // the logical task is already complete (artifact missing)
]);

/** Is this outcome a CAPACITY gap (bounded retry with a short window)? */
function isCapacityOutcome(reason) {
    return CAPACITY_OUTCOMES.has(String(reason || ''));
}

/** Is this outcome an idempotent suppression (the task is already done)? */
function isIdempotentOutcome(reason) {
    return IDEMPOTENT_OUTCOMES.has(String(reason || ''));
}

/** Is this outcome deferrable at all (capacity OR idempotent)? */
function isDeferrableOutcome(reason) {
    return isCapacityOutcome(reason) || isIdempotentOutcome(reason);
}

/**
 * Classify the reasons why NOTHING was enqueued for a stage.
 *
 * Stage 118 (audit 117 · M3): the Stage 116 implementation required EXACTLY
 * ONE distinct reason (`notSentReasons.size === 1`). A scene whose units
 * failed for two DIFFERENT deferrable reasons (e.g. one unit gated by
 * "no live worker" and another suppressed as "duplicate pending") was
 * therefore NOT deferred and kept the 5-second dispatch/cancel churn.
 *
 * The rule now: EVERY reason must be deferrable; the most frequent one is
 * reported. A single non-deferrable reason (a real failure) keeps the
 * historic semantics (an immediate retry on the next tick) — the
 * audit-6929ba5 contract depends on it.
 *
 * @param {Map<string, number>|Object<string, number>} reasons
 * @returns {string|null} the dominant deferrable reason, or null.
 */
function classifyNotSentReasons(reasons) {
    const entries = reasons instanceof Map
        ? [...reasons.entries()]
        : Object.entries(reasons || {});
    if (entries.length === 0) return null;
    if (!entries.every(([reason]) => isDeferrableOutcome(reason))) return null;
    let dominant = null;
    let dominantCount = -1;
    for (const [reason, count] of entries) {
        const n = Number(count) || 0;
        if (n > dominantCount) {
            dominant = reason;
            dominantCount = n;
        }
    }
    return dominant;
}

module.exports = {
    CAPACITY_OUTCOMES,
    IDEMPOTENT_OUTCOMES,
    isCapacityOutcome,
    isIdempotentOutcome,
    isDeferrableOutcome,
    classifyNotSentReasons,
};
