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
 * Lock of the NON-LUA fallback of `ensureIntentAndReceipt` (test doubles that
 * explicitly opt in via `__allowNonLuaFallback`). Production never takes this
 * path: a client that cannot run the atomic script fails closed.
 *
 * Stage 129 (audit 128 · B2): the lock carries an OWNER TOKEN and its TTL
 * covers the whole critical section (WATCH + reads + MULTI/EXEC ≈ 5–6
 * roundtrips), refreshed before the read phase; a lapsed lock is never
 * deleted by its previous owner (compare-and-delete on the token).
 */
const INTENT_RECEIPT_LOCK_TTL_S = 15;
/**
 * Length of the bounded supersede history inside an intent record. It is the
 * durable proof that a fence WAS superseded — needed when the incoming fence
 * is not older by epoch (equal epoch, different inputs) and after the
 * stage-epoch key expired.
 */
const INTENT_HISTORY_MAX = 8;

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

/**
 * Release the claim (terminal state of the task).
 *
 * Stage 129 (audit 128 · F4): the outcome is returned, so a caller can tell
 * «released» from «Redis refused» instead of reporting a rollback it never
 * performed. The claim key is derived from the idem_key, i.e. it is already
 * scoped to ONE fence — releasing it can never touch another generation.
 *
 * @returns {Promise<{released:boolean, reason:string}>}
 */
