// ======================================================
// GPU retry policy after a worker error (owner decision 2026-11-02)
// ======================================================
// Basis: reports/2026-11-02/gpu-e2e-fixes.md §0 — task 6323: 6 dispatches in
// 85 s, each «No prompt_id» 0.1 s after task/next, FAIL-STAGE → PENDING,
// retry budget 10, stopped only by the circuit breaker.
// Docs: animastor-docs architecture/COMMAND_ONLY_GENERATION.md
//       §«Повтор после ошибки воркера».
//
//   deterministic → 0 retries, command failed
//   transient     → 2 retries (30 s, 120 s), then failed
//   oom           → 1 retry (60 s), then failed
//   unknown       → 0 retries (fail-closed)
//   a retry happens only under a live command (active task, layer on, no
//   cancel); a backend restart during a pause → interrupted, never a retry.
//
// Real modules: orchestration runtime (scheduler, dispatch engine, command
// gate), host state + task registry + journal over the in-memory Redis mock,
// PG repositories against the TEST database (test-db-safety guards it). The
// GPU executor is replaced through the S-5 seam registry; the policy's timer
// is replaced through its test dependency hook (no wall-clock waits).

'use strict';

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const { wireProductionSeams, seams } = require('./helpers/wire-seams');

const orchestration = require('@animastor/orchestration');
const scheduler = orchestration.runtime.scheduler;
const dispatchEngine = orchestration.runtime.dispatch;
const commandGate = orchestration.runtime.commandGate;
const state = require('../src/state');
const journal = require('../src/state/event-journal');
const generationProgress = require('../src/services/generation-progress');
const { query } = require('../src/storage/postgres/database');
const { interruptActiveGenerationTasks } = require('../src/startup-resume');
const policy = require('../src/services/gpu-retry-policy.cjs');
const { classifyGpuError, shortMessage } = require('../src/services/gpu-error-classifier.cjs');

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const CH = 'ch-retry';
const S1 = 'sc-retry-1';

function book(tag) { return `gpuretry-${tag}-${RUN}`; }

async function setLayers(redis, bookId, cfg) {
    await redis.set(`animastor:layer-config:${bookId}`, JSON.stringify({
        audio_enabled: true, image_enabled: true, video_enabled: false, ...cfg,
    }));
}

async function command(redis, bookId, type) {
    const [task] = await generationProgress.createTasks(redis, bookId, [type],
        { scope: 'current_scene', chapterId: CH, sceneId: S1 }, [{ chapter_id: CH, scene_id: S1 }]);
    return task;
}

async function journalTypes(redis, bookId) {
    const raw = await redis.lrange(`animastor:event-journal:${bookId}:${CH}:${S1}`, 0, -1);
    return raw.map(r => JSON.parse(r)).filter(e => String(e.type).startsWith('GPU_'));
}

