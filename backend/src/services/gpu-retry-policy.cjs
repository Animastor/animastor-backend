// ======================================================
// GPU retry policy after a worker error (owner decision 2026-11-02)
// ======================================================
// The Stage 155 invariant «generation only by command» covers retries too.
// Basis: reports/2026-11-02/gpu-e2e-fixes.md §0 (task 6323: 6 dispatches in
// 85 s, each «No prompt_id» 0.1 s after task/next — FAIL-STAGE → PENDING,
// retry budget 10, stopped only by the circuit breaker).
// Docs: animastor-docs architecture/COMMAND_ONLY_GENERATION.md
//       §«Повтор после ошибки воркера».
//
//   class          retries  pauses        then
//   deterministic  0        —             failed
//   transient      2        30 s, 120 s   failed
//   oom            1        60 s          failed
//   unknown        0        —             failed (fail-closed)
//
// A retry happens only while the command is still alive at the moment the
// pause ends: the registry task that owned the failed attempt is still
// `active`, and the command gate authorizes the scene×stage (active task,
// layer enabled, no cancellation). A backend restart during a pause drops the
// pending retry (the task becomes `interrupted` by startup-resume; the
// pending-retry record is journaled as interrupted) — never a retry.
//
// Mechanics. Every failure signal of a dispatch (hub /gpu/task/error, the
// audio/video stall watchdog, reconcile replay of undelivered hub errors)
// reaches `orchestrator.failStage`; this module is that call's host-side
// policy: the stage is always failed WITHOUT the package's immediate
// re-dispatch (`redispatch:false` → asset FAILED, which the scheduler never
// dispatches). Then either
//   • a retry is scheduled: a Redis record + an in-process timer; when the
//     pause ends and the command is alive: FAILED → PENDING + active index
//     (through the gate) — the regular scheduler tick dispatches it; or
//   • the failure is terminal: the registry task(s) of that stage on the
//     scene → `failed` (error_class / error_message kept), PG
//     generation_tasks → failed, PG scene_assets pending → failed (PG legs
//     here, not on the ProgressEventsPort — the package never calls them).
//
// Attempts are counted per (registry task × scene × stage) — the unit the
// command dispatches — with the reason of every attempt in the scene journal.
// The orchestration package's retry budget / circuit breaker stay as an outer
// guard; the breaker's half-open probe only ever picks PENDING stages, and a
// deterministic failure never returns to PENDING.

'use strict';

const crypto = require('crypto');
const { classifyGpuError, ErrorClass } = require('./gpu-error-classifier.cjs');

const POLICY = Object.freeze({
    [ErrorClass.DETERMINISTIC]: Object.freeze({ retries: 0, pausesMs: Object.freeze([]) }),
    [ErrorClass.TRANSIENT]: Object.freeze({ retries: 2, pausesMs: Object.freeze([30 * 1000, 120 * 1000]) }),
    [ErrorClass.OOM]: Object.freeze({ retries: 1, pausesMs: Object.freeze([60 * 1000]) }),
    [ErrorClass.UNKNOWN]: Object.freeze({ retries: 0, pausesMs: Object.freeze([]) }),
});

const KEY_PREFIX = 'animastor:gpu-retry';
const ATTEMPTS_TTL_S = 24 * 60 * 60;
const PENDING_TTL_S = 60 * 60;

// One id per backend process: a pending-retry record written by another
// process (before a restart) is never executed by this one.
const BOOT_ID = crypto.randomBytes(6).toString('hex');

