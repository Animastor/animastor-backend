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
const IDEM_JOB_EPOCH_PREFIX = 'animastor:idempotency:job-epoch:';
const STAGE_EPOCH_PREFIX = 'animastor:idempotency:stage-epoch:';

// Stage 127 — durable intent fence + immutable dispatch receipt (phase 1 of
// the result-fencing rollout, contract 126 §1). The fence itself is the
// EXISTING `idem_key` — there is no second identity system.
const IDEM_INTENT_PREFIX = 'animastor:intent:';
const IDEM_RECEIPT_PREFIX = 'animastor:dispatch-intent:';
const IDEM_INTENT_LOCK_PREFIX = 'animastor:intent-lock:';

/** Backstop TTL for a pending claim (the claim is released on terminal state). */
const IDEM_CLAIM_TTL_S = 24 * 3600;
/**
 * TTL for a claim whose POST outcome was AMBIGUOUS (the hub may have taken
 * the task). The claim is kept — releasing it would re-open the duplicate
 * hole — but it must not block the task for the full 24 h if the request was
 * in fact lost.
 *
 * Stage 118 (audit 117 · M8): the bound is the LONGEST job timeout (video —
 * 60 min per the media registry), not the 30 min of image/audio: 90 min =
 * 1.5 × 60 min. The value still exceeds the longest timeout (the request
 * cannot still be in flight after it), the old rationale (3 × 30 min) was
 * simply wrong.
 */
const IDEM_AMBIGUOUS_CLAIM_TTL_S = 90 * 60;
/** TTL of the "task completed" marker (mirrors the artifact lifetime). */
const IDEM_DONE_TTL_S = 7 * 24 * 3600;
/** TTL of the ref that maps job_id → idem_key (result callback lookup). */
const IDEM_REF_TTL_S = 24 * 3600;
/**
 * TTL of the ref of a COMPLETED task. The ref is the ownership index that
 * makes the completion marker releasable (Stage 118 · B1), so it must live
 * as long as the marker it points at.
 */
const IDEM_REF_DONE_TTL_S = IDEM_DONE_TTL_S;
/** TTL of the per-stage generation epoch counter. */
const STAGE_EPOCH_TTL_S = 30 * 24 * 3600;
/**
 * TTL of the per-JOB pinned intent epoch (Stage 118 · M6). It anchors the
 * identity of a logical task across sends AND re-dispatches: the epoch moves
 * only when the TASK's own intent changes (an explicit regeneration or a
 * consumed failure), never because a sibling unit of the same stage was
 * regenerated.
 */
const IDEM_JOB_EPOCH_TTL_S = 24 * 3600;
/**
 * TTL of a CURRENT-INTENT record (Stage 127). It must outlive everything it
 * authorizes: the pending claim (24 h), the ambiguous-claim window (90 min)
 * and the completion marker (7 d) — an expired intent would erase the only
 * evidence distinguishing an old result from a current retry. 14 d gives the
 * artifact-retention window a full week of headroom; every send refreshes it.
 */
const IDEM_INTENT_TTL_S = 14 * 24 * 3600;
/**
 * TTL of an immutable dispatch receipt (Stage 127). The receipt maps
 * `(dispatch_id, job_id)` → fence for a result callback, so it must survive:
 * the hub's result retention (1 h), the ambiguous-claim window (90 min), the
 * reconciliation result-key TTL (1 h), the 24 h claim backstop AND a backend
 * outage longer than any of them — 48 h (contract 126 §5 window: strictly
 * greater than the longest claim TTL so no live dispatch can lose its
 * receipt before its claim).
 */
const IDEM_RECEIPT_TTL_S = 48 * 3600;
/**
 * Short-lived lock for the FALLBACK (non-Lua) path of
 * `ensureIntentAndReceipt` — Redis doubles without a working `eval`. Production
 * ioredis always takes the atomic Lua script; this lock only keeps the
 * read-check-write of doubles from interleaving.
 */
const INTENT_RECEIPT_LOCK_TTL_S = 5;

/** States of a current-intent record (contract 126 §1.2). */
const INTENT_STATES = Object.freeze({
    ACTIVE: 'active',
    SUPERSEDED: 'superseded',
    CANCELLED: 'cancelled',
});

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

/**
 * Encode one key component.
 *
 * Stage 118 (audit 117 · M1): the ':' separator made the ownership keys
 * AMBIGUOUS — the bundle book_id is client-controlled (import-routes.cjs) and
 * may contain ':'. `animastor:idempotency:ref:a:b:c:*` then matched BOTH the
 * book `a` (chapter `b`) and the book `a:b` (chapter `c`), so a book-scoped
 * release deleted another book's claims.
 *
 * encodeURIComponent escapes ':' as '%3A' (and the glob metacharacters
 * '*', '?', '[', ']'), while '_' stays readable.
 */
function encodeKeyComponent(value) {
    return encodeURIComponent(String(value == null ? '' : value));
}

