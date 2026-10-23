const mediaRegistry = require('@animastor/generation').mediaRegistry;
const config = require('../config/runtime-config');
const jobSchema = require('./job-schema');
const { PROTOCOL_VERSION } = jobSchema;

const logPrefix = '[GPU]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const stats = { failed_jobs: 0 };

/** In-process counters (getStats) + the shared Prometheus registry. */
function getStats() { return { ...stats }; }
function observeFence(outcome) {
    try { require('../metrics/prometheus').observeIntentFence(outcome); } catch (_) { /* best effort */ }
}
function observeFenceDegraded(reason) {
    try { require('../metrics/prometheus').observeIntentFenceDegraded(reason); } catch (_) { /* best effort */ }
}

/**
 * Undo the enqueue side effects of THIS send — and only of this send.
 *
 * Stage 129 (audit 128 · F4): the claim key is derived from the idem_key, so
 * the release cannot touch another generation; the ref is deleted only while
 * it still points at OUR fence (compare-and-delete). Both outcomes are
 * checked: a rollback that did not happen is counted and logged, never
 * reported as a success.
 */
async function rollbackOwnEnqueue(redis, { idemKey, bookId, chapterId, sceneId, jobId }) {
    const claim = await qidem.releaseTask(redis, idemKey);
    const ref = await qidem.forgetTaskRef(redis, bookId, chapterId, sceneId, jobId, { fence: idemKey });

    const claimOk = claim && (claim.released === true || claim.reason === 'absent');
    const refOk = ref && (ref.deleted === true || ref.reason === 'absent' || ref.reason === 'not_owner');
    if (!claimOk || !refOk) {
        stats.jobs_fence_rollback_failed = (stats.jobs_fence_rollback_failed || 0) + 1;
        observeFence('rollback_failed');
        warn(`Rollback INCOMPLETE for ${jobId} fence=${String(idemKey).slice(0, 12)}: `
            + `claim=${claim && claim.reason} ref=${ref && ref.reason}`);
        return { failed: true, claim, ref };
    }
    return { failed: false, claim, ref };
}

// ======================================================
// PW-2: WORKSPACE RESOLUTION & ROUTING (server-derived)
// ======================================================
// The backend is the ONLY author of job.workspace_id: book → books.workspace_id
// (never client-supplied). A job is routed to the workspace queue ONLY when
// the workspace has an active private worker of the job type; otherwise it
// stays in the system pool (backward compatibility — workspaces without a
// private worker keep flowing to the operator's GPU).
//
// Resolution failures degrade to the system pool (availability): the hub's
// token-scoped pop remains the authoritative isolation control either way.

const WORKSPACE_CACHE_TTL_MS = 60_000;      // book → workspace
const ROUTING_CACHE_TTL_MS = 30_000;        // (workspace,type) → has private worker
const GRANT_CACHE_TTL_MS = 30_000;           // (workspace,type) → users-policy lane (V2)
const workspaceCache = new Map();
const routingCache = new Map();
const grantCache = new Map();

function cacheGet(cache, key, ttlMs) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > ttlMs) { cache.delete(key); return undefined; }
    return hit.value;
}

/**
 * Resolve the owning workspace for a book (server-side, cached).
 * @returns {Promise<string|null>} workspace_id or null (absent/unattached/error)
 */
