// ======================================================
// Command-only generation — regression net (2026-10-31)
// ======================================================
// Owner rule: GPU generation starts ONLY by the explicit «аудио» / «картинки»
// / «всё» commands; no automatic next stage, no background starts, tasks only
// for enabled layers. Invariant: a scene×stage reaches the active index /
// dispatch ONLY under an ACTIVE task-registry task of that stage created by an
// explicit command, with the layer enabled and no cancellation.
//
// Basis: reports/2026-10-31/auto-image-task-ba-incident.md §6/§8/§9.
// Docs:  animastor-docs architecture/COMMAND_ONLY_GENERATION.md
//
// Real modules: orchestration runtime (scheduler, reconcile, dispatch engine,
// command gate), host state + task registry over the in-memory Redis mock,
// PG repositories against the TEST database (test-db-safety guards it). The
// GPU executor is replaced through the existing S-5 seam registry
// (registerOrchestrationSeams) — no production test hooks.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const { wireProductionSeams, seams } = require('./helpers/wire-seams');

const orchestration = require('@animastor/orchestration');
const scheduler = orchestration.runtime.scheduler;
const reconciliation = orchestration.runtime.reconciliation;
const dispatchEngine = orchestration.runtime.dispatch;
const commandGate = orchestration.runtime.commandGate;
const state = require('../src/state');
const generationProgress = require('../src/services/generation-progress');
const sceneAssetsRepo = require('../src/storage/postgres/repositories/scene-assets-repo');
const taskRepo = require('../src/storage/postgres/repositories/task-repo');
const { query } = require('../src/storage/postgres/database');
const { cancelStage } = require('../src/services/stage-cancellation.cjs');
const { interruptActiveGenerationTasks } = require('../src/startup-resume');

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const CH = 'ch-cmd';
const S1 = 'sc-cmd-1';
const S2 = 'sc-cmd-2';

function book(tag) { return `cmdonly-${tag}-${RUN}`; }

async function setLayers(redis, bookId, cfg) {
    await redis.set(`animastor:layer-config:${bookId}`, JSON.stringify({
        audio_enabled: true, image_enabled: true, video_enabled: false, ...cfg,
    }));
}

async function command(redis, bookId, type, scenes) {
    const [task] = await generationProgress.createTasks(redis, bookId, [type],
        { scope: 'current_scene', chapterId: scenes[0].chapter_id, sceneId: scenes[0].scene_id }, scenes);
    return task;
}

async function activeKeysOf(redis, bookId) {
    return (await redis.smembers(scheduler.ACTIVE_SCENES_KEY)).filter(k => k.startsWith(`${bookId}:`));
}

function stageCancelDeps() {
    return {
        generationProgress, taskRepo, sceneAssetsRepo, dispatchEngine,
        scheduler, commandGate,
        config: { HUB_URL: 'http://127.0.0.1:9', GPU_HUB_API_KEY: null },
        log: () => {},
    };
}