function stageEpochKey(bookId, chapterId, sceneId, stage) {
    return `${STAGE_EPOCH_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(stage)}`;
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
 * The intent epoch of ONE logical task, resolved AT THE MOMENT OF THE SEND.
 *
 * Stage 118 (audit 117 · D1/M6). The Stage 114 patch froze the epoch per
 * dispatch, which hid a legitimate regeneration: the dirty-unit branch bumps
 * the stage epoch INSIDE the dispatch, so a unit that had already been sent
 * in the same dispatch kept the old epoch and was suppressed as
 * `already_completed` — the regeneration needed a second attempt. Stage 116
 * removed the freeze and read the stage epoch on every send, which fixed D1
 * but broke the other half of the contract: the identity of a logical task
 * must NOT change just because a SIBLING unit of the same stage was
 * regenerated (the "one logical task ⇒ one pending lane entry" invariant).
 *
 * The pinned per-job epoch is the reconciliation of both:
 *   • the epoch is resolved immediately before the send (D1);
 *   • the FIRST sender of a logical task pins the epoch for that task, so
 *     every later send/re-dispatch of the SAME task observes the SAME
 *     identity (M6) — even if the stage epoch moved in between;
 *   • the pin is dropped ONLY when the task's OWN intent changes (an
 *     explicit regeneration of that unit, or a consumed failure), which is
 *     exactly when a fresh identity is required.
 *
 * @returns {Promise<number>} the intent epoch of the task.
 */
async function resolveJobEpoch(redis, bookId, chapterId, sceneId, jobId, stage, ttlSeconds = IDEM_JOB_EPOCH_TTL_S) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId || !stage) return 0;
    const key = idemJobEpochKey(bookId, chapterId, sceneId, jobId);
    try {
        const pinned = await redis.get(key);
        if (pinned != null) {
            const n = parseInt(pinned, 10);
            if (Number.isFinite(n)) return n;
        }
        const epoch = await getStageEpoch(redis, bookId, chapterId, sceneId, stage);
        // SET NX — the first sender pins the intent epoch; a concurrent
        // sender reads the same value back (SETNX + GET converges).
        await redis.set(key, String(epoch), 'NX', 'EX', ttlSeconds);
        const settled = await redis.get(key);
        const s = parseInt(settled, 10);
        return Number.isFinite(s) ? s : epoch;
    } catch (_) {
        return 0;
    }
}

/**
 * Extend the TTL of the pinned intent epoch of a task (Stage 118 · B5/B6).
 * The pin must outlive the claim it belongs to — otherwise the identity of a
 * task that stays queued in the lane would drift when the pin expires.
 */
async function refreshJobEpochTtl(redis, bookId, chapterId, sceneId, jobId, ttlSeconds = IDEM_JOB_EPOCH_TTL_S) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId) return false;
    try {
        const ok = await redis.expire(idemJobEpochKey(bookId, chapterId, sceneId, jobId), ttlSeconds);
        return ok > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Drop the pinned intent epoch of a task — the task's OWN intent changed
 * (an explicit regeneration of that unit, or a consumed failure). The next
 * send resolves the CURRENT stage epoch and therefore gets a fresh identity.
 */
async function resetJobEpoch(redis, bookId, chapterId, sceneId, jobId) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId) return false;
    try {
        const removed = await redis.del(idemJobEpochKey(bookId, chapterId, sceneId, jobId));
        return removed > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Drop the pinned intent epoch of EVERY task that belongs to ONE stage of a
 * scene (Stage 120 · F1).
 *
 * WHY: `markDirtyScene` is the production signal «this stage must be
 * regenerated» (reconciliation stuck-state repair, RELEASE_STALE_LEASE, C1/C1b
 * audio+video recovery, scene restoration, placeholder audio, asset
 * invalidation). It bumps the STAGE epoch, but Stage 118's per-task pin
 * (M6) kept the OLD identity for every task of that stage ⇒ the re-dispatch
 * was suppressed as `already_completed` and the regeneration never ran. The
 * pin may only be dropped when the task's OWN intent changes — and a stage
 * regeneration IS an intent change for every task of that stage.
 *
 * Only the pins of the AFFECTED stage are dropped (a sibling stage's tasks
 * keep their pins — their identity must stay stable), and the drop is scoped
 * to this scene's job-epoch key shape, so another book/scene is never
 * touched.
 *
 * @returns {Promise<number>} how many pins were dropped.
 */
async function resetJobEpochForStage(redis, bookId, chapterId, sceneId, stage) {
    if (!redis || !bookId || !chapterId || !sceneId || !stage) return 0;
    const prefix = `${IDEM_JOB_EPOCH_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:`;
    let jobSchema;
    try { jobSchema = require('../runtime/job-schema'); } catch (_) { jobSchema = null; }
    let dropped = 0;
    let cursor = '0';
    try {
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
            cursor = next;
            for (const key of keys || []) {
                if (!key.startsWith(prefix)) continue;
                let jobId;
                try { jobId = decodeURIComponent(key.slice(prefix.length)); } catch (_) { continue; }
                // Resolve the stage of this pinned task from its job_id grammar.
                let keyStage = null;
                if (jobSchema) {
                    if (typeof jobSchema.getStageForJobId === 'function') {
                        keyStage = jobSchema.getStageForJobId(jobId);
                    } else if (typeof jobSchema.parseJobId === 'function' && jobSchema.STAGE_BY_KIND) {
                        const parsed = jobSchema.parseJobId(jobId);
                        keyStage = parsed ? (jobSchema.STAGE_BY_KIND[parsed.kind] || null) : null;
                    }
                }
                if (keyStage !== stage) continue;
                if (await redis.del(key) > 0) dropped++;
            }
        } while (cursor !== '0');
    } catch (_) {
        /* best effort — a missed reset only delays a regeneration by one epoch read */
    }
    return dropped;
}