function attemptsKey(bookId, taskId, chapterId, sceneId, stage) {
    return `${KEY_PREFIX}:attempts:${bookId}:${taskId}:${chapterId}:${sceneId}:${stage}`;
}
function pendingKey(bookId, chapterId, sceneId, stage) {
    return `${KEY_PREFIX}:pending:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

// ── dependencies (lazy, overridable for tests) ─────────
let overrides = {};
function dep(name) {
    if (overrides[name]) return overrides[name];
    switch (name) {
        case 'orchestrator': return require('@animastor/orchestration');
        case 'commandGate': return require('@animastor/orchestration').runtime.commandGate;
        case 'scheduler': return require('@animastor/orchestration').runtime.scheduler;
        case 'state': return require('../state');
        case 'journal': return require('../state/event-journal');
        case 'bookFlag': return require('../orchestration-v2/book-flag');
        case 'generationProgress': return require('./generation-progress');
        case 'taskRepo': return require('../storage/postgres/repositories/task-repo');
        case 'sceneAssetsRepo': return require('../storage/postgres/repositories/scene-assets-repo');
        case 'setTimeout': return setTimeout;
        case 'now': return Date.now;
        case 'log': return (m) => console.log(`[GPU-RETRY] ${m}`);
        default: throw new Error(`gpu-retry-policy: unknown dep ${name}`);
    }
}
function setDepsForTest(o) { overrides = { ...(o || {}) }; }
function resetDepsForTest() { overrides = {}; timers.clear(); }

const timers = new Map(); // pendingKey → timeout handle (this process)

function journalType(name) {
    const j = dep('journal');
    return (j.EventType && j.EventType[name]) || name;
}

async function journalEvent(redis, bookId, chapterId, sceneId, name, stateValue, details) {
    try {
        await dep('journal').appendSceneEvent(redis, bookId, chapterId, sceneId, journalType(name), stateValue, details);
    } catch (_) { /* journal is diagnostics — never blocks the policy */ }
}

function targetsScene(task, chapterId, sceneId) {
    return (task.targets || []).some(t => t.chapter_id === chapterId && t.scene_id === sceneId);
}

/** Active registry tasks of `stage` that target the scene. */
async function activeCommandTasks(redis, bookId, chapterId, sceneId, stage) {
    try {
        const tasks = await dep('generationProgress').getActiveTasksByType(redis, bookId, stage);
        return (tasks || []).filter(t => targetsScene(t, chapterId, sceneId));
    } catch (_) {
        return []; // fail-closed: unreadable registry proves no command
    }
}

async function readAttempts(redis, key) {
    const raw = await redis.get(key);
    if (!raw) return { failures: 0, retries: 0, history: [] };
    try {
        const v = JSON.parse(raw);
        return { failures: v.failures || 0, retries: v.retries || 0, history: Array.isArray(v.history) ? v.history : [] };
    } catch (_) {
        return { failures: 0, retries: 0, history: [] };
    }
}

async function writeAttempts(redis, key, value) {
    await redis.set(key, JSON.stringify(value), 'EX', ATTEMPTS_TTL_S);
}

/**
 * Decide what happens after one failed attempt (pure).
 * @param {string} errorClass
 * @param {number} retriesDone  retries already performed for this unit
 * @returns {{ retry: boolean, pauseMs: number|null, maxRetries: number }}
 */
function decide(errorClass, retriesDone) {
    const p = POLICY[errorClass] || POLICY[ErrorClass.UNKNOWN];
    if (retriesDone < p.retries) {
        return { retry: true, pauseMs: p.pausesMs[retriesDone] ?? p.pausesMs[p.pausesMs.length - 1], maxRetries: p.retries };
    }
    return { retry: false, pauseMs: null, maxRetries: p.retries };
}

/**
 * Terminal failure of the command for this scene×stage: registry → failed,
 * PG generation_tasks → failed, PG scene_assets pending → failed.
 */
async function failCommand(redis, ctx, cls, attemptNo) {
    const { bookId, chapterId, sceneId, stage } = ctx;
    const info = {
        error_class: cls.error_class,
        error_code: cls.error_code,
        error_message: cls.error_message,
        attempts: attemptNo,
    };
    // Registry first: it alone revokes the authorization. PG legs are
    // best-effort (same shape as the no_worker `blocked` path).
    let result = { tasks: [] };
    try {
        result = await dep('generationProgress').failSceneStage(redis, bookId, chapterId, sceneId, stage, info);
    } catch (err) {
        dep('log')(`registry fail ${bookId}/${chapterId}/${sceneId}:${stage} failed: ${err.message}`);
    }
    const pgError = `gpu_failed:${cls.error_class}:${cls.error_message || ''}`.slice(0, 500);
    for (const task of result.tasks || []) {
        try {
            await dep('taskRepo').updateTaskStatus(task.task_id, 'failed', pgError);
        } catch (err) {
            dep('log')(`PG generation_tasks fail of ${task.task_id} failed: ${err.message}`);
        }
    }
    try {
        result.assetRows = await dep('sceneAssetsRepo').markPendingAssetsFailed(
            bookId, [stage], [{ chapter_id: chapterId, scene_id: sceneId }], pgError);
    } catch (err) {
        dep('log')(`PG scene_assets fail ${bookId}/${chapterId}/${sceneId}:${stage} failed: ${err.message}`);
    }
    await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_FAILURE_TERMINAL', 'failed', {
        stage, ...info, tasks: (result.tasks || []).map(t => t.task_id),
    });
    dep('log')(`TERMINAL ${bookId}/${chapterId}/${sceneId}:${stage} class=${cls.error_class} code=${cls.error_code} attempts=${attemptNo} — command failed, no retry`);
    return result;
}

/**
 * Policy entry point for one failed GPU attempt.
 *
 * @param {object} redis
 * @param {object} ctx  { bookId, chapterId, sceneId, stage, buildId, reason,
 *                        dispatchId, errorClass?, comfyStatus?, errorCode?, source? }
 * @returns {Promise<object>} failStage result + { policy: {...} }
 */
async function handleStageFailure(redis, ctx) {
    const { bookId, chapterId, sceneId, stage, buildId, dispatchId } = ctx;
    // Orchestration v2 (1b/E): retries of a v2 book belong to gen_jobs — legacy keeps out.
    if (await dep('bookFlag').isV2BookFailClosed(bookId)) return { handled: false, reason: 'orchestration_v2' };
    const reason = ctx.reason || 'worker_error';
    const cls = classifyGpuError({
        reason,
        error_class: ctx.errorClass,
        comfy_status: ctx.comfyStatus,
        error_code: ctx.errorCode,
    });

    // Resolve the command BEFORE failing the stage (failStage does not touch
    // the registry, but a concurrent tick may complete/cancel meanwhile).
    const tasks = await activeCommandTasks(redis, bookId, chapterId, sceneId, stage);

    // Always without the package's immediate re-dispatch.
    const fs = await dep('orchestrator').failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason,
        { dispatchId, redispatch: false });

    if (!fs || fs.failed !== true) {
        // Late / stale / rejected signal: the live dispatch was not failed —
        // nothing to retry and nothing to fail.
        return { ...(fs || {}), policy: { action: 'ignored', ...cls } };
    }

    if (tasks.length === 0) {
        await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_ATTEMPT_FAILED', 'failed', {
            stage, dispatch_id: dispatchId || null, reason: cls.error_message, error_class: cls.error_class,
            error_code: cls.error_code, decision: 'no_command',
        });
        dep('log')(`${bookId}/${chapterId}/${sceneId}:${stage} failed (${cls.error_class}) without an active command — no retry`);
        return { ...fs, redispatch: false, policy: { action: 'no_command', ...cls } };
    }

    // Counter per (task × scene × stage). Several active tasks of one stage
    // on one scene are rare (overlapping scopes) — the first (oldest) owns it.
    const owner = tasks[0];
    const aKey = attemptsKey(bookId, owner.task_id, chapterId, sceneId, stage);
    const attempts = await readAttempts(redis, aKey);
    const attemptNo = attempts.failures + 1; // 1-based number of THIS failed attempt
    const d = decide(cls.error_class, attempts.retries);

    attempts.failures = attemptNo;
    attempts.history.push({
        at: dep('now')(), attempt: attemptNo, dispatch_id: dispatchId || null,
        error_class: cls.error_class, error_code: cls.error_code, reason: cls.error_message,
        decision: d.retry ? 'retry' : 'failed',
    });
    if (attempts.history.length > 10) attempts.history = attempts.history.slice(-10);
    await writeAttempts(redis, aKey, attempts);

    await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_ATTEMPT_FAILED', 'failed', {
        stage, task_id: owner.task_id, attempt: attemptNo, dispatch_id: dispatchId || null,
        reason: cls.error_message, error_class: cls.error_class, error_code: cls.error_code,
        decision: d.retry ? 'retry' : 'failed', retries_done: attempts.retries, max_retries: d.maxRetries,
    });

    if (!d.retry) {
        const r = await failCommand(redis, { bookId, chapterId, sceneId, stage }, cls, attemptNo);
        return { ...fs, redispatch: false, policy: { action: 'failed', attempt: attemptNo, tasks: (r.tasks || []).map(t => t.task_id), ...cls } };
    }

    const dueAt = dep('now')() + d.pauseMs;
    const pKey = pendingKey(bookId, chapterId, sceneId, stage);
    const record = {
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId, stage,
        task_id: owner.task_id, attempts_key: aKey, retry_no: attempts.retries + 1,
        due_at: dueAt, pause_ms: d.pauseMs, boot_id: BOOT_ID,
        error_class: cls.error_class, error_code: cls.error_code, error_message: cls.error_message,
    };
    await redis.set(pKey, JSON.stringify(record), 'EX', PENDING_TTL_S);

    try {
        await dep('generationProgress').updateTask(redis, bookId, owner.task_id, {
            last_error: { error_class: cls.error_class, error_code: cls.error_code, error_message: cls.error_message, at: dep('now')() },
            retry: { scene: { chapter_id: chapterId, scene_id: sceneId }, retry_no: record.retry_no, max_retries: d.maxRetries, due_at: dueAt },
        });
    } catch (_) { /* panel info only */ }

    await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_RETRY_SCHEDULED', 'failed', {
        stage, task_id: owner.task_id, retry_no: record.retry_no, max_retries: d.maxRetries,
        pause_ms: d.pauseMs, due_at: dueAt, error_class: cls.error_class,
    });
    dep('log')(`${bookId}/${chapterId}/${sceneId}:${stage} ${cls.error_class} (${cls.error_code}) — retry ${record.retry_no}/${d.maxRetries} in ${Math.round(d.pauseMs / 1000)} s`);

    armTimer(redis, pKey, d.pauseMs);
    return { ...fs, redispatch: false, policy: { action: 'retry_scheduled', attempt: attemptNo, retry_no: record.retry_no, pause_ms: d.pauseMs, due_at: dueAt, ...cls } };
}

function armTimer(redis, pKey, delayMs) {
    const prev = timers.get(pKey);
    if (prev) clearTimeout(prev);
    // The callback returns the promise (ignored by the real timer; awaited
    // by tests through the setTimeout test dependency).
    const handle = dep('setTimeout')(() => {
        timers.delete(pKey);
        return fireRetry(redis, pKey).catch(err => dep('log')(`retry ${pKey} failed: ${err.message}`));
    }, delayMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    timers.set(pKey, handle);
}

/**
 * The pause is over: re-check the command and put the stage back to PENDING.
 * @returns {Promise<{retried:boolean, reason?:string}>}
 */
async function fireRetry(redis, pKey) {
    const raw = await redis.get(pKey);
    if (!raw) return { retried: false, reason: 'no_record' };
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { await redis.del(pKey); return { retried: false, reason: 'bad_record' }; }
    // Orchestration v2 (1b/E): a v2 book's record is not legacy's — left untouched.
    if (await dep('bookFlag').isV2BookFailClosed(rec.book_id)) return { retried: false, reason: 'orchestration_v2' };
    // Claim: exactly one executor (DEL returns 1 only once).
    if (Number(await redis.del(pKey)) !== 1) return { retried: false, reason: 'claimed' };

    const { book_id: bookId, chapter_id: chapterId, scene_id: sceneId, stage } = rec;
    const skip = async (why) => {
        await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_RETRY_SKIPPED', 'failed', {
            stage, task_id: rec.task_id, retry_no: rec.retry_no, reason: why,
        });
        dep('log')(`${bookId}/${chapterId}/${sceneId}:${stage} retry ${rec.retry_no} skipped (${why})`);
        try {
            const t = await dep('generationProgress').getTask(redis, bookId, rec.task_id);
            if (t && t.retry) await dep('generationProgress').updateTask(redis, bookId, rec.task_id, { retry: null });
        } catch (_) {}
        return { retried: false, reason: why };
    };

    if (rec.boot_id !== BOOT_ID) return skip('interrupted');

    const task = await dep('generationProgress').getTask(redis, bookId, rec.task_id);
    if (!task || task.status !== 'active') return skip(`task_${task ? task.status : 'missing'}`);

    const auth = await dep('commandGate').getAuthorizedStages(redis, bookId, chapterId, sceneId);
    if (!auth.stages.has(stage)) return skip(auth.denied && auth.denied[stage] ? auth.denied[stage] : 'not_authorized');

    const st = dep('state');
    const states = await st.getAssetStates(redis, bookId, chapterId, sceneId);
    const current = states ? states[stage] : null;
    if (current !== st.AssetState.FAILED) return skip(`asset_${current || 'missing'}`);
    const check = st.validateAssetTransition(current, st.AssetState.PENDING);
    if (!check.valid) return skip(`transition_${check.reason}`);
    await st.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, st.AssetState.PENDING);

    const attempts = await readAttempts(redis, rec.attempts_key);
    attempts.retries = Math.max(attempts.retries, rec.retry_no);
    await writeAttempts(redis, rec.attempts_key, attempts);

    try {
        await dep('generationProgress').updateTask(redis, bookId, rec.task_id, { retry: null });
    } catch (_) {}

    let added = null;
    try {
        added = await dep('scheduler').addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
    } catch (err) {
        dep('log')(`active index add failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }
    await journalEvent(redis, bookId, chapterId, sceneId, 'GPU_RETRY_REQUEUED', 'pending', {
        stage, task_id: rec.task_id, retry_no: rec.retry_no, error_class: rec.error_class,
        indexed: !!(added && added.added),
    });
    dep('log')(`${bookId}/${chapterId}/${sceneId}:${stage} retry ${rec.retry_no} → PENDING (scheduler dispatches on next tick)`);
    return { retried: true };
}