describe('GPU retry policy after a worker error (owner decision 2026-11-02)', function () {
    this.timeout(20000);
    let redis;
    let executorCalls;
    let timers;
    let clock;
    const pgBooks = new Set();

    beforeEach(() => {
        redis = createMockRedis();
        executorCalls = [];
        timers = [];
        clock = 1_000_000;
        wireProductionSeams();
        policy.setDepsForTest({
            setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
            now: () => clock,
            log: () => {},
        });
        seams.registerOrchestrationSeams({
            dispatchStage: async (r, scene, loadedBook, buildId, stage) => {
                executorCalls.push(`${scene.scene_id}:${stage}`);
                // Like the real executor: the stage is GENERATING once jobs are sent.
                await state.unsafeRestoreAssetState(r, scene.book_id, scene.chapter_id, scene.scene_id, stage, state.AssetState.GENERATING);
                return { dispatched: true, jobs: 1 };
            },
        });
    });

    afterEach(() => {
        policy.resetDepsForTest();
        wireProductionSeams();
    });

    after(async () => {
        for (const b of pgBooks) {
            try { await query('DELETE FROM scene_assets WHERE book_id = $1', [b]); } catch (_) {}
            try { await query('DELETE FROM generation_tasks WHERE book_id = $1', [b]); } catch (_) {}
        }
    });

    /** One scheduler pass; returns the live dispatch_id of the stage (or null). */
    async function tickAndDispatchId(b, stage) {
        await dispatchEngine.clearDeferralsForBook(redis, b);
        await scheduler.tick(redis);
        const meta = await dispatchEngine.getDispatchMetadata(redis, b, CH, S1, stage);
        return meta ? meta.dispatch_id : null;
    }

    /** What /gpu/task/error does for one worker error. */
    function workerError(b, stage, dispatchId, reason, extra = {}) {
        return policy.handleStageFailure(redis, {
            bookId: b, chapterId: CH, sceneId: S1, stage, buildId: `build_${b}`,
            reason, dispatchId, ...extra,
        });
    }

    async function fireNextTimer() {
        const t = timers.shift();
        expect(t, 'a retry timer is armed').to.exist;
        clock += t.ms;
        await t.fn();
        return t.ms;
    }

    // ── classifier ────────────────────────────────────────────────────
    describe('classifier (pure, any worker 2.2.0+)', () => {
        const cases = [
            ['No prompt_id', 'deterministic', 'comfy_rejected'],
            ['No prompt_id: invalid_prompt: Cannot execute because node Qwen3TTSGenerate does not exist.', 'deterministic', 'comfy_missing_node'],
            ['No prompt_id: prompt_outputs_failed_validation: Value not in list: ckpt_name', 'deterministic', 'comfy_model_missing'],
            ['incompatible_task_protocol:v1', 'deterministic', 'comfy_invalid_workflow'],
            ['worker_timeout', 'transient', 'worker_lost'],
            ['Timeout waiting result (10min)', 'transient', 'execution_timeout'],
            ['fetch failed', 'transient', 'network'],
            ['Invalid JSON from ComfyUI: <html>502 Bad Gateway', 'transient', 'network'],
            ['torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB', 'oom', 'cuda_oom'],
            ['stale_dispatch_result', 'transient', 'stale_dispatch'],
            ['Hub rejected result: HTTP 409 {"error":"stale_or_unknown_dispatch","detail":"no_running_record"} stale_dispatch_result', 'transient', 'stale_dispatch'],
            ['Download failed: 404', 'unknown', 'unknown'],
            ['', 'unknown', 'unknown'],
        ];
        for (const [reason, cls, code] of cases) {
            it(`«${reason || '(empty)'}» → ${cls}/${code}`, () => {
                const r = classifyGpuError({ reason });
                expect(r.error_class).to.equal(cls);
                expect(r.error_code).to.equal(code);
            });
        }

        it('structured worker fields win over text (2.2.3+): error_class, comfy_status', () => {
            expect(classifyGpuError({ reason: 'something odd', error_class: 'oom' }).error_class).to.equal('oom');
            expect(classifyGpuError({ reason: 'something odd', error_class: 'oom' }).source).to.equal('worker');
            expect(classifyGpuError({ reason: 'weird', comfy_status: 400 }).error_class).to.equal('deterministic');
            expect(classifyGpuError({ reason: 'weird', comfy_status: 503 }).error_class).to.equal('transient');
            // An unknown declared class falls back to the text rules.
            expect(classifyGpuError({ reason: 'No prompt_id', error_class: 'bogus' }).error_class).to.equal('deterministic');
        });

        it('error_message is short, single-line, without a stack trace', () => {
            const long = `Error: boom ${'x'.repeat(400)}\n    at foo (/app/x.js:1:2)\n    at bar (/app/y.js:3:4)`;
            const m = shortMessage(long);
            expect(m).to.not.include('\n');
            expect(m).to.not.include('/app/');
            expect(m.length).to.be.at.most(200);
            expect(classifyGpuError('Error: boom\n    at x (/a.js:1:1)').error_message).to.equal('Error: boom');
        });

        it('policy table: deterministic 0, transient 2 (30 s, 120 s), oom 1 (60 s), unknown 0', () => {
            expect(policy.decide('deterministic', 0).retry).to.equal(false);
            expect(policy.decide('unknown', 0).retry).to.equal(false);
            expect(policy.decide('transient', 0)).to.include({ retry: true, pauseMs: 30000 });
            expect(policy.decide('transient', 1)).to.include({ retry: true, pauseMs: 120000 });
            expect(policy.decide('transient', 2).retry).to.equal(false);
            expect(policy.decide('oom', 0)).to.include({ retry: true, pauseMs: 60000 });
            expect(policy.decide('oom', 1).retry).to.equal(false);
        });
    });

    // ── scenario 6323 ─────────────────────────────────────────────────
    it('6323: «No prompt_id» → 1 dispatch, task failed, 0 retries (6 errors, 6 ticks)', async () => {
        const b = book('6323');
        pgBooks.add(b);
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'audio');
        await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status, build_id)
                     VALUES ($1, $2, $3, 'audio', 'pending', $4)`, [b, CH, S1, `build_${b}`]);
        expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).added).to.equal(true);

        const d1 = await tickAndDispatchId(b, 'audio');
        expect(d1).to.be.a('string');
        const r = await workerError(b, 'audio', d1, 'No prompt_id');
        expect(r.failed).to.equal(true);
        expect(r.redispatch).to.equal(false);
        expect(r.policy).to.include({ action: 'failed', error_class: 'deterministic', attempt: 1 });
        // The sibling job of the same dispatch reports too — a late signal.
        const late = await workerError(b, 'audio', d1, 'No prompt_id');
        expect(late.policy.action).to.equal('ignored');

        // Five more scheduler passes (the old run had 6 dispatches in 85 s).
        for (let i = 0; i < 5; i++) await tickAndDispatchId(b, 'audio');
        expect(executorCalls).to.deep.equal([`${S1}:audio`]);
        expect(timers).to.have.length(0);

        const t = await generationProgress.getTask(redis, b, task.task_id);
        expect(t.status).to.equal('failed');
        expect(t.error_class).to.equal('deterministic');
        expect(t.error_code).to.equal('comfy_rejected');
        expect(t.error_message).to.equal('No prompt_id');
        expect((await state.getAssetStates(redis, b, CH, S1)).audio).to.equal(state.AssetState.FAILED);
        expect(await commandGate.isStageAuthorized(redis, b, CH, S1, 'audio')).to.equal(false);

        const pg = await query(`SELECT status, error FROM scene_assets WHERE book_id = $1 AND asset_type = 'audio'`, [b]);
        expect(pg.rows[0].status).to.equal('failed');
        expect(pg.rows[0].error).to.match(/^gpu_failed:deterministic:No prompt_id/);

        const ev = await journalTypes(redis, b);
        expect(ev.map(e => e.type)).to.deep.equal(['GPU_ATTEMPT_FAILED', 'GPU_FAILURE_TERMINAL']);
        expect(ev[0].details).to.include({ attempt: 1, error_class: 'deterministic', decision: 'failed', reason: 'No prompt_id' });

        // A new command supersedes the failed task (retry = the button).
        const removed = await generationProgress.removeSupersededTasks(redis, b, ['audio'], [{ chapter_id: CH, scene_id: S1 }]);
        expect(removed).to.deep.equal([task.task_id]);
    });

    // ── transient ─────────────────────────────────────────────────────
    it('timeout → 3 attempts with pauses 30 s and 120 s, then failed', async () => {
        const b = book('timeout');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);

        const d1 = await tickAndDispatchId(b, 'image');
        let r = await workerError(b, 'image', d1, 'Timeout waiting result (10min)');
        expect(r.policy).to.include({ action: 'retry_scheduled', retry_no: 1, pause_ms: 30000, error_class: 'transient' });
        // During the pause the stage is FAILED: no tick dispatches it.
        await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        const during = await generationProgress.getTask(redis, b, task.task_id);
        expect(during.status).to.equal('active');
        expect(during.retry).to.include({ retry_no: 1, max_retries: 2 });
        expect(during.last_error).to.include({ error_class: 'transient', error_code: 'execution_timeout' });

        expect(await fireNextTimer()).to.equal(30000);
        expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.PENDING);
        const d2 = await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(2);
        expect(d2).to.not.equal(d1);

        r = await workerError(b, 'image', d2, 'worker_timeout');
        expect(r.policy).to.include({ action: 'retry_scheduled', retry_no: 2, pause_ms: 120000 });
        expect(await fireNextTimer()).to.equal(120000);
        const d3 = await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(3);

        r = await workerError(b, 'image', d3, 'Timeout waiting result (10min)');
        expect(r.policy).to.include({ action: 'failed', attempt: 3 });
        expect(timers).to.have.length(0);
        for (let i = 0; i < 3; i++) await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(3);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('failed');

        const types = (await journalTypes(redis, b)).map(e => e.type);
        expect(types).to.deep.equal([
            'GPU_ATTEMPT_FAILED', 'GPU_RETRY_SCHEDULED', 'GPU_RETRY_REQUEUED',
            'GPU_ATTEMPT_FAILED', 'GPU_RETRY_SCHEDULED', 'GPU_RETRY_REQUEUED',
            'GPU_ATTEMPT_FAILED', 'GPU_FAILURE_TERMINAL',
        ]);
        const reasons = (await journalTypes(redis, b)).filter(e => e.type === 'GPU_ATTEMPT_FAILED').map(e => e.details.reason);
        expect(reasons).to.deep.equal(['Timeout waiting result (10min)', 'worker_timeout', 'Timeout waiting result (10min)']);
    });

    it('CUDA OOM → 1 retry after 60 s, then failed', async () => {
        const b = book('oom');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        const r1 = await workerError(b, 'image', d1, 'torch.cuda.OutOfMemoryError: CUDA out of memory');
        expect(r1.policy).to.include({ action: 'retry_scheduled', pause_ms: 60000, error_class: 'oom' });
        await fireNextTimer();
        const d2 = await tickAndDispatchId(b, 'image');
        const r2 = await workerError(b, 'image', d2, 'whatever', { errorClass: 'oom' });
        expect(r2.policy).to.include({ action: 'failed', error_class: 'oom', attempt: 2 });
        expect(executorCalls).to.have.length(2);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('failed');
    });

    it('unknown error → failed, no retry (fail-closed)', async () => {
        const b = book('unknown');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        const r = await workerError(b, 'image', d1, 'Download failed: 404');
        expect(r.policy).to.include({ action: 'failed', error_class: 'unknown' });
        for (let i = 0; i < 3; i++) await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        expect(timers).to.have.length(0);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('failed');
    });

    // ── the pause respects the command ────────────────────────────────
    it('cancel during the pause → no retry', async () => {
        const b = book('cancel');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await workerError(b, 'image', d1, 'fetch failed');
        await generationProgress.markCancelled(redis, b, task.task_id);
        await fireNextTimer();
        await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.FAILED);
        const skipped = (await journalTypes(redis, b)).find(e => e.type === 'GPU_RETRY_SKIPPED');
        expect(skipped.details.reason).to.equal('task_cancelled');
    });

    it('book cancel flag during the pause → no retry', async () => {
        const b = book('cancelflag');
        await setLayers(redis, b, {});
        await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await workerError(b, 'image', d1, 'worker_timeout');
        await redis.set(orchestration.runtime.sceneWindow.cancelKey(b), 'true');
        await fireNextTimer();
        await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        const skipped = (await journalTypes(redis, b)).find(e => e.type === 'GPU_RETRY_SKIPPED');
        expect(skipped.details.reason).to.equal('cancelled');
    });

    it('layer switched off during the pause → no retry', async () => {
        const b = book('layeroff');
        await setLayers(redis, b, {});
        await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await workerError(b, 'image', d1, 'worker_timeout');
        await setLayers(redis, b, { image_enabled: false });
        await fireNextTimer();
        await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        const skipped = (await journalTypes(redis, b)).find(e => e.type === 'GPU_RETRY_SKIPPED');
        expect(skipped.details.reason).to.equal('layer_disabled');
    });

    it('backend restart during the pause → task interrupted, never a retry', async () => {
        const b = book('restart');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await workerError(b, 'image', d1, 'worker_timeout');
        const pKey = policy.pendingKey(b, CH, S1, 'image');
        expect(await redis.get(pKey)).to.be.a('string');

        // Restart: the timer of the old process is gone; startup interrupts
        // the tasks and drops the pending retry records.
        timers.length = 0;
        // The redis mock cannot SCAN registry hashes — the book list is
        // injected through the existing deps parameter (as in
        // command-only-generation.test.js); real SCAN in prod.
        await interruptActiveGenerationTasks(redis, {
            generationProgress: { ...generationProgress, listBooksWithTasks: async () => [b] },
            scheduler,
            taskRepo: { interruptActiveTasks: async () => 0 },
            log: () => {},
        });
        expect(await policy.interruptPendingRetries(redis)).to.equal(1);
        expect(await redis.get(pKey)).to.equal(null);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('interrupted');
        for (let i = 0; i < 3; i++) await tickAndDispatchId(b, 'image');
        expect(executorCalls).to.have.length(1);
        const skipped = (await journalTypes(redis, b)).find(e => e.type === 'GPU_RETRY_SKIPPED');
        expect(skipped.details.reason).to.equal('interrupted');

        // A record of a previous process is never executed even if read.
        await redis.set(pKey, JSON.stringify({
            book_id: b, chapter_id: CH, scene_id: S1, stage: 'image', task_id: task.task_id,
            retry_no: 1, boot_id: 'other-process',
        }));
        expect(await policy.fireRetry(redis, pKey)).to.deep.equal({ retried: false, reason: 'interrupted' });
    });

    it('a new command during the pause: the old timer does not touch the new run', async () => {
        const b = book('newcmd');
        await setLayers(redis, b, {});
        const old = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await workerError(b, 'image', d1, 'worker_timeout');
        // The user presses the button: old task gone, new one active, stage reset.
        await generationProgress.markCancelled(redis, b, old.task_id);
        await command(redis, b, 'image');
        await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.PENDING);
        await fireNextTimer();
        const skipped = (await journalTypes(redis, b)).find(e => e.type === 'GPU_RETRY_SKIPPED');
        expect(skipped.details.reason).to.equal('task_cancelled');
    });

    // ── hub v0.2.9: lost claim (409 no_running_record) ────────────────
    // reports/2026-11-04/regenerate-sweep-fix.md: the hub rejected a result
    // because its running record was swept away; it now signals the backend
    // (POST /gpu/task/error reason stale_dispatch_result, error_class
    // transient). The backend must act AT ONCE on a live dispatch (no wait for
    // stale-lease recovery) and never on a cancelled/superseded one.
    it('hub stale_dispatch_result on a LIVE dispatch → failed now, retry in 30 s under the command, re-dispatched', async () => {
        const b = book('stale-live');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        expect(await dispatchEngine.verifyDispatchIdentity(redis, b, CH, S1, 'image', d1)).to.include({ valid: true });

        const r = await workerError(b, 'image', d1, 'stale_dispatch_result', { errorClass: 'transient' });
        expect(r.failed).to.equal(true);
        expect(r.policy).to.include({ action: 'retry_scheduled', retry_no: 1, pause_ms: 30000, error_class: 'transient', error_code: 'stale_dispatch' });
        // the dispatch is finalized right away: no live lease left to wait for
        expect(await dispatchEngine.getDispatchMetadata(redis, b, CH, S1, 'image')).to.equal(null);
        // a duplicate signal (task/error after result) is a late signal
        expect((await workerError(b, 'image', d1, 'stale_dispatch_result', { errorClass: 'transient' })).policy.action).to.equal('ignored');

        await fireNextTimer();
        const d2 = await tickAndDispatchId(b, 'image');
        expect(d2).to.be.a('string').and.not.equal(d1);
        expect(executorCalls).to.deep.equal([`${S1}:image`, `${S1}:image`]);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('active');
    });

    it('hub stale_dispatch_result on a dispatch CANCELLED by a reset → ignored, nothing re-dispatched', async () => {
        const b = book('stale-cancelled');
        await setLayers(redis, b, {});
        await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await dispatchEngine.cancelActiveDispatch(redis, b, CH, S1, 'image', 'scene_reset');
        expect((await dispatchEngine.verifyDispatchIdentity(redis, b, CH, S1, 'image', d1)).valid).to.equal(false);
        const r = await workerError(b, 'image', d1, 'stale_dispatch_result', { errorClass: 'transient' });
        expect(r.policy.action).to.equal('ignored');
        expect(timers).to.have.length(0);
    });

    it('hub stale_dispatch_result after the command was cancelled → no retry (command-gate)', async () => {
        const b = book('stale-nocmd');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await generationProgress.markCancelled(redis, b, task.task_id);
        const r = await workerError(b, 'image', d1, 'stale_dispatch_result', { errorClass: 'transient' });
        expect(r.policy.action).to.equal('no_command');
        expect(timers).to.have.length(0);
    });

    // ── no command / late signals / wrapper ───────────────────────────
    it('failure without an active command: FAILED, no retry, nothing re-dispatched', async () => {
        const b = book('nocmd');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        await generationProgress.markCancelled(redis, b, task.task_id);
        const r = await workerError(b, 'image', d1, 'worker_timeout');
        expect(r.policy.action).to.equal('no_command');
        expect(timers).to.have.length(0);
        expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.FAILED);
    });

    it('wrapOrchestrator: watchdog-style failStage (no redispatch flag) goes through the policy; redispatch:false passes through', async () => {
        const b = book('wrap');
        await setLayers(redis, b, {});
        const task = await command(redis, b, 'image');
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
        const d1 = await tickAndDispatchId(b, 'image');
        const wrapped = policy.wrapOrchestrator(require('@animastor/orchestration'));
        // inherits the facade
        expect(wrapped.markDirtyScene).to.equal(require('@animastor/orchestration').markDirtyScene);
        const r = await wrapped.failStage(redis, b, CH, S1, 'image', `build_${b}`, 'No prompt_id', { dispatchId: d1 });
        expect(r.policy.action).to.equal('failed');
        expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.FAILED);
        expect((await generationProgress.getTask(redis, b, task.task_id)).status).to.equal('failed');
    });

    it('/gpu/task/error route uses the policy with the structured fields (wiring guard)', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'generation-routes.cjs'), 'utf8');
        const route = src.slice(src.indexOf("app.post('/gpu/task/error'"));
        expect(route).to.include('gpuRetryPolicy.handleStageFailure(');
        expect(route).to.include('errorClass:');
        expect(route).to.include('comfyStatus: comfy_status');
        expect(route).to.not.match(/orchestrator\.failStage\(/);
        const root = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'backend.cjs'), 'utf8');
        expect(root).to.include('gpuRetryPolicy.wrapOrchestrator(orchestrationPkg)');
        expect(root).to.include('gpuRetryPolicy.interruptPendingRetries(redis)');
    });
});