/**
 * Read the CURRENT generation epoch of a stage at the moment of the actual
 * send (Stage 116 / D1).
 *
 * DEPRECATED as an identity source: the identity-bearing variant is
 * `resolveJobEpoch` (Stage 118 · M6) — the STAGE epoch alone is not stable
 * enough, because a sibling unit's regeneration moves it in the middle of a
 * dispatch. Kept for the callers that need the plain stage counter.
 *
 * @deprecated use resolveJobEpoch for an identity.
 */
async function resolveDispatchEpoch(redis, dispatchId, bookId, chapterId, sceneId, stage) {
    return getStageEpoch(redis, bookId, chapterId, sceneId, stage);
}

// ── hub-side claim (single pending entry per logical task) ─────────────────

function idemClaimKey(idemKey) {
    return `${IDEM_CLAIM_PREFIX}${idemKey}`;
}

function idemDoneKey(idemKey) {
    return `${IDEM_DONE_PREFIX}${idemKey}`;
}

/**
 * The ref key carries the OWNERSHIP structurally:
 *   animastor:idempotency:ref:{bookId}:{chapterId}:{sceneId}:{jobId}
 * A scene/book-scoped release is therefore a prefix scan over a key shape that
 * can only belong to that book/scene — no job-id grammar has to be re-derived.
 *
 * Stage 118 (audit 117 · M1): every component is percent-encoded, so a
 * book_id that contains ':' (client-controlled) cannot collide with another
 * book's key space.
 */
function idemRefKey(bookId, chapterId, sceneId, jobId) {
    return `${IDEM_REF_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(jobId)}`;
}

/**
 * The pinned intent epoch of one logical task (Stage 118 · M6). It lives
 * under the same ownership-encoded shape as the ref.
 */
function idemJobEpochKey(bookId, chapterId, sceneId, jobId) {
    return `${IDEM_JOB_EPOCH_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(jobId)}`;
}

/**
 * Atomically claim "this logical task may have at most ONE pending entry".
 *
 * Stage 120 (F2): the claim value carries its STATE — 'pending' (a normal
 * backstop claim) or 'ambiguous' (the POST outcome was ambiguous). The state
 * is what the TTL refresh consults so the two are never confused.
 * @returns {Promise<boolean>} true = this caller owns the enqueue.
 */