async function releaseTask(redis, idemKey) {
    if (!redis || !idemKey) return { released: false, reason: 'invalid' };
    try {
        const removed = await redis.del(idemClaimKey(idemKey));
        return removed > 0
            ? { released: true, reason: 'released' }
            : { released: false, reason: 'absent' };
    } catch (err) {
        return { released: false, reason: 'error', error: (err && err.message) || 'redis error' };
    }
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

/**
 * Forget the job_id → idem_key mapping (terminal state).
 *
 * Stage 129 (audit 128 · F4): a rollback must delete the ref ONLY when it
 * still points at the caller's own fence. A concurrent regeneration can
 * re-map job_id → a NEWER idem_key between the write and the rollback; a
 * blind DEL would erase the ownership index of the live generation (the
 * completion marker then becomes unreachable). The compare-and-delete is
 * transactional (WATCH/MULTI); a client without transactions deletes
 * nothing rather than deleting blindly.
 *
 * @param {{fence?:string}} [opts] expected owner fence (omit for a blind delete)
 * @returns {Promise<{deleted:boolean, reason:string}>}
 */
async function forgetTaskRef(redis, bookId, chapterId, sceneId, jobId, opts = {}) {
    if (!redis || !jobId || !bookId || !chapterId || !sceneId) {
        return { deleted: false, reason: 'invalid' };
    }
    const key = idemRefKey(bookId, chapterId, sceneId, jobId);
    const expected = opts && opts.fence != null ? String(opts.fence) : null;
    try {
        if (!expected) {
            const removed = await redis.del(key);
            return { deleted: removed > 0, reason: removed > 0 ? 'deleted' : 'absent' };
        }
        if (!_hasTransactions(redis)) {
            // A double without optimistic transactions: read-then-delete, still
            // scoped to OUR fence. Production ioredis always takes the
            // compare-and-delete below.
            const observed = await redis.get(key);
            if (observed == null) return { deleted: false, reason: 'absent' };
            if (String(observed) !== expected) return { deleted: false, reason: 'not_owner' };
            const removed = await redis.del(key);
            return { deleted: removed > 0, reason: removed > 0 ? 'deleted' : 'absent' };
        }
        await redis.watch(key);
        const current = await redis.get(key);
        if (current == null || String(current) !== expected) {
            await redis.unwatch();
            return { deleted: false, reason: current == null ? 'absent' : 'not_owner' };
        }
        const tx = redis.multi();
        tx.del(key);
        const res = await tx.exec();
        if (res == null) return { deleted: false, reason: 'contended' };
        return { deleted: true, reason: 'deleted' };
    } catch (err) {
        return { deleted: false, reason: 'error', error: (err && err.message) || 'redis error' };
    }
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

// ── Stage 127/129 — durable intent fence + immutable dispatch receipt ─────
//
// Phase 1 of the result-fencing rollout (contract 126 §1). BEFORE the hub
// POST, every send that won the single-pending claim records two things a
// later result callback can use to prove WHICH generation authorized it:
//
//   animastor:intent:{book}:{chapter}:{scene}:{job}
//       the CURRENT intent of the logical task:
//       { fence, state, epoch, supersedes, updated_at, history }  (14 d)
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
// STAGE 129 (audit 128 · B1/B2, F3–F8): the record is a VERSIONED admission
// token, not a "last writer wins" cell. A fence that is not the current one
// is admitted only when it is provably NEWER:
//
//   • a fence the record already superseded (bounded `history`, newest 8) or
//     one carrying an OLDER epoch is rejected with `stale_intent` and nothing
//     is written — a stale sender can never become current again, not even
//     after a restart (B1), and the history keeps that proof for a supersede
//     whose epoch key has expired (F3);
//   • a record without a fence is corrupt → `intent_corrupt` (F6), never
//     "the same intent" by default;
//   • a receipt whose intent record is gone means the durable record was lost
//     (eviction) while the receipt still authorizes a send → `intent_missing`,
//     never a silent re-creation of an old generation (F3/E4);
//   • a non-active record (cancelled/superseded) blocks later sends, but a
//     STRICTLY newer epoch may revive it — the verifiable admission
//     transition that keeps F8 from pinning a task for 14 days.
//
// Phase 1 deliberately does NOT change: the hub envelope, the result route,
// canonical artifact paths, completion semantics or PG schema — the receipt
// is written, read and verified here; consuming it is a later phase.

/** Bounded supersede history kept inside the intent record. */
function _intentHistory(intent) {
    const out = [];
    const raw = (intent && Array.isArray(intent.history)) ? intent.history : [];
    for (const entry of raw) {
        if (!Array.isArray(entry) || entry[0] == null) continue;
        const fence = String(entry[0]);
        if (!/^[0-9a-f]+$/i.test(fence)) continue;
        const epoch = Number(entry[1]);
        out.push([fence, Number.isFinite(epoch) ? epoch : 0]);
    }
    return out;
}

/** Serialize an intent record EXACTLY like ENSURE_INTENT_RECEIPT_SCRIPT. */
function _formatIntentRecord(record, now) {
    const history = (record.history || [])
        .map(([fence, epoch]) => `["${fence}",${Number.isFinite(epoch) ? epoch : 0}]`)
        .join(',');
    const supersedes = record.supersedes ? `"${record.supersedes}"` : 'null';
    return `{"fence":"${record.fence}","state":"${record.state}",` +
        `"epoch":${JSON.stringify(String(record.epoch))},"supersedes":${supersedes},` +
        `"updated_at":${Number(now) || 0},"history":[${history}]}`;
}

/** Non-active intent verdict (normalized state label). */
function _intentStateReject(state) {
    const label = String(state == null ? '' : state).replace(/[^\w-]/g, '').slice(0, 40);
    return { status: 'intent_not_active', state: label || 'unknown' };
}

/**
 * The ADMISSION DECISION of one ensure call — the single source of truth the
 * non-Lua fallback uses, mirrored step by step by the Lua script below.
 *
 * @returns {{reject:object}|{write:'create'|'supersede'|'refresh',
 *            verdict:'created'|'reused', record?:object}}
 */
function _decideIntentReceipt({ intentRaw, receiptRaw, fence, epoch, stageKnown = true }) {
    const receiptExists = receiptRaw != null && receiptRaw !== false;
    // A receipt is IMMUTABLE: the same (dispatch_id, job_id) can never be
    // re-bound to another fence while it lives.
    if (receiptExists && String(receiptRaw) !== fence) {
        return { reject: { status: 'receipt_conflict' } };
    }

    if (intentRaw == null || intentRaw === false) {
        // A live receipt proves an intent record was written to this slot
        // before (they are written in one operation) — its absence is data
        // loss, not a fresh start.
        if (receiptExists) return { reject: { status: 'intent_missing' } };
        return {
            write: 'create',
            verdict: 'created',
            record: {
                fence,
                state: INTENT_STATES.ACTIVE,
                epoch: String(epoch),
                supersedes: null,
                history: [],
            },
        };
    }

    let intent = null;
    try { intent = JSON.parse(intentRaw); } catch (_) { intent = null; }
    if (!intent || typeof intent !== 'object') return { reject: { status: 'intent_corrupt' } };

    // F6: a record without a fence can never be "the same intent".
    if (intent.fence == null) return { reject: { status: 'intent_corrupt' } };
    const storedFence = String(intent.fence);
    if (!/^[0-9a-f]+$/i.test(storedFence)) return { reject: { status: 'intent_corrupt' } };

    const state = intent.state == null ? INTENT_STATES.ACTIVE : String(intent.state);
    const storedEpochNum = intent.epoch == null ? NaN : Number(intent.epoch);
    const storedEpoch = Number.isFinite(storedEpochNum) ? storedEpochNum : null;
    const history = _intentHistory(intent);
    const verdict = receiptExists ? 'reused' : 'created';

    if (storedFence === fence) {
        if (state !== INTENT_STATES.ACTIVE) return { reject: _intentStateReject(state) };
        return { write: 'refresh', verdict };
    }

    // ── a DIFFERENT fence: a supersede attempt ─────────────────────────────
    // 1. a fence this record already superseded can never come back (B1/F3)
    const wasSuperseded = history.some(([f]) => f === fence)
        || String(intent.supersedes == null ? '' : intent.supersedes) === fence;
    if (wasSuperseded) return { reject: { status: 'stale_intent' } };
    // 2. an older generation can never override a newer one (B1). The epoch
    //    is only comparable while its COUNTER still exists: a lost counter
    //    (30 d TTL, eviction) restarts at 1 and would otherwise look like a
    //    regression and jam the task for the intent TTL. The history check
    //    above keeps protecting that case.
    if (stageKnown && storedEpoch !== null && epoch < storedEpoch) {
        return { reject: { status: 'stale_intent' } };
    }
    // 3. non-active record: only a STRICTLY newer generation may revive it (F8)
    if (state !== INTENT_STATES.ACTIVE) {
        if (stageKnown && (storedEpoch === null || epoch <= storedEpoch)) {
            return { reject: _intentStateReject(state) };
        }
    }

    const nextHistory = history
        .concat([[storedFence, storedEpoch === null ? 0 : storedEpoch]])
        .slice(-INTENT_HISTORY_MAX);
    return {
        write: 'supersede',
        verdict,
        record: {
            fence,
            state: INTENT_STATES.ACTIVE,
            epoch: String(epoch),
            supersedes: storedFence,
            history: nextHistory,
        },
    };
}

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

// ── observability (F7): the existing Prometheus registry, best effort ─────

let _fenceMetrics = null;

/** Count one fence verdict / degradation in the existing metrics registry. */
function _fenceMetric(outcome) {
    try {
        if (!_fenceMetrics) _fenceMetrics = require('../metrics/prometheus');
        if (_fenceMetrics && typeof _fenceMetrics.observeIntentFence === 'function') {
            _fenceMetrics.observeIntentFence(outcome);
        }
    } catch (_) { /* metrics are best effort — never a reason to fail a send */ }
}

function _fenceDegraded(reason) {
    try {
        if (!_fenceMetrics) _fenceMetrics = require('../metrics/prometheus');
        if (_fenceMetrics && typeof _fenceMetrics.observeIntentFenceDegraded === 'function') {
            _fenceMetrics.observeIntentFenceDegraded(reason);
        }
    } catch (_) { /* best effort */ }
}

/** Count one fenced RESULT-commit verdict (Stage 131, separate registry). */
function _commitMetric(outcome) {
    try {
        if (!_fenceMetrics) _fenceMetrics = require('../metrics/prometheus');
        if (_fenceMetrics && typeof _fenceMetrics.observeFenceCommit === 'function') {
            _fenceMetrics.observeFenceCommit(outcome);
        }
    } catch (_) { /* best effort */ }
}

/** Structured warning (no secrets: keys are ids, values are verdicts). */
function _fenceWarn(message) {
    try { console.warn(`[INTENT-FENCE] ${message}`); } catch (_) { /* ignore */ }
}

/**
 * ATOMIC «ensure intent + write receipt» (Stage 127, hardened in Stage 129).
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
 *   'stale_intent'       — this fence is NOT the current generation (it was
 *                          superseded, or carries an older epoch) → reject
 *                          without writing: a stale sender can never win
 *   'intent_not_active:<state>' — cancelled/superseded and no newer epoch
 *   'intent_corrupt'     — stored intent unparseable / has no valid fence
 *   'intent_missing'     — a receipt exists but its intent record is gone
 *   'invalid_fence'      — fence is not a sha256 hex id → fail closed
 *   'busy'               — non-Lua fallback could not settle a transaction
 *   'unavailable'        — the atomic path is not usable → FAIL CLOSED
 *   'invalid'            — missing arguments
 *
 * Nothing is written before a reject verdict, so a caller may always undo its
 * own enqueue side effects (claim/ref) after a non-ok verdict.
 *
 * Production path: one Lua script (atomic on a single Redis). Stage 129 makes
 * the non-Lua path EXPLICIT and test-only (`redis.__allowNonLuaFallback`):
 * it is transactional (WATCH/MULTI) and lock-guarded, but a production client
 * that cannot run the script gets `unavailable` — never a silent degradation
 * to a weaker read-check-write.
 */
const ENSURE_INTENT_RECEIPT_SCRIPT = `
local fence = ARGV[1]
if not string.match(fence, '^%x+$') then return 'invalid_fence' end
local epochStr = ARGV[2]
local epoch = tonumber(epochStr)
if not epoch then epochStr = '0'; epoch = 0 end
if epoch ~= math.floor(epoch) then epoch = math.floor(epoch); epochStr = string.format('%d', epoch) end
local now = tonumber(ARGV[3]) or 0
local intentTtl = tonumber(ARGV[4]) or 1209600
local receiptTtl = tonumber(ARGV[5]) or 172800
local historyMax = tonumber(ARGV[6]) or 8
local stageTtl = tonumber(ARGV[7]) or 2592000
-- KEYS[3] is the stage generation counter. It is only authoritative while it
-- still exists: an expired/evicted counter restarts at 1 and would look like
-- a regression. Its TTL is refreshed on every accepted send, so it outlives
-- the intent record it orders.
local stageKey = KEYS[3]
local stageKnown = true
if stageKey and stageKey ~= '' then
    stageKnown = redis.call('EXISTS', stageKey) == 1
end

local function touchStage()
    if stageKey and stageKey ~= '' and stageKnown then
        redis.call('EXPIRE', stageKey, stageTtl)
    end
end

local function label(value)
    local s = string.gsub(tostring(value), '[^%w_-]', '')
    if s == '' then return 'unknown' end
    if string.len(s) > 40 then return string.sub(s, 1, 40) end
    return s
end

local function historyJson(entries)
    local parts = {}
    for i, entry in ipairs(entries) do
        parts[i] = '["' .. entry[1] .. '",' .. string.format('%d', entry[2]) .. ']'
    end
    return table.concat(parts, ',')
end

-- 1. the receipt of this (dispatch_id, job_id) is immutable
local receiptFence = redis.call('GET', KEYS[2])
if receiptFence and receiptFence ~= fence then return 'receipt_conflict' end

local intentRaw = redis.call('GET', KEYS[1])

if not intentRaw then
    if receiptFence then return 'intent_missing' end
    local record = '{"fence":"' .. fence .. '","state":"active","epoch":"' .. epochStr ..
        '","supersedes":null,"updated_at":' .. string.format('%d', now) .. ',"history":[]}'
    redis.call('SET', KEYS[1], record, 'EX', intentTtl)
    touchStage()
    if not receiptFence then redis.call('SET', KEYS[2], fence, 'NX', 'EX', receiptTtl) end
    return 'created'
end

local ok, intent = pcall(cjson.decode, intentRaw)
if not ok or type(intent) ~= 'table' then return 'intent_corrupt' end

-- F6: a record without a valid fence is corrupt, never "the same intent"
if intent.fence == nil or intent.fence == cjson.null then return 'intent_corrupt' end
local storedFence = tostring(intent.fence)
if not string.match(storedFence, '^%x+$') then return 'intent_corrupt' end

local state = 'active'
if intent.state ~= nil and intent.state ~= cjson.null then state = tostring(intent.state) end

local storedEpoch = nil
if intent.epoch ~= nil and intent.epoch ~= cjson.null then storedEpoch = tonumber(intent.epoch) end

local history = {}
local wasSuperseded = false
if type(intent.history) == 'table' then
    for _, entry in ipairs(intent.history) do
        if type(entry) == 'table' and entry[1] ~= nil then
            local hf = tostring(entry[1])
            if string.match(hf, '^%x+$') then
                history[#history + 1] = { hf, tonumber(entry[2]) or 0 }
                if hf == fence then wasSuperseded = true end
            end
        end
    end
end
if intent.supersedes ~= nil and intent.supersedes ~= cjson.null
    and tostring(intent.supersedes) == fence then wasSuperseded = true end

-- 2. same fence: the current intent is confirmed
if storedFence == fence then
    if state ~= 'active' then return 'intent_not_active:' .. label(state) end
    redis.call('EXPIRE', KEYS[1], intentTtl)
    touchStage()
    if not receiptFence then redis.call('SET', KEYS[2], fence, 'NX', 'EX', receiptTtl) end
    if receiptFence then return 'reused' end
    return 'created'
end

-- 3. a different fence: admit it only when it is provably newer (B1)
if wasSuperseded then return 'stale_intent' end
if stageKnown and storedEpoch and epoch < storedEpoch then return 'stale_intent' end
if state ~= 'active' and stageKnown and (storedEpoch == nil or epoch <= storedEpoch) then
    return 'intent_not_active:' .. label(state)
end

history[#history + 1] = { storedFence, storedEpoch or 0 }
while #history > historyMax do table.remove(history, 1) end

local record = '{"fence":"' .. fence .. '","state":"active","epoch":"' .. epochStr ..
    '","supersedes":"' .. storedFence .. '","updated_at":' .. string.format('%d', now) ..
    ',"history":[' .. historyJson(history) .. ']}'
redis.call('SET', KEYS[1], record, 'EX', intentTtl)
touchStage()
if not receiptFence then redis.call('SET', KEYS[2], fence, 'NX', 'EX', receiptTtl) end
if receiptFence then return 'reused' end
return 'created'
`;

const _ENSURE_VERDICTS = new Set([
    'created', 'reused', 'receipt_conflict', 'stale_intent',
    'intent_corrupt', 'intent_missing', 'invalid_fence', 'busy', 'unavailable',
]);

function _parseEnsureVerdict(raw) {
    const status = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    if (_ENSURE_VERDICTS.has(status)) return { status };
    const NOT_ACTIVE = 'intent_not_active:';
    if (status.startsWith(NOT_ACTIVE)) {
        return { status: 'intent_not_active', state: status.slice(NOT_ACTIVE.length) || 'unknown' };
    }
    return { status: 'unknown', detail: status.slice(0, 120) };
}

/**
 * Errors that mean «this client cannot run the script» (a capability gap)
 * as opposed to «Redis refused / could not answer». Anything that is NOT in
 * this list fails closed: an ACL refusal, a CROSSSLOT in a cluster, a
 * READONLY replica or a timeout must never silently downgrade the write.
 */
const _LUA_CAPABILITY_ERROR = /unknown command|is not a function|not implemented|unsupported command|unknown subcommand/i;

function _isLuaCapabilityError(err) {
    const message = String((err && (err.message || err.stack)) || err || '');
    return _LUA_CAPABILITY_ERROR.test(message);
}

/** 16-hex random owner token of a fallback lock. */
function _randomToken() {
    try {
        return require('crypto').randomBytes(8).toString('hex');
    } catch (_) {
        return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    }
}

function _intentLockKey(intentK) {
    return `${IDEM_INTENT_LOCK_PREFIX}${intentK.slice(IDEM_INTENT_PREFIX.length)}`;
}

/** Acquire the fallback lock with an OWNER TOKEN (never a bare '1'). */
async function _acquireIntentLock(redis, lockK, token) {
    // Bounded wait: a concurrent holder finishes in a few roundtrips.
    for (let i = 0; i < 25; i++) {
        const acquired = !!(await redis.set(lockK, token, 'NX', 'EX', INTENT_RECEIPT_LOCK_TTL_S));
        if (acquired) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return false;
}

/** Does this client support optimistic transactions (WATCH/MULTI)? */
function _hasTransactions(redis) {
    return typeof redis.watch === 'function'
        && typeof redis.multi === 'function'
        && typeof redis.unwatch === 'function';
}

/** Extend the lock only while WE still own it. */
async function _renewIntentLock(redis, lockK, token) {
    try {
        if (!_hasTransactions(redis)) {
            const current = await redis.get(lockK);
            if (current == null || String(current) !== token) return false;
            return (await redis.expire(lockK, INTENT_RECEIPT_LOCK_TTL_S)) > 0;
        }
        await redis.watch(lockK);
        const current = await redis.get(lockK);
        if (current == null || String(current) !== token) { await redis.unwatch(); return false; }
        const tx = redis.multi();
        tx.expire(lockK, INTENT_RECEIPT_LOCK_TTL_S);
        const res = await tx.exec();
        return Array.isArray(res);
    } catch (_) {
        return false;
    }
}

/**
 * Release the fallback lock — COMPARE-AND-DELETE on the owner token. A lock
 * that expired and was re-acquired by somebody else is NEVER deleted by the
 * previous owner (audit 128 · B2/E6). Without transaction support the
 * compare-and-delete degrades to read-then-delete, which is still token
 * scoped: a foreign token is never deleted.
 */
async function _releaseIntentLock(redis, lockK, token) {
    try {
        if (!_hasTransactions(redis)) {
            const current = await redis.get(lockK);
            if (current == null || String(current) !== token) return false;
            await redis.del(lockK);
            return true;
        }
        await redis.watch(lockK);
        const current = await redis.get(lockK);
        if (current == null || String(current) !== token) { await redis.unwatch(); return false; }
        const tx = redis.multi();
        tx.del(lockK);
        const res = await tx.exec();
        return Array.isArray(res);
    } catch (_) {
        return false;
    }
}

/**
 * TEST-DOUBLE fallback: lock-guarded, TRANSACTIONAL (WATCH/MULTI) ensure for
 * Redis doubles that advertise `__allowNonLuaFallback` but have no `eval`.
 *
 * It is never reachable in production (see `ensureIntentAndReceipt`): a real
 * client either runs the Lua script or gets `unavailable`. Writes go through
 * ONE MULTI/EXEC, so a failure can never leave an intent without its receipt
 * (or the reverse), and a lost WATCH aborts the transaction instead of
 * overwriting a newer state.
 */
async function _ensureIntentReceiptFallback(redis, { intentK, receiptK, stageK, fence, epoch, now }) {
    const transactional = _hasTransactions(redis);

    const lockK = _intentLockKey(intentK);
    const token = _randomToken();
    let acquired = false;
    try {
        acquired = await _acquireIntentLock(redis, lockK, token);
    } catch (err) {
        _fenceDegraded('lock_error');
        return { status: 'unavailable', reason: 'lock_error', degraded: true };
    }
    if (!acquired) return { status: 'busy', degraded: true };

    try {
        // The critical section is a handful of roundtrips; refresh the TTL
        // before the read phase so a slow Redis cannot let the lock lapse
        // half-way (and never delete somebody else's lock afterwards).
        await _renewIntentLock(redis, lockK, token);

        // The stage counter is authoritative only while it exists (see the
        // Lua script) — a lost counter must not look like an older
        // generation and jam the task for the whole intent TTL.
        let stageKnown = true;
        if (stageK) {
            try { stageKnown = (await redis.get(stageK)) != null; } catch (_) { stageKnown = false; }
        }

        if (!transactional) {
            // A double with neither Lua nor WATCH/MULTI: the legacy
            // lock-guarded read-check-write, explicitly marked as
            // NON-transactional. Unreachable in production — the fallback
            // itself is gated behind `__allowNonLuaFallback`.
            _fenceDegraded('lock_only_fallback');
            let decision;
            try {
                decision = _decideIntentReceipt({
                    intentRaw: await redis.get(intentK),
                    receiptRaw: await redis.get(receiptK),
                    fence,
                    epoch,
                    stageKnown,
                });
            } catch (err) {
                return { status: 'unavailable', reason: 'redis_error', degraded: true, transactional: false };
            }
            if (decision.reject) {
                return { ...decision.reject, degraded: true, transactional: false };
            }
            try {
                if (decision.write === 'refresh') {
                    await redis.expire(intentK, IDEM_INTENT_TTL_S);
                } else {
                    await redis.set(intentK, _formatIntentRecord(decision.record, now), 'EX', IDEM_INTENT_TTL_S);
                }
                if (decision.verdict === 'created') {
                    await redis.set(receiptK, fence, 'NX', 'EX', IDEM_RECEIPT_TTL_S);
                }
                if (stageK && stageKnown) await redis.expire(stageK, STAGE_EPOCH_TTL_S);
            } catch (err) {
                return { status: 'unavailable', reason: 'redis_error', degraded: true, transactional: false };
            }
            return { status: decision.verdict, degraded: true, transactional: false };
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            await redis.watch(intentK, receiptK);
            let decision;
            try {
                decision = _decideIntentReceipt({
                    intentRaw: await redis.get(intentK),
                    receiptRaw: await redis.get(receiptK),
                    fence,
                    epoch,
                    stageKnown,
                });
            } catch (err) {
                try { await redis.unwatch(); } catch (_) { /* ignore */ }
                _fenceDegraded('redis_error');
                return { status: 'unavailable', reason: 'redis_error', degraded: true };
            }
            if (decision.reject) {
                await redis.unwatch();
                return { ...decision.reject, degraded: true };
            }

            let queued = 0;
            const tx = redis.multi();
            if (decision.write === 'refresh') {
                tx.expire(intentK, IDEM_INTENT_TTL_S); queued += 1;
            } else {
                tx.set(intentK, _formatIntentRecord(decision.record, now), 'EX', IDEM_INTENT_TTL_S); queued += 1;
            }
            if (decision.verdict === 'created') {
                tx.set(receiptK, fence, 'NX', 'EX', IDEM_RECEIPT_TTL_S); queued += 1;
            }
            if (stageK && stageKnown) { tx.expire(stageK, STAGE_EPOCH_TTL_S); queued += 1; }

            const replies = await tx.exec();
            // null = a watched key changed between WATCH and EXEC: re-read.
            if (replies == null) continue;
            // A client whose MULTI is a no-op must never look like success.
            if (!Array.isArray(replies) || replies.length !== queued) {
                _fenceDegraded('transaction_not_applied');
                _fenceWarn('MULTI/EXEC did not apply the ensure transaction — failing closed');
                return { status: 'unavailable', reason: 'transaction_not_applied', degraded: true };
            }
            return { status: decision.verdict, degraded: true, transactional: true };
        }
        return { status: 'busy', degraded: true };
    } catch (err) {
        _fenceDegraded('redis_error');
        return { status: 'unavailable', reason: 'redis_error', degraded: true };
    } finally {
        const released = await _releaseIntentLock(redis, lockK, token);
        if (!released) _fenceWarn('fallback lock was not released by its owner (expired or contended)');
    }
}

async function ensureIntentAndReceipt(redis, {
    bookId, chapterId, sceneId, jobId, dispatchId, fence, epoch, stageEpochKey: stageK = null,
} = {}) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId || !dispatchId || !fence) {
        return { status: 'invalid' };
    }
    const fenceStr = String(fence);
    if (!/^[0-9a-f]+$/i.test(fenceStr)) return { status: 'invalid_fence' };

    const intentK = intentKey(bookId, chapterId, sceneId, jobId);
    const receiptK = dispatchReceiptKey(dispatchId, jobId);
    const now = Date.now();
    const epochNum = Number(epoch);
    const epochStr = String(Number.isFinite(epochNum) ? Math.trunc(epochNum) : 0);
    const fallbackAllowed = redis.__allowNonLuaFallback === true;

    if (typeof redis.eval === 'function') {
        try {
            const raw = await redis.eval(
                ENSURE_INTENT_RECEIPT_SCRIPT,
                3,
                intentK,
                receiptK,
                stageK || '',
                fenceStr,
                epochStr,
                String(now),
                String(IDEM_INTENT_TTL_S),
                String(IDEM_RECEIPT_TTL_S),
                String(INTENT_HISTORY_MAX),
                String(STAGE_EPOCH_TTL_S)
            );
            if (raw != null && raw !== false) {
                const verdict = _parseEnsureVerdict(raw);
                if (verdict.status !== 'unknown') {
                    _fenceMetric(verdict.status);
                    return verdict;
                }
                // An answer nobody can classify is NOT a reason to re-run the
                // decision through a second, weaker path.
                _fenceDegraded('unexpected_eval_reply');
                _fenceWarn(`unexpected verdict from the atomic script: ${String(raw).slice(0, 80)} — failing closed`);
                return { status: 'unavailable', reason: 'unexpected_eval_reply' };
            }
            // null/undefined: the client did not execute the script at all.
        } catch (err) {
            const message = String((err && err.message) || err || '');
            if (!_isLuaCapabilityError(err)) {
                // ACL / CROSSSLOT / READONLY / LOADING / timeout / connection
                // reset — the write is NOT known to be atomic here.
                _fenceDegraded('eval_error');
                _fenceWarn(`atomic script failed (${message.slice(0, 120)}) — failing closed`);
                return { status: 'unavailable', reason: 'eval_error', detail: message.slice(0, 200) };
            }
            _fenceWarn(`atomic script unsupported by this client (${message.slice(0, 120)})`);
        }
    }

    if (!fallbackAllowed) {
        // Production: a Redis that cannot run the atomic script must fail
        // closed — a read-check-write can always admit a stale generation.
        _fenceDegraded('atomic_script_unavailable');
        _fenceMetric('unavailable');
        return { status: 'unavailable', reason: 'atomic_script_unavailable' };
    }

    const verdict = await _ensureIntentReceiptFallback(redis, {
        intentK, receiptK, stageK, fence: fenceStr, epoch: Number(epochStr), now,
    });
    _fenceMetric(verdict.status);
    return verdict;
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
    // Stage 129: the intent/receipt step could not run at all (Redis refused
    // the atomic path). Nothing was enqueued, but the send is retryable —
    // this is a bounded retry, never a reason to churn every 5 s.
    'intent_receipt_unavailable',
]);