async function insertAsset(bookId, chapterId, sceneId, assetType, status) {
    await query(`
        INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status, build_id)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [bookId, chapterId, sceneId, assetType, status, `build_${bookId}`]);
}

async function assetStatuses(bookId) {
    const r = await query(`SELECT scene_id, asset_type, status FROM scene_assets WHERE book_id = $1 ORDER BY scene_id, asset_type`, [bookId]);
    return r.rows.map(x => `${x.scene_id}:${x.asset_type}:${x.status}`);
}

describe('Command-only generation (owner rule 2026-10-31)', function () {
    this.timeout(20000);
    let redis;
    let executorCalls;
    const pgBooks = new Set();

    beforeEach(() => {
        redis = createMockRedis();
        executorCalls = [];
        wireProductionSeams();
    });

    afterEach(() => {
        // Restore the production executor seam for the next suites.
        wireProductionSeams();
    });

    after(async () => {
        for (const b of pgBooks) {
            try { await query('DELETE FROM scene_assets WHERE book_id = $1', [b]); } catch (_) {}
        }
    });

    function stubExecutor(result) {
        seams.registerOrchestrationSeams({
            dispatchStage: async (r, scene, loadedBook, buildId, stage) => {
                executorCalls.push(`${scene.scene_id}:${stage}`);
                return typeof result === 'function' ? result(scene, stage) : result;
            },
        });
    }

    // ── §9.1 ────────────────────────────────────────────────────────────
    describe('reconcile never creates work', () => {
        for (const imageEnabled of [false, true]) {
            it(`audio READY + image ${imageEnabled ? 'ON' : 'OFF'} → no image PENDING, nothing in the active index`, async () => {
                const b = book(`rec-${imageEnabled}`);
                await setLayers(redis, b, { image_enabled: imageEnabled });
                await state.unsafeRestoreAssetState(redis, b, CH, S1, 'audio', state.AssetState.READY);
                await redis.rpush(`animastor:event-journal:${b}:${CH}:${S1}`, '{}');

                const report = await reconciliation.reconcileScene(redis, b, CH, S1);
                const fixes = reconciliation.getFixRecommendations(report.inconsistentScenes);
                for (const fix of fixes.filter(f => f.safeToExecute)) await reconciliation.applyFix(redis, fix);
                await reconciliation.reconcileCycle(redis, {}, { startup: false });

                expect(fixes.map(f => f.action)).to.not.include('PROGRESS_TO_IMAGE');
                expect(report.partialBuilds.map(p => p.type)).to.include('partial_audio_only'); // diagnostics only
                const states = await state.getAssetStates(redis, b, CH, S1);
                expect(states.image).to.not.equal(state.AssetState.PENDING);
                expect(await activeKeysOf(redis, b)).to.deep.equal([]);
            });
        }

        it('REGENERATE_MISSING_ASSET without a command is diagnostics only', async () => {
            const b = book('rec-missing');
            await setLayers(redis, b, {});
            await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.READY);
            const res = await reconciliation.applyFix(redis, {
                scene: { bookId: b, chapterId: CH, sceneId: S1 },
                action: 'REGENERATE_MISSING_ASSET', reason: 'IMAGE_READY but no image file', safeToExecute: true,
            });
            expect(res.success).to.equal(false);
            expect(res.diagnostic).to.equal(true);
            expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.READY);
            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
        });

        it('orphan GENERATING without a command → DIRTY (ghost released), never PENDING, not re-queued', async () => {
            const b = book('rec-orphan');
            await setLayers(redis, b, {});
            await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.GENERATING);
            const res = await reconciliation.applyFix(redis, {
                scene: { bookId: b, chapterId: CH, sceneId: S1 }, stage: 'image',
                action: 'MOVE_TO_PENDING', reason: 'orphan', safeToExecute: true,
            });
            expect(res.diagnostic).to.equal(true);
            expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.DIRTY);
            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
        });
    });

    // ── invariant at the index write ───────────────────────────────────
    describe('active index write is command-gated', () => {
        it('no task → not added; task of the stage → added; layer off → not added; cancelled → not added', async () => {
            const b = book('gate');
            await setLayers(redis, b, { image_enabled: false });
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).denied).to.equal(true);

            await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            const denied = await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
            expect(denied.denied, 'image task but image layer disabled').to.equal(true);

            await setLayers(redis, b, { image_enabled: true });
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).added).to.equal(true);
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S2)).denied, 'S2 not targeted').to.equal(true);

            await redis.srem(scheduler.ACTIVE_SCENES_KEY, `${b}:${CH}:${S1}`);
            await orchestration.runtime.sceneWindow.setCancelFlag(redis, b);
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).denied).to.equal(true);
        });

        it('the cancel flag (no TTL) does not block the NEXT explicit command once /regenerate clears it', async () => {
            const b = book('cancel-next');
            await setLayers(redis, b, {});
            await orchestration.runtime.sceneWindow.setCancelFlag(redis, b);
            await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
            expect(await commandGate.isStageAuthorized(redis, b, CH, S1, 'audio')).to.equal(false);
            await orchestration.runtime.sceneWindow.clearCancelFlag(redis, b); // what /regenerate does
            expect(await commandGate.isStageAuthorized(redis, b, CH, S1, 'audio')).to.equal(true);
        });
    });

    // ── §9.2 ────────────────────────────────────────────────────────────
    describe('no_worker_available → blocked, no retry', () => {
        it('one attempt, the task becomes blocked (no_worker:image), following ticks never retry', async () => {
            const b = book('noworker');
            await setLayers(redis, b, {});
            const task = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            stubExecutor({ dispatched: false, jobs: 0, reason: 'no_worker_available', retryable: true });
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).added).to.equal(true);

            await scheduler.tick(redis);
            expect(executorCalls).to.deep.equal([`${S1}:image`]);
            const blocked = await generationProgress.getTask(redis, b, task.task_id);
            expect(blocked.status).to.equal('blocked');
            expect(blocked.blocked_reason).to.equal('no_worker:image');

            // Even with the capacity backoff gone, nothing retries the stage.
            for (let i = 0; i < 3; i++) {
                await dispatchEngine.clearDeferralsForBook(redis, b);
                await scheduler.tick(redis);
            }
            expect(executorCalls).to.have.length(1);
            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
            expect(await commandGate.isStageAuthorized(redis, b, CH, S1, 'image')).to.equal(false);
        });

        it('a new command supersedes the blocked task', async () => {
            const b = book('supersede');
            await setLayers(redis, b, {});
            const old = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            await generationProgress.blockSceneStage(redis, b, CH, S1, 'image', 'no_worker:image');
            const removed = await generationProgress.removeSupersededTasks(redis, b, ['image'], [{ chapter_id: CH, scene_id: S1 }]);
            expect(removed).to.deep.equal([old.task_id]);
            await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            expect(await commandGate.isStageAuthorized(redis, b, CH, S1, 'image')).to.equal(true);
        });

        it('GENERATING of a blocked stage is released to DIRTY, never PENDING', async () => {
            const b = book('nw-dirty');
            await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.GENERATING);
            const r = await commandGate.rollbackGeneratingToDirty(redis, b, CH, S1, 'image', 'no_worker_available');
            expect(r.changed).to.equal(true);
            expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.DIRTY);
        });
    });

    // ── §9.3 ────────────────────────────────────────────────────────────
    describe('cancel leaves no PENDING in PG', () => {
        it('cancelPendingAssets (cancel-generation leg): pending → cancelled, ready/placeholder untouched', async () => {
            const b = book('pg-cancel');
            pgBooks.add(b);
            await insertAsset(b, CH, S1, 'image', 'pending');
            await insertAsset(b, CH, S1, 'audio', 'ready');
            await insertAsset(b, CH, S2, 'audio', 'placeholder');
            await insertAsset(b, CH, S2, 'video', 'pending');
            const n = await sceneAssetsRepo.cancelPendingAssets(b, ['audio', 'image', 'video'], null, 'cancel-generation');
            expect(n).to.equal(2);
            expect(await assetStatuses(b)).to.deep.equal([
                `${S1}:audio:ready`, `${S1}:image:cancelled`, `${S2}:audio:placeholder`, `${S2}:video:cancelled`,
            ]);
        });

        it('cancel-worker by task: only that task\'s scenes/stage; registry task cancelled; PG pending → cancelled', async () => {
            const b = book('pg-task');
            pgBooks.add(b);
            await setLayers(redis, b, {});
            await insertAsset(b, CH, S1, 'image', 'pending');
            await insertAsset(b, CH, S2, 'image', 'pending');
            const t1 = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S2 }]);
            await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
            await scheduler.addSceneToActiveIndex(redis, b, CH, S2);

            await cancelStage({
                redis, bookId: b, stage: 'image', tasks: [t1], wholeBook: false,
                reason: 'cancel-worker:task', context: 'CANCEL-WORKER', deps: stageCancelDeps(),
            });

            expect((await generationProgress.getTask(redis, b, t1.task_id)).status).to.equal('cancelled');
            expect(await assetStatuses(b)).to.deep.equal([`${S1}:image:cancelled`, `${S2}:image:pending`]);
            expect(await activeKeysOf(redis, b)).to.deep.equal([`${b}:${CH}:${S2}`]);
        });
    });

    // ── §9.4 ────────────────────────────────────────────────────────────
    describe('layer OFF stops the stage', () => {
        it('PUT layer-config image_enabled=false routine: scene leaves the index, task cancelled, PG pending → cancelled', async () => {
            const b = book('layer-off');
            pgBooks.add(b);
            await setLayers(redis, b, {});
            await insertAsset(b, CH, S1, 'image', 'pending');
            await insertAsset(b, CH, S1, 'audio', 'ready');
            const t = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.GENERATING);
            expect((await scheduler.addSceneToActiveIndex(redis, b, CH, S1)).added).to.equal(true);

            await setLayers(redis, b, { image_enabled: false });
            await cancelStage({
                redis, bookId: b, stage: 'image', tasks: null, wholeBook: true,
                reason: 'layer_disabled:image', context: 'LAYER-CONFIG', deps: stageCancelDeps(),
            });

            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
            expect((await generationProgress.getTask(redis, b, t.task_id)).status).to.equal('cancelled');
            expect((await state.getAssetStates(redis, b, CH, S1)).image).to.equal(state.AssetState.DIRTY);
            expect(await assetStatuses(b)).to.deep.equal([`${S1}:audio:ready`, `${S1}:image:cancelled`]);
        });

        it('a disabled layer is never scheduled even while PENDING (no isInFlight override)', async () => {
            const b = book('inflight');
            await setLayers(redis, b, {});
            await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
            await state.unsafeRestoreAssetState(redis, b, CH, S1, 'image', state.AssetState.PENDING);
            await setLayers(redis, b, { image_enabled: false });
            const plan = await scheduler.shouldScheduleAssets(redis, b, CH, S1);
            expect(plan.stages).to.deep.equal([]);
            expect(plan.allDone).to.equal(true);
        });
    });

    // ── §9.5 ────────────────────────────────────────────────────────────
    describe('backend restart creates no work', () => {
        it('active tasks → interrupted; the active index is drained; the next tick dispatches nothing', async () => {
            const b = book('restart');
            await setLayers(redis, b, {});
            const t = await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
            await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
            // a stale index entry written before the gate existed
            await redis.sadd(scheduler.ACTIVE_SCENES_KEY, `${b}:${CH}:${S2}`);
            stubExecutor({ dispatched: true, jobs: 1 });

            const out = await interruptActiveGenerationTasks(redis, {
                generationProgress, scheduler,
                taskRepo: { interruptActiveTasks: async () => 0 },
                log: () => {},
            });

            expect(out.tasks).to.equal(1);
            expect((await generationProgress.getTask(redis, b, t.task_id)).status).to.equal('interrupted');
            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
            await scheduler.tick(redis);
            expect(executorCalls).to.deep.equal([]);
        });

        it('C8 asset-state rebuild writes no PENDING and adds nothing to the index', async () => {
            const b = book('c8');
            await setLayers(redis, b, {});
            await reconciliation.rebuildWorkList(redis);
            expect(await activeKeysOf(redis, b)).to.deep.equal([]);
        });
    });

    // ── §9.6 ────────────────────────────────────────────────────────────
    describe('force covers only the command scene×stage', () => {
        it('/regenerate audio of one scene → force set = {S1:audio}; S2 and S1:image are not forced', async () => {
            const b = book('force');
            await setLayers(redis, b, { image_enabled: true });
            await orchestration.resetScenes(redis, b, `build_${b}`,
                [{ chapter_id: CH, scene_id: S1, dirty_layers: ['audio'] }],
                { audio_enabled: true, image_enabled: true, video_enabled: false },
                { bookDiff: { markDirtyScenes: async () => ({ marked: 1 }) }, readdToActiveIndex: false });

            const forceSet = await commandGate.getForceStages(redis, b);
            expect([...forceSet]).to.deep.equal([commandGate.forceMember(CH, S1, 'audio')]);
            expect(await redis.get(`animastor:force-dispatch:${b}`), 'no book-wide flag').to.equal(null);

            // Through the real tick: S1 audio forced, S2 image not.
            await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
            await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S2 }]);
            await scheduler.addSceneToActiveIndex(redis, b, CH, S1);
            await scheduler.addSceneToActiveIndex(redis, b, CH, S2);
            const seen = [];
            const original = dispatchEngine.dispatchStage;
            dispatchEngine.dispatchStage = async (r, bk, ch, sc, stage, lb, build, opts) => {
                seen.push(`${sc}:${stage}:force=${!!(opts && opts.force)}`);
                return { dispatched: true, dispatchId: 'x' };
            };
            try {
                await scheduler.tick(redis);
            } finally {
                dispatchEngine.dispatchStage = original;
            }
            expect(seen.sort()).to.deep.equal([`${S1}:audio:force=true`, `${S2}:image:force=false`]);
        });
    });
});