async function claimTask(redis, idemKey, ttlSeconds = IDEM_CLAIM_TTL_S) {
    if (!redis || !idemKey) return false;
    try {
        const ok = await redis.set(idemClaimKey(idemKey), 'pending', 'NX', 'EX', ttlSeconds);
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

/**
 * Remember which idem_key belongs to a job_id (result callback lookup).
 *
 * Stage 118 (B1): the ref is also the OWNERSHIP INDEX of the completion
 * marker — the scene/book-scoped release reaches the done marker only through
 * a ref. It is therefore NOT forgotten when the task settles; it is extended
 * to the lifetime of the completion marker (see `extendTaskRef`) so that an
 * authorized regeneration can release BOTH.
 */
async function rememberTaskRef(redis, bookId, chapterId, sceneId, jobId, idemKey, ttlSeconds = IDEM_REF_TTL_S) {
    if (!redis || !jobId || !idemKey || !bookId || !chapterId || !sceneId) return;
    try {
        await redis.set(idemRefKey(bookId, chapterId, sceneId, jobId), idemKey, 'EX', ttlSeconds);
    } catch (_) { /* best effort */ }
}

/**
 * Keep the ownership index of a SETTLED task alive for as long as its
 * completion marker (Stage 118 · B1).
 *
 * The Stage 116 implementation deleted the ref together with the claim, so
 * the done marker became unreachable: no scene/book-scoped release could ever
 * free it, and a legitimately completed task stayed suppressed as
 * `already_completed` for the whole 7-day marker TTL.
 */
async function extendTaskRef(redis, bookId, chapterId, sceneId, jobId, ttlSeconds = IDEM_REF_DONE_TTL_S) {
    if (!redis || !jobId || !bookId || !chapterId || !sceneId) return false;
    try {
        const key = idemRefKey(bookId, chapterId, sceneId, jobId);
        if (!await redis.get(key)) return false;
        await redis.expire(key, ttlSeconds);
        return true;
    } catch (_) {
        return false;
    }
}

/** Read back the idem_key of a job_id (null when unknown/expired). */
async function readTaskRef(redis, bookId, chapterId, sceneId, jobId) {
    if (!redis || !jobId || !bookId || !chapterId || !sceneId) return null;
    try { return await redis.get(idemRefKey(bookId, chapterId, sceneId, jobId)); } catch (_) { return null; }
}

/** Forget the job_id → idem_key mapping (terminal state). */
async function forgetTaskRef(redis, bookId, chapterId, sceneId, jobId) {
    if (!redis || !jobId || !bookId || !chapterId || !sceneId) return;
    try { await redis.del(idemRefKey(bookId, chapterId, sceneId, jobId)); } catch (_) { /* best effort */ }
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
 * Release a completion marker (Stage 120 · M-c).
 *
 * Called when a completion marker is found WITHOUT its artifact — an
 * ORPHANED marker (the build dir / PG rows were wiped by a path that did not
 * release the marker). Left in place it suppresses the task as
 * `already_completed` forever: the dispatch engine defers it 900 s, retries,
 * gets the same outcome, and the scene stays in the active index for good.
 * Freeing the marker lets the task regenerate instead of looping.
 */
async function releaseTaskDone(redis, idemKey) {
    if (!redis || !idemKey) return false;
    try { return (await redis.del(idemDoneKey(idemKey))) > 0; } catch (_) { return false; }
}

/**
 * Detect + free an ORPHANED completion marker on a SEND path (Stage 122 · N2).
 *
 * The M-c invariant (audit 119 · M-c): a send path reaches `provider.generate`
 * only after probing the artifact/chunk ABSENT (a present artifact
 * short-circuits to the cache-hit branch and never dispatches). Therefore an
 * `already_completed` verdict that comes back from the SEND path is, by that
 * invariant, an ORPHAN — the marker survived a wipe that did not release it.
 * Left in place it suppresses the task forever: the dispatch engine defers it
 * 900 s, retries, gets the same verdict, and the scene stays in the active
 * index for good.
 *
 * Shared by the image (`image/iu-processor`), audio (`audio/generation`) and
 * video (`orchestration/scene-orchestrator` via the persistence port) send
 * paths so orphan handling is IDENTICAL for every job type. Stage 121 · N2
 * found only the image path released the marker; audio/video still looped.
 *
 * @returns {Promise<boolean>}
 *   true  — the verdict was `already_completed` on a send and an orphaned
 *           marker was (best-effort) released; the caller should retry the
 *           send ONCE (the retry re-claims the same logical task, so a later
 *           dispatch still sees a normal bounded `duplicate_pending`).
 *   false — anything else (sent, duplicate_pending, no idem_key); the caller
 *           must NOT retry.
 */
async function releaseTaskDoneIfOrphan(redis, sendResult) {
    if (!redis || !sendResult || sendResult.sent) return false;
    if (sendResult.reason !== 'already_completed' || !sendResult.idem_key) return false;
    try { await releaseTaskDone(redis, sendResult.idem_key); } catch (_) { /* best effort */ }
    return true;
}

/**
 * Settle an ACCEPTED result (Stage 120 · M-f).
 *
 * The completion marker is only reachable THROUGH its ownership ref —
 * `releaseClaimsForScene/Book` scan the ref family and free the marker
 * derived from it. A marker written over a dead ref is therefore
 * unreachable for its whole 7-day TTL: the task stays suppressed as
 * `already_completed` with no authorized way out (audit 119 · M-f).
 *
 * Sequence (the marker is the LAST thing written):
 *   1. extend the existing ref (it must outlive the marker);
 *   2. if the ref is already gone (it expired between the dispatch and a
 *      result landing at/after the 24 h boundary), REPAIR it from job_id —
 *      the ref key is a pure function of book/chapter/scene/job;
 *   3. re-read and verify the ref now points at THIS identity;
 *   4. only then write the completion marker;
 *   5. release the pending claim (the task is terminal either way).
 *
 * When the ref cannot be made to point at this identity (a concurrent
 * dispatch re-mapped job_id → another idem_key), the marker is SKIPPED: a
 * blind marker would be unreachable, and the artifact check stays the
 * authority for "is this work done".
 *
 * @returns {Promise<{settled:boolean, markerWritten:boolean, refRepaired:boolean}>}
 */
async function settleCompletedTask(redis, { bookId, chapterId, sceneId, jobId, idemKey }) {
    const out = { settled: false, markerWritten: false, refRepaired: false };
    if (!redis || !idemKey || !bookId || !chapterId || !sceneId || !jobId) return out;
    try {
        if (!await extendTaskRef(redis, bookId, chapterId, sceneId, jobId)) {
            await rememberTaskRef(redis, bookId, chapterId, sceneId, jobId, idemKey, IDEM_REF_DONE_TTL_S);
            out.refRepaired = true;
        }
        const refLives = (await readTaskRef(redis, bookId, chapterId, sceneId, jobId)) === idemKey;
        out.markerWritten = refLives ? await markTaskDone(redis, idemKey) : false;
        await releaseTask(redis, idemKey);
        out.settled = true;
    } catch (_) {
        /* best effort — an unsettled marker only delays a re-run */
    }
    return out;
}

// ── Stage 127 — durable intent fence + immutable dispatch receipt ─────────
//
// Phase 1 of the result-fencing rollout (contract 126 §1). BEFORE the hub
// POST, every send that won the single-pending claim records two things a
// later result callback can use to prove WHICH generation authorized it:
//
//   animastor:intent:{book}:{chapter}:{scene}:{job}
//       the CURRENT intent of the logical task:
//       { fence, state, epoch, supersedes, updated_at }   (durable, 14 d)
//   animastor:dispatch-intent:{dispatch_id}:{job_id}
//       the immutable RECEIPT: this dispatch was authorized for exactly
//       `fence` (SET NX, never rewritten, 48 h)
//
// The fence IS the existing `idem_key` (computeIdemKey over the pinned job
// epoch) — no second identity system. A re-dispatch of the same intent
// recomputes the same fence and REUSES the intent record; a new intent (the
// task's own epoch was reset: consumed failure / explicit regeneration)
// computes a NEW fence and the record supersedes the old one in place.
//
// Phase 1 deliberately does NOT change: the hub envelope, the result route,
// canonical artifact paths, completion semantics or PG schema — the receipt
// is written, read and verified here; consuming it is a later phase.

/** Key of the current-intent record of one logical task. */
function intentKey(bookId, chapterId, sceneId, jobId) {
    return `${IDEM_INTENT_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(jobId)}`;
}

/**
 * Key of the immutable dispatch receipt. Both components are percent-encoded:
 * dispatch_id is transported in callbacks and job_id is client-influenced —
 * neither may break the key shape or collide across tasks.
 */
function dispatchReceiptKey(dispatchId, jobId) {
    return `${IDEM_RECEIPT_PREFIX}${encodeKeyComponent(dispatchId)}:${encodeKeyComponent(jobId)}`;
}

/** Read the current-intent record (null when absent/corrupt). */
async function readIntent(redis, bookId, chapterId, sceneId, jobId) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId) return null;
    try {
        const raw = await redis.get(intentKey(bookId, chapterId, sceneId, jobId));
        if (raw == null || raw === false) return null;
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_) {
        return null;
    }
}

/** Read back the fence a dispatch receipt binds (null when absent/expired). */
async function readDispatchReceipt(redis, dispatchId, jobId) {
    if (!redis || !dispatchId || !jobId) return null;
    try {
        const raw = await redis.get(dispatchReceiptKey(dispatchId, jobId));
        if (raw == null || raw === false) return null;
        return String(raw);
    } catch (_) {
        return null;
    }
}

/**
 * ATOMIC «ensure intent + write receipt» (Stage 127).
 *
 * One operation, because the receipt must be written only while the intent
 * state is checked — a callback holding a receipt of a non-active intent is
 * never acceptable later, and an intent rewrite must never race a receipt
 * write. Verdicts:
 *
 *   'created'            — intent ensured, receipt written for this dispatch
 *   'reused'             — intent already at this fence, receipt already existed
 *   'receipt_conflict'   — the receipt of THIS (dispatch_id, job_id) already
 *                          binds a DIFFERENT fence → immutable, reject
 *   'intent_not_active:<state>' — intent is cancelled/superseded → reject
 *   'intent_corrupt'     — stored intent unparseable → fail closed
 *   'invalid_fence'      — fence is not a sha256 hex id → fail closed
 *   'busy'               — fallback lock not acquired in the wait window
 *   'unavailable'        — Redis error on the fallback path
 *   'invalid'            — missing arguments
 *
 * Nothing is written before the first reject verdict, so a caller may always
 * undo its own enqueue side effects (claim/ref) after a non-ok verdict.
 *
 * Production path: one Lua script (atomic on a single Redis). Doubles without
 * a working `eval` take a lock-guarded read-check-write fallback with the same
 * verdicts — never a silent success.
 */
const ENSURE_INTENT_RECEIPT_SCRIPT = `
local fence = ARGV[1]
if not string.match(fence, '^%x+$') then return 'invalid_fence' end
local epoch = ARGV[2]
if not string.match(epoch, '^%-?%d+$') then epoch = '0' end
local now = ARGV[3]
if not string.match(now, '^%d+$') then now = '0' end
local intentTtl = tonumber(ARGV[4])
local receiptTtl = tonumber(ARGV[5])

local receiptFence = redis.call('GET', KEYS[2])
if receiptFence and receiptFence ~= fence then
    return 'receipt_conflict'
end

local intentRaw = redis.call('GET', KEYS[1])
local supersedes = nil
if intentRaw then
    local ok, intent = pcall(cjson.decode, intentRaw)
    if not ok or type(intent) ~= 'table' then return 'intent_corrupt' end
    local state = 'active'
    if intent.state then state = tostring(intent.state) end
    if state ~= 'active' then
        return 'intent_not_active:' .. string.gsub(state, '[^%w_-]', '')
    end
    if intent.fence and tostring(intent.fence) ~= fence then
        local prev = tostring(intent.fence)
        if not string.match(prev, '^%x+$') then return 'intent_corrupt' end
        supersedes = prev
    end
end

if not intentRaw then
    redis.call('SET', KEYS[1], '{"fence":"' .. fence .. '","state":"active","epoch":"' .. epoch .. '","supersedes":null,"updated_at":' .. now .. '}', 'EX', intentTtl)
elseif supersedes then
    redis.call('SET', KEYS[1], '{"fence":"' .. fence .. '","state":"active","epoch":"' .. epoch .. '","supersedes":"' .. supersedes .. '","updated_at":' .. now .. '}', 'EX', intentTtl)
else
    redis.call('EXPIRE', KEYS[1], intentTtl)
end

if receiptFence then return 'reused' end
redis.call('SET', KEYS[2], fence, 'NX', 'EX', receiptTtl)
return 'created'
`;

function _parseEnsureVerdict(raw) {
    const status = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    if (['created', 'reused', 'receipt_conflict', 'intent_corrupt', 'invalid_fence'].includes(status)) {
        return { status };
    }
    const NOT_ACTIVE = 'intent_not_active:';
    if (status.startsWith(NOT_ACTIVE)) {
        return { status: 'intent_not_active', state: status.slice(NOT_ACTIVE.length) || 'unknown' };
    }
    return { status: 'unknown', detail: status.slice(0, 120) };
}

/** Lock-guarded fallback for doubles without a working `eval`. */
async function _ensureIntentReceiptLocked(redis, { intentK, receiptK, fence, epoch, now }) {
    const lockK = `${IDEM_INTENT_LOCK_PREFIX}${intentK.slice(IDEM_INTENT_PREFIX.length)}`;
    let acquired = false;
    try {
        // Bounded wait: a concurrent holder finishes in milliseconds.
        for (let i = 0; i < 25 && !acquired; i++) {
            acquired = !!(await redis.set(lockK, '1', 'NX', 'EX', INTENT_RECEIPT_LOCK_TTL_S));
            if (!acquired) await new Promise((r) => setTimeout(r, 20));
        }
        if (!acquired) return { status: 'busy' };

        const receiptFence = await redis.get(receiptK);
        const receiptExists = receiptFence != null && receiptFence !== false;
        if (receiptExists && String(receiptFence) !== fence) {
            return { status: 'receipt_conflict' };
        }

        const intentRaw = await redis.get(intentK);
        let supersedes = null;
        if (intentRaw != null && intentRaw !== false) {
            let intent = null;
            try { intent = JSON.parse(intentRaw); } catch (_) { return { status: 'intent_corrupt' }; }
            if (!intent || typeof intent !== 'object') return { status: 'intent_corrupt' };
            const state = intent.state == null ? INTENT_STATES.ACTIVE : String(intent.state);
            if (state !== INTENT_STATES.ACTIVE) {
                return { status: 'intent_not_active', state: state.replace(/[^\w-]/g, '').slice(0, 40) || 'unknown' };
            }
            if (intent.fence != null && String(intent.fence) !== fence) {
                const prev = String(intent.fence);
                if (!/^[0-9a-f]+$/i.test(prev)) return { status: 'intent_corrupt' };
                supersedes = prev;
            }
        }

        if (intentRaw == null || intentRaw === false || supersedes !== null) {
            const record = JSON.stringify({
                fence: String(fence),
                state: INTENT_STATES.ACTIVE,
                epoch: String(epoch),
                supersedes,
                updated_at: now,
            });
            await redis.set(intentK, record, 'EX', IDEM_INTENT_TTL_S);
        } else {
            await redis.expire(intentK, IDEM_INTENT_TTL_S);
        }

        if (receiptExists) return { status: 'reused' };
        const written = await redis.set(receiptK, fence, 'NX', 'EX', IDEM_RECEIPT_TTL_S);
        if (!written) {
            // Someone outside the lock raced the SET NX — re-read, never overwrite.
            const stored = await redis.get(receiptK);
            return stored === fence ? { status: 'reused' } : { status: 'receipt_conflict' };
        }
        return { status: 'created' };
    } catch (err) {
        return { status: 'unavailable', detail: (err && err.message) || 'redis error' };
    } finally {
        if (acquired) { try { await redis.del(lockK); } catch (_) { /* best effort */ } }
    }
}

async function ensureIntentAndReceipt(redis, { bookId, chapterId, sceneId, jobId, dispatchId, fence, epoch } = {}) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId || !dispatchId || !fence) {
        return { status: 'invalid' };
    }
    if (!/^[0-9a-f]+$/i.test(String(fence))) return { status: 'invalid_fence' };

    const intentK = intentKey(bookId, chapterId, sceneId, jobId);
    const receiptK = dispatchReceiptKey(dispatchId, jobId);
    const now = Date.now();
    const epochNum = Number(epoch);
    const epochStr = String(Number.isFinite(epochNum) ? epochNum : 0);

    if (typeof redis.eval === 'function') {
        try {
            const raw = await redis.eval(
                ENSURE_INTENT_RECEIPT_SCRIPT,
                2,
                intentK,
                receiptK,
                String(fence),
                epochStr,
                String(now),
                String(IDEM_INTENT_TTL_S),
                String(IDEM_RECEIPT_TTL_S)
            );
            const verdict = _parseEnsureVerdict(raw);
            // An unrecognized return means the double does not really run the
            // script — converge through the locked fallback instead of
            // reporting a verdict nobody wrote.
            if (verdict.status !== 'unknown') return verdict;
        } catch (err) {
            // A Redis double whose eval does not understand the script (or a
            // transient script error) — converge through the locked fallback
            // below; verdicts are identical, never a silent success.
        }
    }
    return _ensureIntentReceiptLocked(redis, { intentK, receiptK, fence: String(fence), epoch: epochStr, now });
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