/**
 * Backend start: a pending retry belongs to the previous process — it is
 * dropped and journaled as interrupted, never executed (the owning task is
 * interrupted by startup-resume in the same step).
 */
async function interruptPendingRetries(redis) {
    let cursor = '0';
    let dropped = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}:pending:*`, 'COUNT', 200);
        cursor = next;
        for (const k of keys || []) {
            const raw = await redis.get(k);
            if (Number(await redis.del(k)) !== 1) continue;
            dropped++;
            try {
                const rec = JSON.parse(raw);
                await journalEvent(redis, rec.book_id, rec.chapter_id, rec.scene_id, 'GPU_RETRY_SKIPPED', 'failed', {
                    stage: rec.stage, task_id: rec.task_id, retry_no: rec.retry_no, reason: 'interrupted',
                });
            } catch (_) {}
        }
    } while (cursor !== '0');
    return dropped;
}

/**
 * Wrap the orchestration facade so every host caller of failStage (stall
 * watchdogs, reconcile replay of undelivered hub errors) goes through the
 * policy. An explicit `redispatch:false` caller keeps the plain call.
 * The wrapper inherits everything else from the facade (prototype chain).
 */
function wrapOrchestrator(orchestrator, getRedis) {
    const wrapped = Object.create(orchestrator);
    // defineProperty: the facade may expose members as getters, so a plain
    // assignment on the prototype-linked object would throw.
    Object.defineProperty(wrapped, 'failStage', { enumerable: true, configurable: true, writable: true, value: null });
    wrapped.failStage = async function policyFailStage(redis, bookId, chapterId, sceneId, stage, buildId, reason, opts = {}) {
        if (opts && opts.redispatch === false) {
            return orchestrator.failStage(redis, bookId, chapterId, sceneId, stage, buildId, reason, opts);
        }
        return handleStageFailure(redis || (getRedis && getRedis()), {
            bookId, chapterId, sceneId, stage, buildId, reason, dispatchId: opts && opts.dispatchId,
            source: 'failStage',
        });
    };
    return wrapped;
}

module.exports = {
    POLICY,
    KEY_PREFIX,
    BOOT_ID,
    attemptsKey,
    pendingKey,
    decide,
    handleStageFailure,
    fireRetry,
    interruptPendingRetries,
    wrapOrchestrator,
    setDepsForTest,
    resetDepsForTest,
};