/**
 * Fence verdicts that RETRYING CANNOT FIX (Stage 129, audit 128 · F5): the
 * dispatch belongs to a generation the backend already superseded, or the
 * receipt/intent pair is inconsistent. They are deferrable without being
 * retryable: the stage waits in the long window instead of cycling
 * dispatch → cancelled every 5 s, and the log/metric is the operator signal.
 */
const FENCE_REJECTED_REASONS = new Set([
    'stale_intent',
    'receipt_conflict',
    'intent_not_active',
    'intent_corrupt',
    'intent_missing',
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
 * suppression + the terminal fence rejections). Mirrors the package's
 * dispatch-outcomes taxonomy.
 */
const DEFERRABLE_REASONS = new Set([...CAPACITY_REASONS, ...FENCE_REJECTED_REASONS, 'already_completed']);

function isDeferrableReason(reason) {
    return DEFERRABLE_REASONS.has(String(reason || ''));
}

// ── Stage 131 — fenced result commit (staged artifacts) ────────────────────
//
// Publication gate for a GPU result (contract 126 §3, Stage 131). The result
// bytes are written to a STAGING directory first; the canonical artifact path
// is only replaced after this commit returns `committed` (or
// `duplicate_same_fence`). One atomic Lua script decides the verdict from the
// DURABLE state (the intent record + the completion marker), never from the
// existence of a file:
//
//   committed             — this fence is the current, active intent; the
//                           manifest, the completion marker and the claim
//                           transition happened atomically
//   duplicate_same_fence  — THIS fence was already committed (its own done
//                           marker exists) → idempotent repeat, nothing changed
//   stale_intent          — the fence is not the current intent (superseded,
//                           cancelled, or another generation is current)
//   intent_missing        — no intent record: the only durable evidence of
//                           "which fence is current" is gone → never publish
//   intent_corrupt        — the intent record is unparseable / has no valid
//                           fence → never publish
//   invalid_fence         — the fence is not a hex id → fail closed
//   unavailable           — the atomic script could not run at all → FAIL
//                           CLOSED (no weaker read-check-write path exists)
//
// Redis and the filesystem are NOT one transaction: the commit lands in Redis
// first, the staged→canonical rename follows. A crash between them leaves a
// COMMITTED publication whose rename can be replayed idempotently from the
// durable manifest (result-publication.resumePendingPublications) — never
// from "a file exists".
//
// DEVIATION from contract 126 §3.3 step 3 (deliberate, audit 130 · obs. 2):
// the job→fence ref is NOT a publication gate. `rememberTaskRef` is a blind
// SET executed before the intent fence, so a rejected stale sender can
// transiently overwrite the live ref with its own fence and then roll back
// (delete) it — a ref-mismatch check would REJECT the commit of the CURRENT
// fence during that window. The intent record is the sole authority; the ref
// is a best-effort index whose TTL is extended here only while it agrees.

const IDEM_MANIFEST_PREFIX = 'animastor:artifact-manifest:';
const IDEM_FENCE_JOURNAL_PREFIX = 'animastor:fence-journal:';

/** TTL of the idempotent (job, fence) commit journal entry. */
const FENCE_JOURNAL_TTL_S = IDEM_DONE_TTL_S;

/** Key of the durable "what is currently published" manifest of one task. */
function artifactManifestKey(bookId, chapterId, sceneId, jobId) {
    return `${IDEM_MANIFEST_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(jobId)}`;
}

/** Key of the idempotent commit journal entry of one (task, fence). */
function fenceJournalKey(bookId, chapterId, sceneId, jobId, fence) {
    return `${IDEM_FENCE_JOURNAL_PREFIX}${encodeKeyComponent(bookId)}:${encodeKeyComponent(chapterId)}:${encodeKeyComponent(sceneId)}:${encodeKeyComponent(jobId)}:${encodeKeyComponent(fence)}`;
}

const FENCE_COMMIT_SCRIPT = `
local fence = ARGV[1]
if not string.match(fence, '^%x+$') then return 'invalid_fence' end
-- 1. a fence that already committed is terminal: a repeat changes nothing
if redis.call('EXISTS', KEYS[2]) == 1 then return 'duplicate_same_fence' end
-- 2. the intent record is the AUTHORITY for "which fence is current"
local intentRaw = redis.call('GET', KEYS[1])
if not intentRaw then return 'intent_missing' end
local ok, intent = pcall(cjson.decode, intentRaw)
if not ok or type(intent) ~= 'table' then return 'intent_corrupt' end
if intent.fence == nil or intent.fence == cjson.null then return 'intent_corrupt' end
local storedFence = tostring(intent.fence)
if not string.match(storedFence, '^%x+$') then return 'intent_corrupt' end
if storedFence ~= fence then return 'stale_intent' end
local state = 'active'
if intent.state ~= nil and intent.state ~= cjson.null then state = tostring(intent.state) end
if state ~= 'active' then return 'stale_intent' end
-- 3. the job->fence ref is a BEST-EFFORT index, never a publication gate
--    (a concurrent stale sender can transiently overwrite it blind, then
--    roll back): extend its TTL only while it agrees with this commit.
local refFence = redis.call('GET', KEYS[6])
if refFence == fence then redis.call('EXPIRE', KEYS[6], tonumber(ARGV[6])) end
-- 4. publish: durable manifest first, then the terminal marker
redis.call('SET', KEYS[4], ARGV[2])
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[4]))
-- 5. release ONLY this fence's claim — never a derived or foreign one
redis.call('DEL', KEYS[3])
-- 6. idempotent commit journal (restart replay / operator audit)
redis.call('SET', KEYS[5], ARGV[2], 'EX', tonumber(ARGV[5]))
return 'committed'
`;

const FENCE_COMMIT_VERDICTS = new Set([
    'committed', 'duplicate_same_fence', 'stale_intent',
    'intent_missing', 'intent_corrupt', 'invalid_fence',
]);

/** Verdicts that are TERMINAL for this result (retrying cannot fix them). */
const FENCE_COMMIT_REJECTED = new Set([
    'stale_intent', 'intent_missing', 'intent_corrupt', 'invalid_fence',
]);

/** Verdicts after which the staged bytes may be published / already are. */
const FENCE_COMMIT_PUBLISHED = new Set(['committed', 'duplicate_same_fence']);

/**
 * ATOMIC fenced commit of one staged result (Stage 131).
 *
 * There is deliberately NO non-Lua fallback: a client that cannot run the
 * atomic script gets `unavailable` (fail closed) — a read-check-write commit
 * could publish a superseded fence.
 *
 * @returns {Promise<{status:string, reason?:string, detail?:string}>}
 */
async function fenceCommitResult(redis, {
    bookId, chapterId, sceneId, jobId, fence, manifest,
} = {}) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId || !fence || !manifest) {
        return { status: 'invalid' };
    }
    const fenceStr = String(fence);
    if (!/^[0-9a-f]+$/i.test(fenceStr)) return { status: 'invalid_fence' };

    const keys = [
        intentKey(bookId, chapterId, sceneId, jobId),
        idemDoneKey(fenceStr),
        idemClaimKey(fenceStr),
        artifactManifestKey(bookId, chapterId, sceneId, jobId),
        fenceJournalKey(bookId, chapterId, sceneId, jobId, fenceStr),
        idemRefKey(bookId, chapterId, sceneId, jobId),
    ];
    const manifestStr = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    const now = Date.now();

    if (typeof redis.eval !== 'function') {
        _fenceDegraded('commit_no_eval');
        _commitMetric('unavailable');
        return { status: 'unavailable', reason: 'atomic_script_unavailable' };
    }
    try {
        const raw = await redis.eval(
            FENCE_COMMIT_SCRIPT,
            6,
            ...keys,
            fenceStr,
            manifestStr,
            String(now),
            String(IDEM_DONE_TTL_S),
            String(FENCE_JOURNAL_TTL_S),
            String(IDEM_REF_DONE_TTL_S)
        );
        const status = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
        if (FENCE_COMMIT_VERDICTS.has(status)) {
            _commitMetric(status);
            return { status };
        }
        _fenceDegraded('commit_unexpected_eval_reply');
        _fenceWarn(`unexpected verdict from the commit script: ${status.slice(0, 80)} — failing closed`);
        return { status: 'unavailable', reason: 'unexpected_eval_reply' };
    } catch (err) {
        // ACL / CROSSSLOT / READONLY / LOADING / timeout — the commit is NOT
        // known to have happened; the caller keeps the staged bytes and
        // reports a retryable failure (never a success).
        const message = String((err && err.message) || err || '');
        _fenceDegraded('commit_eval_error');
        _fenceWarn(`fenced commit script failed (${message.slice(0, 120)}) — failing closed`);
        _commitMetric('unavailable');
        return { status: 'unavailable', reason: 'eval_error', detail: message.slice(0, 200) };
    }
}

/** Read the durable publication manifest of one task (null when absent). */
async function readArtifactManifest(redis, bookId, chapterId, sceneId, jobId) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId) return null;
    try {
        const raw = await redis.get(artifactManifestKey(bookId, chapterId, sceneId, jobId));
        if (raw == null || raw === false) return null;
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_) {
        return null;
    }
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
    // Stage 131 — fenced result commit (staged artifacts)
    IDEM_MANIFEST_PREFIX,
    IDEM_FENCE_JOURNAL_PREFIX,
    FENCE_JOURNAL_TTL_S,
    FENCE_COMMIT_SCRIPT,
    FENCE_COMMIT_VERDICTS,
    FENCE_COMMIT_REJECTED,
    FENCE_COMMIT_PUBLISHED,
    artifactManifestKey,
    fenceJournalKey,
    fenceCommitResult,
    readArtifactManifest,
    // result idempotency
    resultDedupKey,
};