/**
 * Reasons that mean "the GPU capacity is not there right now" (or the
 * request outcome is ambiguous) — as opposed to "this particular job failed".
 * Only these turn a dispatch into a bounded deferral (Stage 116 / Stage 118 ·
 * D3/M4/M5); every other reason keeps the historic 'no_jobs_sent' semantics
 * (an immediate retry on the next tick).
 *
 * Stage 118 (M4): 'already_completed' is NOT a capacity reason — the logical
 * task is already complete, it is not waiting for capacity. It lives in its
 * own bucket (see the package's dispatch-outcomes taxonomy) with a much
 * longer backoff window.
 *
 * Stage 118 (M5): 'ambiguous_post' — the POST outcome was ambiguous (the
 * hub may have taken the task). The claim is kept and the stage waits.
 *
 * MUST stay in sync with the package's
 * `@animastor/orchestration` → runtime/dispatch-outcomes.
 */
const CAPACITY_REASONS = new Set([
    'no_worker_available',   // no live, type-compatible worker
    'duplicate_pending',     // the job is already pending in the lane
    'ambiguous_post',        // the POST outcome was ambiguous (hub may have taken it)
]);

/** Is a not-sent reason a capacity reason? */
function isCapacityReason(reason) {
    return CAPACITY_REASONS.has(String(reason || ''));
}

