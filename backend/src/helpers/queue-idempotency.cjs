'use strict';
/**
 * Stage 114 — GPU queue idempotency primitives.
 *
 * WHY THIS EXISTS
 * ---------------
 * A scene stage can be dispatched many times for the SAME logical work item:
 * every graceful backend restart cancels the active dispatch
 * (`backend.cjs` SIGTERM handler → `cancelActiveDispatch(..., 'graceful_shutdown')`),
 * the next boot finds an orphaned GENERATING state and rolls it back
 * (`reconciliation-engine` → `orphan_generating_repair`), and the scheduler
 * dispatches the stage again with a FRESH `dispatch_id`.
 *
 * The GPU Hub dedup key is `animastor:job:{dispatch_id}:{job_id}`
 * (gpu-hub.js `jobDedupKey`) — it contains the very identifier that changes on
 * every re-dispatch, so it can never suppress a re-dispatch. The backend-side
 * `iu-in-flight` guard does not help either: the cancel deletes the dispatch
 * metadata, and the guard treats a marker whose owner is no longer the active
 * dispatch as stale (iu-processor `checkInFlightMarker`). Net effect: every
 * re-dispatch appends ANOTHER copy of the same jobs to the hub queue.
 *
 * WHAT THIS MODULE PROVIDES
 * -------------------------
 *  A stable identity for a logical GPU task and an atomic, single-claim
 *  guard that survives re-dispatch, restart and a new `dispatch_id`.
 *
 *      idem_key = sha256( workspace | job_id | job_type | build_id
 *                          | sha256(canonical(params)) | generation_epoch )
 *
 *  - `dispatch_id` is deliberately EXCLUDED: it changes on every re-dispatch
 *    and is therefore useless as an idempotency dimension.
 *  - `sha256(canonical(params))` ("input version") keeps different workflows,
 *    prompts, seeds and models apart.
 *  - `generation_epoch` is a per-stage counter owned by the backend. It is
 *    bumped ONLY for a justified retry (a consumed failure) or an explicit
 *    regeneration — never for an ordinary re-dispatch or a restart recovery.
 *
 *  The claim lives in Redis (`SET NX`) so two concurrent dispatches of the same
 *  logical task can never create two queue entries.
 *
 *  A queue entry is NOT treated as proof of a completed task: completion is
 *  recorded only when a real result was accepted (`markTaskDone`), and the
 *  actual artifact check stays the authority for "is this work already done".
 */

// ── constants ──────────────────────────────────────────────────────────────

const IDEM_CLAIM_PREFIX = 'animastor:idempotency:claim:';
const IDEM_DONE_PREFIX = 'animastor:idempotency:done:';
const IDEM_REF_PREFIX = 'animastor:idempotency:ref:';
const STAGE_EPOCH_PREFIX = 'animastor:idempotency:stage-epoch:';
const DISPATCH_EPOCH_PREFIX = 'animastor:idempotency:dispatch-epoch:';

/** Backstop TTL for a pending claim (the claim is released on terminal state). */
const IDEM_CLAIM_TTL_S = 24 * 3600;
/** TTL of the "task completed" marker (mirrors the artifact lifetime). */
const IDEM_DONE_TTL_S = 7 * 24 * 3600;
/** TTL of the ref that maps job_id → idem_key (result callback lookup). */
const IDEM_REF_TTL_S = 24 * 3600;
/** TTL of the per-stage generation epoch counter. */
const STAGE_EPOCH_TTL_S = 30 * 24 * 3600;
/** TTL of the per-dispatch frozen epoch (all jobs of one dispatch share it). */
const DISPATCH_EPOCH_TTL_S = 3600;

// ── canonical hashing ──────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted recursively, arrays keep their order.
 * Two structurally equal payloads always produce the same string.
 */
