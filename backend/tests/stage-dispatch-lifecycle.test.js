// ======================================================
// Stage dispatch lifecycle guard — regression tests
// ======================================================
// Fix for docs/runtime-audits/video-retry-targeted-investigation-2026-08-26.md:
// a partial SCENE_RESET left video at NEW while image was READY.
// dispatchStage skipped initialization, setSceneGenerating(new→generating)
// was rejected and swallowed, the GPU job was sent anyway, the successful
// result was rejected by handleVideoCompleted ('invalid_asset_state'),
// converted to FAILURE, burned retry budget and opened the circuit breaker.
//
// CASE A: image READY + video NEW → NEW→PENDING→GENERATING before dispatch
// CASE B: rejected state transition → no GPU job (dispatch aborts)
// CASE C: successful video callback with GENERATING → ok:true (not FAILURE);
//         legacy NEW state is still rejected by the handler whitelist
// CASE D: after successful completion (READY) scheduler does NOT re-dispatch
// CASE E: stale callback of an old dispatch cannot damage the new dispatch

const { expect } = require('chai');
const state = require('../src/state');
const orchestrator = require('../node_modules/@animastor/orchestration/src/orchestration/orchestrator');
const sceneOrchestrator = require('../node_modules/@animastor/orchestration/src/orchestration/scene-orchestrator');
const callbacks = require('../node_modules/@animastor/orchestration/src/orchestration/scene-callbacks');
const dispatchEngine = require('../node_modules/@animastor/orchestration/src/runtime/dispatch-engine');
const runtimeScheduler = require('../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler');
const videoService = require('../src/video/video-service');
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'test_book', C = 'ch-1', S = 'sc-1';

async function setState(redis, asset, value) {
    await state.setAssetState(redis, B, C, S, asset, value);
}

async function getState(redis, asset) {
    const states = await state.getAssetStates(redis, B, C, S);
    return states[asset];
}

async function createActiveDispatch(redis, stage, dispatchId) {
    const quota = await dispatchEngine.acquireQuota(redis, stage);
    expect(quota.acquired).to.equal(true);
    const lease = await dispatchEngine.acquireStageLease(redis, B, C, S, stage);
    expect(lease.acquired).to.equal(true);
    await dispatchEngine.setDispatchMetadata(
        redis, B, C, S, stage,
        dispatchEngine.createDispatchMetadata(dispatchId, stage, 'test', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        })
    );
    return dispatchId;
}