/**
 * Classify a map of "nothing was sent" reasons (Stage 118 · M3).
 *
 * The Stage 116 implementation required EXACTLY ONE distinct reason, so a
 * scene whose units failed for two different deferrable reasons was NOT
 * deferred and kept the 5-second churn. The rule now: every reason must be
 * deferrable; the most frequent one is reported.
 *
 * @param {Map<string, number>|Object<string, number>} reasons
 * @returns {string|null}
 */
function classifyNotSentReasons(reasons) {
    const entries = reasons instanceof Map
        ? [...reasons.entries()]
        : Object.entries(reasons || {});
    if (entries.length === 0) return null;
    if (!entries.every(([reason]) => isDeferrableReason(reason))) return null;
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

/**
 * The reasons that are deferrable at all (capacity + the idempotent
 * suppression). Mirrors the package's dispatch-outcomes taxonomy.
 */
const DEFERRABLE_REASONS = new Set([...CAPACITY_REASONS, 'already_completed']);

function isDeferrableReason(reason) {
    return DEFERRABLE_REASONS.has(String(reason || ''));
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

/**
 * Shorten the TTL of a claim whose POST outcome was ambiguous (the hub may
 * have taken the task). The claim is KEPT (releasing it would re-open the
 * duplicate hole) but it must not block the task for the full backstop TTL.
 *
 * Stage 120 (F2): the claim is marked 'ambiguous' AND shortened in ONE atomic
 * `SET … XX EX` step. The state is what a later `refreshClaimTtl` consults, so
 * the deliberate 90-minute window is never reset to the 24 h backstop.
 */
async function shortenClaimTtl(redis, idemKey, ttlSeconds = IDEM_AMBIGUOUS_CLAIM_TTL_S) {
    if (!redis || !idemKey) return false;
    try {
        await redis.set(idemClaimKey(idemKey), 'ambiguous', 'XX', 'EX', ttlSeconds);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * A claim whose POST outcome was ambiguous is deliberately SHORTENED to
 * IDEM_AMBIGUOUS_CLAIM_TTL_S. The refresh must NEVER extend it back to the
 * 24 h backstop (audit 119 · F2): the next scheduler tick would hit
 * `duplicate_pending` and a state-blind refresh reset the 90-minute window to
 * 24 h, blocking the task for a day instead of 90 minutes. The refresh is
 * therefore STATE-AWARE and ATOMIC — a Lua script reads the claim value and
 * extends only a 'pending' claim, never an 'ambiguous' one, and never
 * resurrects a released claim.
 */
const REFRESH_CLAIM_TTL_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == false then return 0 end
if v == 'ambiguous' then return -1 end
redis.call('SET', KEYS[1], v, 'XX', 'EX', tonumber(ARGV[1]))
return 1
`;

/**
 * Extend the TTL of an EXISTING pending claim (Stage 118 · B5).
 *
 * Stage 116 called `claimTask()` to "refresh" a suppressed duplicate — but
 * `claimTask` is `SET … NX`, and Redis REJECTS a SET NX on an existing key
 * WITHOUT touching its TTL. The refresh was therefore a no-op: the claim of a
 * task that stayed queued in the lane expired after 24 h and the task could
 * be enqueued a second time.
 *
 * `SET … XX EX` is the correct primitive: it updates the TTL of an existing
 * key and does NOT create (or resurrect) a missing one — a released claim is
 * never re-created by a refresh.
 *
 * Stage 120 (F2): the refresh is now STATE-AWARE. An 'ambiguous' claim keeps
 * its 90-minute window (the refresh is a no-op for it); a 'pending' claim is
 * pushed back to the full backstop TTL. Implemented as one atomic Lua script
 * (production) with a read-then-extend fallback for Redis doubles that lack
 * `eval`.
 *
 * @returns {Promise<boolean>} true when the claim existed, was pending and was extended.
 */
async function refreshClaimTtl(redis, idemKey, ttlSeconds = IDEM_CLAIM_TTL_S) {
    if (!redis || !idemKey) return false;
    const key = idemClaimKey(idemKey);
    try {
        if (typeof redis.eval === 'function') {
            const r = await redis.eval(REFRESH_CLAIM_TTL_SCRIPT, 1, key, String(ttlSeconds));
            return Number(r) === 1;
        }
    } catch (_) {
        /* fall through to the non-atomic path (a double without a real eval) */
    }
    try {
        const v = await redis.get(key);
        if (v == null || v === false) return false;   // released / missing — never resurrect
        if (v === 'ambiguous') return false;           // keep the 90-minute window (F2)
        await redis.set(key, v, 'XX', 'EX', ttlSeconds);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Release the claims (and completion markers) of the jobs that belong to a
 * SCENE — used when the hub lane is cleared (cancel / regenerate) so a
 * legitimate re-run is not suppressed as a duplicate (Stage 116 / Stage 118 ·
 * B1).
 *
 * Ownership: the ref key embeds the (percent-encoded) book/chapter/scene, so
 * a SCAN restricted to `animastor:idempotency:ref:{book}:{chapter}:{scene}:*`
 * can only match keys of THIS scene. Every matched ref is verified again
 * against the same prefix before it is touched, and only the claim/done keys
 * derived from that ref are removed — never a broad SCAN+DEL over the family.
 *
 * Stage 118 (B1): a COMPLETED task keeps its ref (extended to the lifetime
 * of the completion marker), so its done marker IS reachable here and can be
 * released together with the claim — the user explicitly asked for the work
 * to run again, so the previous "already completed" no longer applies.
 */
async function releaseClaimsForScene(redis, bookId, chapterId, sceneId) {
    if (!redis || !bookId || !chapterId || !sceneId) return { released: 0, done: 0, scanned: 0 };
    return releaseClaimsByPrefix(redis, sceneRefPrefix(bookId, chapterId, sceneId));
}

/**
 * Same as releaseClaimsForScene, but for a whole book (cancel / deletion).
 *
 * Ownership: `animastor:idempotency:ref:{bookId}:*` — the book_id is
 * percent-encoded, so a book_id that contains ':' cannot reach into another
 * book's key space (Stage 118 · M1).
 */
async function releaseClaimsForBook(redis, bookId) {
    if (!redis || !bookId) return { released: 0, done: 0, scanned: 0 };
    return releaseClaimsByPrefix(redis, `${IDEM_REF_PREFIX}${encodeKeyComponent(bookId)}:`);
}

/** The ownership prefix of a scene's refs. */
function sceneRefPrefix(bookId, chapterId, sceneId) {
    return `${IDEM_REF_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:`;
}

async function releaseClaimsByPrefix(redis, prefix) {
    const summary = { released: 0, done: 0, scanned: 0 };
    if (!redis || !prefix) return summary;
    let cursor = '0';
    try {
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
            cursor = next;
            for (const key of keys || []) {
                summary.scanned++;
                // Ownership check (structural): the key must belong to the
                // requested book/scene. A ref of another book/scene is never
                // touched — there is no broad SCAN+DEL over the family.
                if (!key.startsWith(prefix)) continue;
                const idemKey = await redis.get(key);
                if (!idemKey) continue;
                // Stage 118 (M12): count what was ACTUALLY removed — the
                // Stage 116 code always reported `done = released` even
                // though the completion marker was never touched.
                const claimRemoved = await redis.del(idemClaimKey(idemKey));
                const doneRemoved = await redis.del(idemDoneKey(idemKey));
                await redis.del(key);
                if (claimRemoved > 0) summary.released++;
                if (doneRemoved > 0) summary.done++;
            }
        } while (cursor !== '0');
    } catch (_) {
        /* best effort — a missed release only delays a re-run */
    }
    return summary;
}

module.exports = {
    // constants
    IDEM_CLAIM_PREFIX,
    IDEM_DONE_PREFIX,
    IDEM_REF_PREFIX,
    IDEM_JOB_EPOCH_PREFIX,
    STAGE_EPOCH_PREFIX,
    IDEM_CLAIM_TTL_S,
    IDEM_AMBIGUOUS_CLAIM_TTL_S,
    IDEM_DONE_TTL_S,
    IDEM_REF_TTL_S,
    IDEM_REF_DONE_TTL_S,
    IDEM_JOB_EPOCH_TTL_S,
    STAGE_EPOCH_TTL_S,
    // hashing / identity
    canonicalJson,
    sha256,
    computeInputVersion,
    computeIdemKey,
    // key encoding (Stage 118 · M1)
    encodeKeyComponent,
    // epoch
    stageEpochKey,
    getStageEpoch,
    bumpStageEpoch,
    resolveDispatchEpoch,
    // per-task intent epoch (Stage 118 · M6)
    idemJobEpochKey,
    resolveJobEpoch,
    resetJobEpoch,
    resetJobEpochForStage,
    refreshJobEpochTtl,
    // claims
    idemClaimKey,
    idemDoneKey,
    idemRefKey,
    sceneRefPrefix,
    claimTask,
    releaseTask,
    shortenClaimTtl,
    refreshClaimTtl,
    rememberTaskRef,
    extendTaskRef,
    readTaskRef,
    forgetTaskRef,
    markTaskDone,
    isTaskDone,
    releaseTaskDone,
    // Stage 122 (N2): shared orphan-marker detect+release for image/audio/video send paths
    releaseTaskDoneIfOrphan,
    // Stage 120 (M-f): settle an accepted result without orphaning the marker
    settleCompletedTask,
    guardEnqueue,
    // ownership-scoped release (cancel / regenerate / deletion)
    releaseClaimsForScene,
    releaseClaimsForBook,
    // capacity classification
    CAPACITY_REASONS,
    DEFERRABLE_REASONS,
    isCapacityReason,
    isDeferrableReason,
    classifyNotSentReasons,
    // worker liveness
    listAliveWorkers,
    hasLiveExecutorForLane,
    // Stage 127 — durable intent fence + immutable dispatch receipt
    IDEM_INTENT_PREFIX,
    IDEM_RECEIPT_PREFIX,
    IDEM_INTENT_LOCK_PREFIX,
    IDEM_INTENT_TTL_S,
    IDEM_RECEIPT_TTL_S,
    INTENT_STATES,
    intentKey,
    dispatchReceiptKey,
    readIntent,
    readDispatchReceipt,
    ensureIntentAndReceipt,
    // result idempotency
    resultDedupKey,
};