function canonicalJson(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256(input) {
    return require('crypto').createHash('sha256').update(input).digest('hex');
}

/** Version of the generation INPUTS (workflow params). */
function computeInputVersion(params) {
    return sha256(canonicalJson(params === undefined ? null : params));
}

/**
 * The idempotency key of one logical GPU task.
 *
 * @param {object} spec
 * @param {string|null} spec.workspaceId  server-resolved owner lane (null = system pool)
 * @param {string} spec.jobId              stable logical id (book_ch_scene_unit:kind)
 * @param {string} spec.jobType            audio | image | video
 * @param {string} spec.buildId            build directory (a rebuild changes it)
 * @param {*} spec.params                  workflow params (prompt/seed/model/inputs)
 * @param {number} spec.generationEpoch    bumped only for justified retries
 */
function computeIdemKey(spec) {
    const workspaceId = spec.workspaceId == null ? '' : String(spec.workspaceId);
    const jobId = spec.jobId == null ? '' : String(spec.jobId);
    const jobType = spec.jobType == null ? '' : String(spec.jobType);
    const buildId = spec.buildId == null ? '' : String(spec.buildId);
    const epoch = Number.isFinite(spec.generationEpoch) ? spec.generationEpoch : 0;
    const inputVersion = computeInputVersion(spec.params);
    return sha256([workspaceId, jobId, jobType, buildId, inputVersion, String(epoch)].join('|'));
}

// ── generation epoch (per stage) ───────────────────────────────────────────

function stageEpochKey(bookId, chapterId, sceneId, stage) {
    return `${STAGE_EPOCH_PREFIX}${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/** Current generation epoch of a stage (0 = first generation intent). */
async function getStageEpoch(redis, bookId, chapterId, sceneId, stage) {
    if (!redis || !bookId || !chapterId || !sceneId || !stage) return 0;
    try {
        const raw = await redis.get(stageEpochKey(bookId, chapterId, sceneId, stage));
        if (raw == null) return 0;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * Bump the generation epoch — ONLY for a justified new generation intent:
 *   • a failure was consumed (failStage → retry), or
 *   • the user/content explicitly asked for a regeneration of that stage.
 * NEVER called from an ordinary re-dispatch or a restart recovery.
 */
async function bumpStageEpoch(redis, bookId, chapterId, sceneId, stage) {
    if (!redis || !bookId || !chapterId || !sceneId || !stage) return 0;
    const key = stageEpochKey(bookId, chapterId, sceneId, stage);
    let next = 1;
    try {
        next = await redis.incr(key);
        await redis.expire(key, STAGE_EPOCH_TTL_S);
    } catch (_) {
        return 0;
    }
    return Number.isFinite(next) ? next : 1;
}

/**
 * Epoch frozen for one dispatch. All jobs of a dispatch must observe the SAME
 * epoch, otherwise a concurrent bump would split the dispatch across two
 * identities. The first sender of a dispatch publishes the epoch; the rest
 * read it back (SETNX + GET converges concurrent senders).
 */
async function resolveDispatchEpoch(redis, dispatchId, bookId, chapterId, sceneId, stage) {
    if (!redis || !dispatchId) return 0;
    const key = `${DISPATCH_EPOCH_PREFIX}${dispatchId}`;
    try {
        const existing = await redis.get(key);
        if (existing != null) {
            const n = parseInt(existing, 10);
            if (Number.isFinite(n)) return n;
        }
        const epoch = await getStageEpoch(redis, bookId, chapterId, sceneId, stage);
        await redis.set(key, String(epoch), 'NX', 'EX', DISPATCH_EPOCH_TTL_S);
        const settled = await redis.get(key);
        const n = parseInt(settled, 10);
        return Number.isFinite(n) ? n : epoch;
    } catch (_) {
        return 0;
    }
}

// ── hub-side claim (single pending entry per logical task) ─────────────────

function idemClaimKey(idemKey) {
    return `${IDEM_CLAIM_PREFIX}${idemKey}`;
}

function idemDoneKey(idemKey) {
    return `${IDEM_DONE_PREFIX}${idemKey}`;
}

function idemRefKey(jobId) {
    return `${IDEM_REF_PREFIX}${jobId}`;
}

/**
 * Atomically claim "this logical task may have at most ONE pending entry".
 * @returns {Promise<boolean>} true = this caller owns the enqueue.
 */
async function claimTask(redis, idemKey, ttlSeconds = IDEM_CLAIM_TTL_S) {
    if (!redis || !idemKey) return false;
    try {
        const ok = await redis.set(idemClaimKey(idemKey), '1', 'NX', 'EX', ttlSeconds);
        return !!ok;
    } catch (_) {
        return false;
    }
}

/** Release the claim (terminal state of the task). */
async function releaseTask(redis, idemKey) {
    if (!redis || !idemKey) return;
    try { await redis.del(idemClaimKey(idemKey)); } catch (_) { /* best effort */ }
}

/** Remember which idem_key belongs to a job_id (result callback lookup). */
async function rememberTaskRef(redis, jobId, idemKey, ttlSeconds = IDEM_REF_TTL_S) {
    if (!redis || !jobId || !idemKey) return;
    try { await redis.set(idemRefKey(jobId), idemKey, 'EX', ttlSeconds); } catch (_) { /* best effort */ }
}

/** Read back the idem_key of a job_id (null when unknown/expired). */
async function readTaskRef(redis, jobId) {
    if (!redis || !jobId) return null;
    try { return await redis.get(idemRefKey(jobId)); } catch (_) { return null; }
}

/** Forget the job_id → idem_key mapping (terminal state). */
async function forgetTaskRef(redis, jobId) {
    if (!redis || !jobId) return;
    try { await redis.del(idemRefKey(jobId)); } catch (_) { /* best effort */ }
}

/**
 * Mark the logical task as COMPLETED. Called ONLY after a real result was
 * accepted — a queue entry is never proof of completion.
 */
async function markTaskDone(redis, idemKey, ttlSeconds = IDEM_DONE_TTL_S) {
    if (!redis || !idemKey) return false;
    try {
        const ok = await redis.set(idemDoneKey(idemKey), '1', 'NX', 'EX', ttlSeconds);
        return !!ok;
    } catch (_) {
        return false;
    }
}

async function isTaskDone(redis, idemKey) {
    if (!redis || !idemKey) return false;
    try { return (await redis.get(idemDoneKey(idemKey))) != null; } catch (_) { return false; }
}

/**
 * The enqueue guard used by the GPU dispatcher.
 *
 * @returns {Promise<{allowed:boolean, reason:string}>}
 *   allowed=false, reason='already_completed' — the task already produced its
 *        artifact at this epoch; re-enqueueing it needs a justified retry.
 *   allowed=false, reason='duplicate_pending'  — an equivalent entry is
 *        already pending or running (this is the fix for the duplicate storm).
 */
async function guardEnqueue(redis, idemKey, ttlSeconds = IDEM_CLAIM_TTL_S) {
    if (await isTaskDone(redis, idemKey)) {
        return { allowed: false, reason: 'already_completed' };
    }
    const claimed = await claimTask(redis, idemKey, ttlSeconds);
    if (!claimed) {
        return { allowed: false, reason: 'duplicate_pending' };
    }
    return { allowed: true, reason: 'enqueued' };
}

// ── worker liveness (execution capacity) ───────────────────────────────────

/**
 * Alive workers of a given type, read from the hub-written heartbeat keys.
 * The hub writes `animastor:worker:heartbeat:{type}:{worker_id}` with EX 30 s,
 * so a present key is already a fresh signal; the payload is still validated.
 */
async function listAliveWorkers(redis, type) {
    const out = [];
    if (!redis || !type) return out;
    let config;
    try { config = require('../config/runtime-config'); } catch (_) { return out; }
    const pattern = config.WORKER_HEARTBEAT_TYPE_PATTERN(type);
    const maxAge = config.WORKER_HEARTBEAT_TTL * 1000;
    const now = Date.now();
    try {
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = next;
            for (const key of keys || []) {
                let data = null;
                try { data = JSON.parse(await redis.get(key)); } catch (_) { data = null; }
                if (!data || typeof data !== 'object' || typeof data.ts !== 'number') continue;
                if (now - data.ts >= maxAge) continue;
                out.push(data);
            }
        } while (cursor !== '0');
    } catch (_) {
        return out;
    }
    return out;
}

/**
 * Is there a LIVE worker that can actually pop the given lane?
 *
 *  - private lane  → a live private worker of the same workspace;
 *  - system pool   → a live system/share worker (or a policy-active private
 *                    one — SH-1 D3);
 *  - policy lane   → a live private worker of the policy owner (unknown owner
 *                    ⇒ permissive: the lane is only reachable via an explicit
 *                    grant, so we do not block it on a missing proof).
 */
async function hasLiveExecutorForLane(redis, type, lane) {
    const workers = await listAliveWorkers(redis, type);
    if (!workers.length) return false;
    if (lane && lane.kind === 'private') {
        return workers.some(w => w.mode === 'private' && w.workspace_id === lane.workspaceId);
    }
    if (lane && lane.kind === 'policy') {
        if (!lane.ownerWorkspaceId) return true; // permissive — explicit grant
        return workers.some(w => w.mode === 'private' && w.workspace_id === lane.ownerWorkspaceId);
    }
    // system pool
    return workers.some(w => w.mode === 'system' || w.mode === 'share');
}

// ── result idempotency (dispatch-independent) ─────────────────────────────

/**
 * The dedup key of a delivered RESULT.
 *
 * The production key was `animastor:result-processed:{dispatch_id}:{job_id}:{build_id}`
 * — dispatch-scoped, so a redelivered result that came with another
 * dispatch_id was NOT deduplicated (and the backend-side "dedup clear" in
 * iu-processor targeted a legacy key format nobody wrote). The result of one
 * logical job is one result, regardless of the dispatch that delivered it.
 */
function resultDedupKey(jobId, buildId) {
    return `animastor:result-processed:${jobId}:${buildId}`;
}

module.exports = {
    // constants
    IDEM_CLAIM_PREFIX,
    IDEM_DONE_PREFIX,
    IDEM_REF_PREFIX,
    STAGE_EPOCH_PREFIX,
    DISPATCH_EPOCH_PREFIX,
    IDEM_CLAIM_TTL_S,
    IDEM_DONE_TTL_S,
    IDEM_REF_TTL_S,
    STAGE_EPOCH_TTL_S,
    DISPATCH_EPOCH_TTL_S,
    // hashing / identity
    canonicalJson,
    sha256,
    computeInputVersion,
    computeIdemKey,
    // epoch
    stageEpochKey,
    getStageEpoch,
    bumpStageEpoch,
    resolveDispatchEpoch,
    // claims
    idemClaimKey,
    idemDoneKey,
    idemRefKey,
    claimTask,
    releaseTask,
    rememberTaskRef,
    readTaskRef,
    forgetTaskRef,
    markTaskDone,
    isTaskDone,
    guardEnqueue,
    // worker liveness
    listAliveWorkers,
    hasLiveExecutorForLane,
    // result idempotency
    resultDedupKey,
};