// Command-only generation (2026-10-31): a stage is schedulable only under an
// ACTIVE task-registry task (the explicit command) — this writes that record.
async function giveCommand(redis, types, bookId, chapterId, sceneId) {
    return require('../src/services/generation-progress').createTasks(redis, bookId, types,
        { scope: 'current_scene', chapterId, sceneId }, [{ chapter_id: chapterId, scene_id: sceneId }]);
}
describe('stage dispatch lifecycle guard (video re-dispatch incident fix)', () => {

    describe('CASE A: partial scene (image READY + video NEW)', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('initializes NEW → PENDING → GENERATING and reports dispatchable', async () => {
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.NEW);

            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );

            expect(result.ok).to.equal(true);
            // The job may only be sent from a valid in-flight state
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);
        });

        it('NEW → PENDING step is applied through the facade (valid transition)', async () => {
            await setState(redis, 'video', state.AssetState.NEW);
            const init = await orchestrator.setScenePending(redis, B, C, S, 'video');
            expect(init.changed).to.equal(true);
            expect(await getState(redis, 'video')).to.equal(state.AssetState.PENDING);
        });
    });

    describe('CASE B: rejected state transition must abort BEFORE any GPU job', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('READY asset is not dispatchable (no transition to GENERATING)', async () => {
            await setState(redis, 'video', state.AssetState.READY);

            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );

            expect(result.ok).to.equal(false);
            expect(result.reason).to.match(/^generating_transition_failed:/);
            // State untouched — nothing was sent
            expect(await getState(redis, 'video')).to.equal(state.AssetState.READY);
        });

        it('DIRTY asset walks DIRTY → PENDING → GENERATING (stage 50 normalization)', async () => {
            // Stage 50: DIRTY → GENERATING остаётся запрещённым FSM, но guard
            // обязан провести ассет через FSM-легальный PENDING-хоп — раньше
            // «scheduler's version-stale pre-pass owns DIRTY→PENDING» был
            // незакрытым контрактом, и dirty-ассеты не могли перегенерироваться
            // через планировщик вообще (INVALID state=dirty attempted=generating,
            // Case A stage 49). Комментарий теста сохранён как контракт, теперь
            // реализованный здесь.
            await setState(redis, 'video', state.AssetState.DIRTY);
            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );
            expect(result.ok).to.equal(true);
            // The dispatch happens only AFTER the FSM-legal PENDING hop —
            // evidenced by the journal event written by setScenePending.
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);
            const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
                .map(JSON.parse);
            const pending = events.find(e => e.type === 'SCENE_PENDING' && e.details?.asset === 'video');
            expect(pending, 'DIRTY must pass through PENDING before GENERATING').to.exist;
        });

        it('already-GENERATING asset stays dispatchable (idempotent)', async () => {
            await setState(redis, 'video', state.AssetState.GENERATING);
            const result = await sceneOrchestrator.ensureStageDispatchable(
                redis, B, C, S, 'video'
            );
            expect(result.ok).to.equal(true);
        });

        it('executor dispatches a DIRTY video through the PENDING hop — abort reasons are state failures, not FSM deadlocks (stage 50)', async () => {
            // Stage 50: dirty→generating больше не тупик — guard проводит
            // DIRTY → PENDING → GENERATING до любой отправки job'а. Здесь
            // loadedBook=null → dispatch падает на загрузке данных книги с
            // НУЛЁМ отправленных job'ов и ассетом в GENERATING (не в DIRTY).
            await setState(redis, 'video', state.AssetState.DIRTY);

            const result = await sceneOrchestrator.dispatchStage(
                redis,
                { book_id: B, chapter_id: C, scene_id: S },
                null,           // loadedBook unused — abort happens before book load
                'build-1',
                'video',
                'dispatch-dirty-normalized'
            );

            expect(result.dispatched).to.equal(false);
            expect(result.jobs).to.equal(0);
            // FSM deadlock reason is gone — DIRTY reaches GENERATING now.
            expect(result.reason).to.not.match(/^generating_transition_failed:/);
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);
        });
    });

    describe('CASE C: successful video callback must be SUCCESS, not FAILURE', () => {
        let redis;
        let originalValidate;
        beforeEach(() => {
            redis = createMockRedis();
            originalValidate = videoService.validateVideoFile;
            // Stub disk validation: unit test must not touch /data/output
            videoService.validateVideoFile = () => ({
                valid: true, duration: 5, metadata: { width: 640, height: 480 }
            });
        });
        afterEach(() => { videoService.validateVideoFile = originalValidate; });

        it('GENERATING + valid artifact → ok:true (SUCCESS path)', async () => {
            await setState(redis, 'video', state.AssetState.GENERATING);
            const result = await callbacks.handleVideoCompleted(redis, B, C, S, 'b1');
            expect(result.ok).to.equal(true);
            expect(result.artifact).to.exist;
        });

        it('incident regression: legacy NEW state is still rejected (whitelist intact)', async () => {
            await setState(redis, 'video', state.AssetState.NEW);
            const result = await callbacks.handleVideoCompleted(redis, B, C, S, 'b1');
            expect(result.ok).to.equal(false);
            expect(result.reason).to.equal('invalid_asset_state');
            expect(result.retryable).to.equal(false);
        });
    });

    describe('CASE D: completed video (READY) is not re-dispatched', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('shouldScheduleAssets excludes video once it is READY', async () => {
            await setState(redis, 'audio', state.AssetState.READY);
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.READY);

            const { stages, allDone } = await runtimeScheduler.shouldScheduleAssets(
                redis, B, C, S
            );
            expect(allDone).to.equal(true);
            expect(stages).to.not.include('video');
        });

        it('partially ready scene schedules only the missing stage', async () => {
            await setState(redis, 'audio', state.AssetState.READY);
            await setState(redis, 'image', state.AssetState.READY);
            await setState(redis, 'video', state.AssetState.PENDING);
            await giveCommand(redis, ['video'], B, C, S);

            const { stages } = await runtimeScheduler.shouldScheduleAssets(
                redis, B, C, S
            );
            expect(stages).to.deep.equal(['video']);
        });
    });

    describe('CASE E: stale callback cannot damage the new dispatch', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('completeStage with old dispatch_id is rejected; new metadata intact', async () => {
            const newId = await createActiveDispatch(redis, 'video', 'dispatch-NEW');
            await setState(redis, 'video', state.AssetState.GENERATING);

            const result = await orchestrator.completeStage(
                redis, B, C, S, 'video', 'b1', 'dispatch-OLD'
            );

            expect(result.completed).to.equal(false);
            expect(result.reason).to.equal('stale_dispatch');

            // New dispatch ownership unchanged
            const meta = await dispatchEngine.getDispatchMetadata(redis, B, C, S, 'video');
            expect(meta.dispatch_id).to.equal(newId);
            // Asset state untouched by the stale callback
            expect(await getState(redis, 'video')).to.equal(state.AssetState.GENERATING);

            // No completion was recorded for any dispatch
            const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
                .map(JSON.parse);
            expect(events.find(e => e.type === 'DISPATCH_COMPLETED')).to.not.exist;
        });
    });
});