async function resolveWorkspaceForBook(bookId) {
    if (!bookId) return null;
    const cached = cacheGet(workspaceCache, bookId, WORKSPACE_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let workspaceId = null;
    try {
        const bookRepo = require('../storage/postgres/repositories/book-repo');
        workspaceId = await bookRepo.getWorkspaceId(bookId);
    } catch (err) {
        warn(`workspace resolution failed for book=${bookId}: ${err.message} — using system pool`);
        workspaceId = null;
    }
    workspaceCache.set(bookId, { value: workspaceId, ts: Date.now() });
    return workspaceId;
}

/**
 * Does the workspace have an active private worker of this type? (cached).
 * @returns {Promise<boolean>}
 */
async function workspaceHasPrivateWorker(workspaceId, workerType) {
    if (!workspaceId) return false;
    const key = `${workspaceId}:${workerType}`;
    const cached = cacheGet(routingCache, key, ROUTING_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let has = false;
    try {
        const workerRepo = require('../storage/postgres/repositories/worker-repo');
        has = await workerRepo.hasActivePrivateWorkerOfType(workspaceId, workerType);
    } catch (err) {
        warn(`private-worker routing check failed for ws=${workspaceId} type=${workerType}: ${err.message} — using system pool`);
        has = false;
    }
    routingCache.set(key, { value: has, ts: Date.now() });
    return has;
}

/**
 * SH-2 (worker sharing V2): resolve the workspace's OWNER user, then find an
 * active users-scoped policy whose worker (private, of the job type, not
 * revoked) carries a personal grant for that user. Result: the policy lane
 * the job must be enqueued into (queue:{type}:policy:{id}), or null for the
 * system pool. Kill-switch OFF → always null (bit-for-bit V1-off behavior).
 * Resolutions degrade to the system pool on any error (availability).
 * @returns {Promise<object|null>} { policy_id, scope_kind, expires_at } | null
 */
async function workspaceGrantPolicyLane(workspaceId, workerType) {
    if (!workspaceId) return null;
    if (config.shareFeaturesEnabled() !== true) return null;
    const key = `grant:${workspaceId}:${workerType}`;
    const cached = cacheGet(grantCache, key, GRANT_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let lane = null;
    try {
        const workerRepo = require('../storage/postgres/repositories/worker-repo');
        const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
        const ws = await workspaceRepo.findById(workspaceId);
        if (ws && ws.owner_user_id) {
            lane = await workerRepo.findGrantPolicyForRouting(workspaceId, ws.owner_user_id, workerType);
        }
    } catch (err) {
        warn(`users-policy routing check failed for ws=${workspaceId} type=${workerType}: ${err.message} — using system pool`);
        lane = null;
    }
    grantCache.set(key, { value: lane, ts: Date.now() });
    return lane;
}

/** Test hook: drop resolution caches. */
function clearRoutingCaches() {
    workspaceCache.clear();
    routingCache.clear();
    grantCache.clear();
}

// S-2: per-type default job timeout moved to the media registry
// (generation/default-registrations.js, timeout.jobMs) — values preserved
// from the former DEFAULT_TYPE_TIMEOUT_MS (audio/image 30 min, video 60 min).

// ─────────────────────────────────────────────────────────────────────────
// Stage 114 — REDIS CLIENT + QUEUE IDEMPOTENCY + EXECUTOR GATE
// ─────────────────────────────────────────────────────────────────────────
// The dispatcher needs Redis for two things that must happen BEFORE a job
// reaches the GPU Hub queue:
//   1. the single-pending-entry claim (queue-idempotency) — a re-dispatch of
//      the same logical task must not append a second copy to the lane;
//   2. the executor-availability gate — a job must not be enqueued when no
//      live worker can pop it (otherwise the lane only grows).
//
// The client is registered by the composition root (backend.cjs) so the
// dispatcher does not open a second connection on its own.
let _redis = null;

/** Register the composition-root Redis client (idempotent). */
function setRedis(client) {
    _redis = client || null;
    return _redis;
}

/** The registered Redis client (null when the dispatcher runs standalone). */
function getRedis() {
    return _redis;
}

const qidem = require('../helpers/queue-idempotency.cjs');

// Stage 120 (M-e): HTTP 4xx that are DETERMINISTIC rejections — retrying them
// cannot change the answer, so the dispatcher stops after the first one
// instead of burning 3× response time + 2 s. The transient 4xx (400 in a
// race, 408, 409, 425, 429) are deliberately EXCLUDED: the B2 contract
// ("a definitive 4xx followed by an ambiguous attempt keeps the claim")
// depends on still probing after a 400.
const RETRYABLE_4XX = new Set([400, 408, 409, 425, 429]);
function isFinalRejectionStatus(status) {
    const s = Number(status);
    return s >= 400 && s < 500 && !RETRYABLE_4XX.has(s);
}

// T4: Структурированный результат отправки
// { sent: true, jobId } или { sent: false, error }
async function sendUnified(taskSpec) {
    if (!taskSpec.job_id || !taskSpec.params || !taskSpec.job_type) {
        throw new Error("Invalid task specification");
    }
    if (!mediaRegistry.hasMediaType(taskSpec.job_type)) {
        throw new Error("Invalid job type");
    }
    if (!taskSpec.dispatch_id || typeof taskSpec.dispatch_id !== 'string') {
        throw new Error("dispatch_id is required");
    }

    const parsed = jobSchema.parseJobId(taskSpec.job_id);
    if (!parsed) {
        throw new Error(`Invalid job_id: ${taskSpec.job_id}`);
    }

    // Per-type timeout: use taskSpec.timeout_ms if provided, else the
    // registry default for this media type, else config.GPU_TIMEOUT_MS.
    const timeoutMs = taskSpec.timeout_ms
        ?? mediaRegistry.resolveJobTimeout(taskSpec.job_type)
        ?? config.GPU_TIMEOUT_MS
        ?? 600_000;

    // PW-2 + SH-2: server-derived routing. workspace_id is ONLY ever set
    // here (book → workspace → active private worker of the type — the
    // owner's exclusive lane, always first). V2: when the workspace has NO
    // own private worker, a personal users-share grant routes the job to
    // the grant's policy lane instead of the public system pool; every
    // other case keeps flowing to the operator pool (backward compat).
    // Callers cannot inject either value: client-supplied fields are
    // always overwritten.
    let workspaceId = null;
    let policyLane = null;
    const bookWorkspace = await resolveWorkspaceForBook(parsed.bookId);
    if (bookWorkspace && await workspaceHasPrivateWorker(bookWorkspace, taskSpec.job_type)) {
        workspaceId = bookWorkspace;
    } else if (bookWorkspace) {
        const lane = await workspaceGrantPolicyLane(bookWorkspace, taskSpec.job_type);
        if (lane && lane.policy_id) policyLane = lane;
    }

    const payload = {
        ...taskSpec,
        // SH-2: policy_id is backend-authored ONLY — a client-supplied value
        // is stripped here and re-stamped below from the server-resolved lane.
        policy_id: undefined,
        timeout_ms: timeoutMs,
        build_id: taskSpec.build_id || "default",
        protocol_version: PROTOCOL_VERSION,
        book_id: parsed.bookId,
        chapter_id: parsed.chapterId,
        scene_id: parsed.sceneId,
        stage: jobSchema.STAGE_BY_KIND[parsed.kind],
        workspace_id: workspaceId,
        // SH-2: backend-authored policy-lane stamp — a task enqueued into
        // queue:{type}:policy:{id} carries the policy id so the hub can
        // poison-check the pop and orphan-requeue to the right lane. Never
        // present on ws-lane or system-pool tasks.
        ...(policyLane ? { policy_id: policyLane.policy_id } : {}),
    };

    // ─────────────────────────────────────────────────────────────────────
    // Stage 114 — executor gate + single-pending-entry claim
    // ─────────────────────────────────────────────────────────────────────
    const redis = getRedis();
    const stage = payload.stage;
    let idemKey = null;

    if (redis) {
        // (1) EXECUTOR GATE — a job must not be enqueued into a lane that
        //     no live worker can pop. The lane choice above stays
        //     registration-based (it is an isolation decision: a workspace
        //     with its own private worker keeps its jobs in its own lane),
        //     but the SENDING requires a live, type-compatible worker.
        const lane = workspaceId
            ? { kind: 'private', workspaceId }
            : (policyLane
                ? { kind: 'policy', policyId: policyLane.policy_id, ownerWorkspaceId: policyLane.owner_workspace_id || null }
                : { kind: 'system' });
        const executorAvailable = await qidem.hasLiveExecutorForLane(redis, taskSpec.job_type, lane);
        if (!executorAvailable) {
            stats.jobs_gated_no_worker = (stats.jobs_gated_no_worker || 0) + 1;
            log(`No live executor for ${taskSpec.job_type} in ${lane.kind} lane — job NOT enqueued (retryable): ${payload.job_id}`);
            return {
                sent: false,
                reason: 'no_worker_available',
                retryable: true,
                jobId: payload.job_id,
                dispatchId: taskSpec.dispatch_id,
            };
        }

        // (2) SINGLE PENDING ENTRY — the intent epoch of the task is resolved
        //     AT THE MOMENT OF THE SEND (Stage 116 / D1) and PINNED per task
        //     (Stage 118 / M6): the first sender of a logical task fixes the
        //     epoch for that task, so a later send or re-dispatch observes the
        //     SAME identity even when a sibling unit of the same stage moved
        //     the stage epoch. The pin is dropped only when the task's own
        //     intent changes (an explicit regeneration / a consumed failure).
        //     A re-dispatch with a NEW dispatch_id therefore computes the SAME
        //     idem_key and is suppressed instead of appending a duplicate.
        const epoch = await qidem.resolveJobEpoch(
            redis, parsed.bookId, parsed.chapterId, parsed.sceneId, payload.job_id, stage
        );
        idemKey = qidem.computeIdemKey({
            workspaceId: payload.workspace_id,
            jobId: payload.job_id,
            jobType: payload.job_type,
            buildId: payload.build_id,
            params: taskSpec.params,
            generationEpoch: epoch,
        });
        const guard = await qidem.guardEnqueue(redis, idemKey);
        if (!guard.allowed) {
            stats.jobs_suppressed_duplicate = (stats.jobs_suppressed_duplicate || 0) + 1;
            // Stage 118 (B5): an entry that is already pending must STAY
            // pending — the claim's TTL must actually be extended, otherwise it
            // expires while the task is still queued in the lane and a second
            // copy can be enqueued. `claimTask` (SET NX) does NOT touch the TTL
            // of an existing key — the refresh uses `SET XX EX`.
            if (guard.reason === 'duplicate_pending' && idemKey) {
                await qidem.refreshClaimTtl(redis, idemKey);
                // The pinned intent epoch must outlive the claim.
                await qidem.refreshJobEpochTtl(
                    redis, parsed.bookId, parsed.chapterId, parsed.sceneId, payload.job_id
                );
            }
            log(`Enqueue suppressed (${guard.reason}): ${payload.job_id} dispatch=${taskSpec.dispatch_id} idem=${idemKey.slice(0, 12)}`);
            return {
                sent: false,
                reason: guard.reason,
                suppressed: true,
                retryable: guard.reason === 'duplicate_pending',
                idem_key: idemKey,
                jobId: payload.job_id,
                dispatchId: taskSpec.dispatch_id,
            };
        }
        // Remember the identity so the result callback can find it (the ref
        // key carries the book/chapter/scene ownership structurally).
        await qidem.rememberTaskRef(redis, parsed.bookId, parsed.chapterId, parsed.sceneId, payload.job_id, idemKey);

        // ─────────────────────────────────────────────────────────────────
        // Stage 127 — durable intent fence + immutable dispatch receipt
        // (phase 1 of the result-fencing rollout, contract 126 §1)
        //
        // Written AFTER the single-pending claim was won and BEFORE the hub
        // POST: one atomic operation pins the CURRENT intent of this logical
        // task to this fence and records an immutable receipt
        // (dispatch_id, job_id) → fence. The fence is the idem_key computed
        // above — a re-dispatch of the same intent reuses it; a new intent
        // (reset task epoch) computes a new one and supersedes the old.
        //
        // A non-ok verdict means this dispatch may NOT reach the hub: nothing
        // was written by the fence step, so this sender reverts the enqueue
        // side effects it just made (its own claim + ref) and returns a
        // structured not-sent outcome instead of POSTing.
        const fenceVerdict = await qidem.ensureIntentAndReceipt(redis, {
            bookId: parsed.bookId,
            chapterId: parsed.chapterId,
            sceneId: parsed.sceneId,
            jobId: payload.job_id,
            dispatchId: taskSpec.dispatch_id,
            fence: idemKey,
            epoch,
            // The generation counter orders supersedes; passing its key lets
            // the fence step keep it alive for as long as the intent record
            // it orders (Stage 129 · F3).
            stageEpochKey: qidem.stageEpochKey(parsed.bookId, parsed.chapterId, parsed.sceneId, stage),
        });
        const fenceStatus = fenceVerdict && fenceVerdict.status;
        // A non-atomic (or degraded) fence step is an operator signal even
        // when the verdict itself is fine — it must never stay invisible
        // (Stage 129 · audit 128 B2/F7).
        if (fenceVerdict && fenceVerdict.degraded) {
            stats.jobs_intent_fencing_degraded = (stats.jobs_intent_fencing_degraded || 0) + 1;
            observeFenceDegraded(fenceVerdict.reason || 'non_lua_fallback');
        }
        if (fenceStatus !== 'created' && fenceStatus !== 'reused') {
            // Revert THIS sender's side effects only: the claim was acquired
            // by this call (SET NX) and the ref was written by it, so no
            // other sender's state is touched (fence-scoped, checked).
            const rollback = await rollbackOwnEnqueue(redis, {
                idemKey,
                bookId: parsed.bookId,
                chapterId: parsed.chapterId,
                sceneId: parsed.sceneId,
                jobId: payload.job_id,
            });
            // 'busy'/'unavailable'/'invalid'/'unknown' are transient (the
            // fence step is retried on the next tick); the terminal verdicts
            // (stale_intent, receipt_conflict, intent_*) can never become
            // valid by retrying.
            const fenceRetryable = fenceStatus === 'busy'
                || fenceStatus === 'unavailable'
                || fenceStatus === 'invalid'
                || fenceStatus === 'unknown'
                || !fenceStatus;
            if (fenceRetryable) {
                stats.jobs_intent_fencing_unavailable = (stats.jobs_intent_fencing_unavailable || 0) + 1;
                log(`Intent fence unavailable (${fenceStatus || 'no verdict'}): ${payload.job_id} dispatch=${taskSpec.dispatch_id} — NOT enqueued (retryable)`);
                return {
                    sent: false,
                    suppressed: true,
                    retryable: true,
                    reason: 'intent_receipt_unavailable',
                    rollbackFailed: rollback.failed,
                    idem_key: idemKey,
                    jobId: payload.job_id,
                    dispatchId: taskSpec.dispatch_id,
                };
            }
            stats.jobs_fence_rejected = (stats.jobs_fence_rejected || 0) + 1;
            const fenceDetail = fenceStatus === 'intent_not_active' && fenceVerdict.state
                ? `${fenceStatus}:${fenceVerdict.state}`
                : fenceStatus;
            log(`Intent fence REJECTED (${fenceDetail}): ${payload.job_id} dispatch=${taskSpec.dispatch_id} fence=${idemKey.slice(0, 12)} — NOT enqueued`);
            return {
                sent: false,
                suppressed: false,
                retryable: false,
                reason: fenceStatus,
                rollbackFailed: rollback.failed,
                idem_key: idemKey,
                jobId: payload.job_id,
                dispatchId: taskSpec.dispatch_id,
                error: `intent fence rejected: ${fenceDetail}`,
            };
        }
        log(`Intent fence ${fenceStatus}: ${payload.job_id} dispatch=${taskSpec.dispatch_id} fence=${idemKey.slice(0, 12)}`);
    }

    // T9: Include GPU_HUB_API_KEY header for authenticated requests
    const headers = { "Content-Type": "application/json" };
    if (config.GPU_HUB_API_KEY) {
        headers['x-api-key'] = config.GPU_HUB_API_KEY;
    }

    let lastError;
    let lastStatus = null;
    // Stage 118 (B2): every POST attempt is classified ON ITS OWN and the
    // whole request is reduced to ONE verdict:
    //   - HTTP 4xx: a DEFINITIVE rejection (the hub answered and did NOT
    //     enqueue). It decides the verdict ONLY when no attempt was
    //     ambiguous: an earlier timeout / reset / 5xx may already have been
    //     taken by the hub, so the claim MUST stay.
    //   - HTTP 5xx / timeout / connection reset / lost response: AMBIGUOUS
    //     (the hub may have taken the task) => the claim stays.
    //
    // Stage 116 kept ONE sticky flag: an early 4xx released the claim even
    // when a LATER attempt ended ambiguously => the duplicate hole D2 was
    // built to close re-opened (audit 117 - B2, reproduced on the real
    // module: "the claim was released although the last attempt was
    // ambiguous").
    let definitiveRejection = false;
    let ambiguousOutcome = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        let res;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            res = await fetch(`${config.HUB_URL}/task`, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
        } catch (err) {
            // The request may have reached the hub before it broke => ambiguous.
            lastError = err;
            ambiguousOutcome = true;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        if (res.ok) {
            log(`Task sent: ${payload.job_id} (${payload.job_type}), build: ${payload.build_id}, dispatch: ${payload.dispatch_id}, ws: ${workspaceId || (policyLane ? `policy:${policyLane.policy_id}` : '(system pool)')}`);
            // S-2: per-type counters keyed dynamically — no hardcoded media list
            const typeKey = `${payload.job_type}_jobs_started`;
            stats[typeKey] = (stats[typeKey] || 0) + 1;
            return { sent: true, jobId: payload.job_id, dispatchId: taskSpec.dispatch_id, idem_key: idemKey };
        }

        lastStatus = res.status;
        lastError = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500) {
            definitiveRejection = true;   // this attempt was definitive
            // Stage 120 (M-e): a DETERMINISTIC rejection (auth / forbidden /
            // not-found / unprocessable) will not change on a retry — stop
            // instead of burning 2 more attempts + 2 s of backoff. Transient
            // 4xx (400 bad-request race, 408, 409, 429) keep retrying so the
            // B2 "definitive 4xx then ambiguous" classification still holds.
            if (isFinalRejectionStatus(res.status)) break;
        } else {
            ambiguousOutcome = true;      // 5xx — the hub may have taken it
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }

    // The verdict of the WHOLE request: an ambiguous attempt always wins.
    const ambiguous = ambiguousOutcome || !definitiveRejection;
    stats.failed_jobs++;
    if (redis && idemKey) {
        if (!ambiguous) {
            // The hub answered with an HTTP error on EVERY attempt => nothing
            // was enqueued => the pending claim must be released, so a later
            // justified attempt is not blocked by a claim nobody holds.
            // Stage 129 (F4): the same fence-scoped, outcome-checked rollback
            // as the fence path — never a blind delete of somebody else's ref.
            await rollbackOwnEnqueue(redis, {
                idemKey,
                bookId: parsed.bookId,
                chapterId: parsed.chapterId,
                sceneId: parsed.sceneId,
                jobId: payload.job_id,
            });
        } else {
            // Ambiguous: the hub may have taken the task. Keep the claim (a
            // release would allow a duplicate) and shorten its TTL - the
            // hub's result/error callback settles it sooner if the task was
            // really taken.
            await qidem.shortenClaimTtl(redis, idemKey);
            stats.jobs_ambiguous_post = (stats.jobs_ambiguous_post || 0) + 1;
        }
    }
    return {
        sent: false,
        error: lastError ? lastError.message : 'max_retries',
        ambiguous,
        // Stage 118 (M5): the outcome now CARRIES a reason, so the
        // orchestration layer can classify it ('ambiguous_post' -> a bounded
        // deferral; a definitive rejection -> the historic immediate retry).
        reason: ambiguous ? 'ambiguous_post' : 'hub_rejected',
        status: lastStatus,
        jobId: payload.job_id,
    };
}

async function send(job_id, workflow, type, build_id, dispatch_id) {
    return sendUnified({ job_id, params: workflow, job_type: type, build_id, dispatch_id });
}

module.exports = { send, sendUnified, resolveWorkspaceForBook, workspaceHasPrivateWorker, workspaceGrantPolicyLane, clearRoutingCaches, setRedis, getRedis, getStats };
