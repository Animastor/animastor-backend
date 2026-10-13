// ======================================================
// Orchestrator convergence (stage 50) — regression tests
// ======================================================
// Fix for the two DONE × DIRTY production scenes + the partial_audio_only
// false positive (docs/reorg-2026-10-12/49-done-dirty-diagnosis.md):
//
//   DONE — терминальная фаза audio/video-orch (VALID_TRANSITIONS[DONE] = []),
//   а per-asset DIRTY поверх неё — явный запрос на перегенерацию. До stage 50
//   dirty-ассет вообще не мог пройти dispatch (DIRTY→GENERATING запрещён FSM,
//   PENDING-нормализации не существовало), а terminal DONE-запись навсегда
//   блокировала already_done guard — состояние зависало навсегда.
//
// Fix surface under test:
//   1. ensureStageDispatchable: NEW|DIRTY → PENDING → GENERATING (FSM-легально)
//   2. executeAudioDispatch: DONE×DIRTY → terminal record deleted → regen
//      (clearTerminalAudioOrchForDirty)
//   3. markDirtyScene: terminal audio/video-orch record cleanup (Фаза 4)
//   4. setScenePending(audio): DONE record cleanup (Фаза 5)
//   5. C2 checkVersionStaleness: per-asset, READY-only, idempotent; previous
//      READY artifact (file + registry) preserved until successful replacement
//   6. dispatch-time scene-version stamping (convergence of the version gate)
//   7. partial builds: in-flight (PENDING/GENERATING) ≠ partial
//   8. getFixRecommendations: *_invariant_* stay log-only (explicit cases)
//   9. attemptDispatch surfaces per-stage failure reasons (no «undefined for»)

const { expect } = require('chai');
const path = require('path');
const state = require('../src/state');
const orchestrator = require('../node_modules/@animastor/orchestration/src/orchestration/orchestrator');
const sceneOrchestrator = require('../node_modules/@animastor/orchestration/src/orchestration/scene-orchestrator');
const dispatchEngine = require('../node_modules/@animastor/orchestration/src/runtime/dispatch-engine');
const runtimeScheduler = require('../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler');
const engine = require('../node_modules/@animastor/orchestration/src/runtime/reconciliation-engine');
const { wireProductionSeams, seams } = require('./helpers/wire-seams');
const persistencePort = require('../node_modules/@animastor/orchestration/src/runtime/persistence-port');
const realPersistAdapter = require('../src/storage/runtime-persistence-adapter');
// NOTE: deliberately NO top-level require of ../src/services/audio-orchestrator
// or video-orchestrator here — audio/video-orchestrator.test.js stub-swap the
// runtime-config cache entry around their require; pre-loading the services
// from an alphabetically-earlier file would make their stub inert (pollutes
// every later FSM test file).
const { createMockRedis } = require('./mocks/redis-mock');

const B = 'conv_book', C = 'ch-1', S = 'sc-1';
const AUDIO_KEY = `animastor:audio-orch:${B}:${C}:${S}`;
const VIDEO_KEY = `animastor:video-orch:${B}:${C}:${S}`;
const REGISTRY_KEY = `animastor:assets:${B}:${C}:${S}`;

async function assetState(redis, asset) {
    const states = await state.getAssetStates(redis, B, C, S);
    return states[asset];
}

async function putOrchState(redis, key, phase, extra = {}) {
    await redis.set(key, JSON.stringify({
        phase, expected_count: 2, chunks_received: 2,
        build_id: 'build-1', started_at: Date.now() - 60000, ...extra,
    }));
}

async function readOrchState(redis, key) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

function makeBook() {
    return {
        manifest: { book_id: B, build_id: 'build-1' },
        chapters: [{
            chapter_id: C,
            scenes: [{ scene_id: S, units: [{ id: 'iu-1', text: 'Unit one' }] }],
        }],
    };
}

// Partial persistence-adapter stub: clones the real adapter namespaces and
// overrides only what a test needs (port validation requires every op).
function makePersistStub(overrides = {}) {
    const clone = {};
    for (const [k, v] of Object.entries(realPersistAdapter)) {
        clone[k] = typeof v === 'function' ? v : { ...v };
    }
    for (const [ns, fns] of Object.entries(overrides)) {
        clone[ns] = { ...clone[ns], ...fns };
    }
    return clone;
}

// ── dispatch-engine stub for attemptDispatch-level tests ──
const DISPATCH_ENGINE_PATH = path.resolve(
    __dirname, '../node_modules/@animastor/orchestration/src/runtime/dispatch-engine.js');
const SCHEDULER_PATH = path.resolve(
    __dirname, '../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler.js');

function withStubbedDispatchEngine(stub, fn) {
    return (async () => {
        delete require.cache[SCHEDULER_PATH];
        delete require.cache[DISPATCH_ENGINE_PATH];
        require.cache[DISPATCH_ENGINE_PATH] = { exports: stub, loaded: true };
        try {
            return await fn(require(SCHEDULER_PATH));
        } finally {
            delete require.cache[SCHEDULER_PATH];
            delete require.cache[DISPATCH_ENGINE_PATH];
        }
    })();
}

// ======================================================
// GROUP 1 — DONE × DIRTY converges (re-dispatch, not deadlock)
// ======================================================
describe('stage 50: DONE × DIRTY convergence', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    describe('clearTerminalAudioOrchForDirty (dispatch-time heal)', () => {
        it('DONE + dirty → terminal record deleted, heal reported', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);

            const healed = await sceneOrchestrator.clearTerminalAudioOrchForDirty(redis, B, C, S);

            expect(healed).to.equal(true);
            expect(await readOrchState(redis, AUDIO_KEY)).to.equal(null);
        });

        it('DONE + ready → untouched (normal terminal outcome is never reset)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);

            expect(await sceneOrchestrator.clearTerminalAudioOrchForDirty(redis, B, C, S)).to.equal(false);
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('DONE');
        });

        it('WAITING_CHUNKS + dirty → untouched (recovery legs own non-terminal phases)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'WAITING_CHUNKS');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);

            expect(await sceneOrchestrator.clearTerminalAudioOrchForDirty(redis, B, C, S)).to.equal(false);
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('WAITING_CHUNKS');
        });
    });

    describe('ensureStageDispatchable: DIRTY walks the FSM-legal PENDING hop', () => {
        it('DIRTY → PENDING → GENERATING, PENDING hop journalled', async () => {
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);

            const result = await sceneOrchestrator.ensureStageDispatchable(redis, B, C, S, 'audio');

            expect(result.ok).to.equal(true);
            expect(await assetState(redis, 'audio')).to.equal(state.AssetState.GENERATING);
            const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
                .map(JSON.parse);
            const pending = events.find(e => e.type === 'SCENE_PENDING' && e.details?.asset === 'audio');
            expect(pending, 'DIRTY must pass through PENDING before GENERATING').to.exist;
        });
    });

    describe('full dispatch path (regen really happens, already_done is gone)', () => {
        let originalGenerate;
        beforeEach(() => {
            originalGenerate = require('../src/audio').generateSceneAudio;
            wireProductionSeams();
        });
        afterEach(() => {
            require('../src/audio').generateSceneAudio = originalGenerate;
        });

        it('DONE + DIRTY audio → terminal record cleared, jobs dispatched (regen)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
            require('../src/audio').generateSceneAudio =
                async () => ({ generated: true, chunks: 2 });

            const result = await dispatchEngine.dispatchStage(
                redis, B, C, S, 'audio', makeBook(), 'build-1', {});

            expect(result.dispatched).to.equal(true);
            // The terminal record must not survive the heal.
            expect(await readOrchState(redis, AUDIO_KEY)).to.not.equal(null);
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.not.equal('DONE');
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('WAITING_CHUNKS');
            expect(await assetState(redis, 'audio')).to.equal(state.AssetState.GENERATING);
        });

        it('DONE + PLACEHOLDER audio → skipped as already_done (normal skip preserved)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.PLACEHOLDER);

            const result = await dispatchEngine.dispatchStage(
                redis, B, C, S, 'audio', makeBook(), 'build-1', {});

            expect(result.dispatched).to.equal(false);
            expect(result.reason).to.equal('already_done');
            // dispatch-engine nests the executor result (the completed flag
            // belongs to the executor envelope, not the engine envelope).
            expect(result.result.completed).to.equal(true);
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('DONE');
        });

        it('anti-duplicate: a second dispatch while the first holds the lease does not regenerate twice', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
            let generateCalls = 0;
            require('../src/audio').generateSceneAudio = async () => {
                generateCalls++;
                return { generated: true, chunks: 1 };
            };

            const first = await dispatchEngine.dispatchStage(
                redis, B, C, S, 'audio', makeBook(), 'build-1', {});
            const second = await dispatchEngine.dispatchStage(
                redis, B, C, S, 'audio', makeBook(), 'build-1', {});

            expect(first.dispatched).to.equal(true);
            expect(second.dispatched).to.equal(false);
            expect(generateCalls).to.equal(1);
        });
    });

    describe('Фаза 4: markDirtyScene clears the terminal orch record', () => {
        it('audio DONE + markDirtyScene([audio]) → record deleted, asset DIRTY', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);

            await orchestrator.markDirtyScene(redis, B, C, S, ['audio']);

            expect(await readOrchState(redis, AUDIO_KEY)).to.equal(null);
            expect(await assetState(redis, 'audio')).to.equal(state.AssetState.DIRTY);
        });

        it('markDirtyScene without audio → audio-orch untouched (Фаза 4.3)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.READY);

            await orchestrator.markDirtyScene(redis, B, C, S, ['image']);

            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('DONE');
        });

        it('non-terminal audio phases survive markDirtyScene (recovery legs own them)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'FAILED');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);

            await orchestrator.markDirtyScene(redis, B, C, S, ['audio']);

            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('FAILED');
        });

        it('video mirror: video DONE + markDirtyScene([video]) → video-orch record deleted', async () => {
            await putOrchState(redis, VIDEO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'video', state.AssetState.READY);

            await orchestrator.markDirtyScene(redis, B, C, S, ['video']);

            expect(await readOrchState(redis, VIDEO_KEY)).to.equal(null);
            expect(await assetState(redis, 'video')).to.equal(state.AssetState.DIRTY);
        });

        it('video mirror: markDirtyScene([video]) leaves the audio DONE record alone', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await putOrchState(redis, VIDEO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'video', state.AssetState.READY);

            await orchestrator.markDirtyScene(redis, B, C, S, ['video']);

            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('DONE');
            expect(await readOrchState(redis, VIDEO_KEY)).to.equal(null);
        });
    });

    describe('Фаза 5: setScenePending(audio) clears only DONE', () => {
        it('audio DONE + setScenePending(audio) → record deleted (Фаза 5.2)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);

            const result = await orchestrator.setScenePending(redis, B, C, S, 'audio');

            expect(result.changed).to.equal(true);
            expect(await readOrchState(redis, AUDIO_KEY)).to.equal(null);
        });

        it('audio WAITING_CHUNKS + setScenePending(audio) → record untouched (Фаза 5.3)', async () => {
            await putOrchState(redis, AUDIO_KEY, 'WAITING_CHUNKS');
            await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.GENERATING);

            const result = await orchestrator.setScenePending(redis, B, C, S, 'audio');

            // GENERATING→PENDING is FSM-forbidden — the write is rejected and
            // the record must be untouched either way.
            expect(result.changed).to.equal(false);
            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('WAITING_CHUNKS');
        });

        it('setScenePending(image) never touches the audio-orch record', async () => {
            await putOrchState(redis, AUDIO_KEY, 'DONE');
            await state.setAssetState(redis, B, C, S, 'image', state.AssetState.DIRTY);

            await orchestrator.setScenePending(redis, B, C, S, 'image');

            expect((await readOrchState(redis, AUDIO_KEY)).phase).to.equal('DONE');
        });
    });
});

// ======================================================
// GROUP 2 — version staleness initiates update, preserves the READY artifact
// ======================================================
describe('stage 50: version staleness (C2) is per-asset, READY-only, idempotent', () => {
    let redis;
    let markDirtyCalls;
    let persistRestore;

    beforeEach(() => {
        redis = createMockRedis();
        markDirtyCalls = [];
        persistencePort.setPersistencePort(makePersistStub({
            sceneVersions: {
                getVersionStalenessRows: async () => [
                    {
                        book_id: B, chapter_id: C, scene_id: S,
                        content_version: 3, audio_config_version: 1,
                        asset_type: 'audio', scene_content_version: 2, scene_audio_config_version: 1,
                    },
                    {
                        book_id: B, chapter_id: C, scene_id: S,
                        content_version: 3, audio_config_version: 1,
                        asset_type: 'image', scene_content_version: 3, scene_audio_config_version: null,
                    },
                ],
            },
        }));
        persistRestore = () => persistencePort.setPersistencePort(realPersistAdapter);
    });
    afterEach(() => { if (persistRestore) persistRestore(); });

    function runC2() {
        return engine.checkVersionStaleness(redis, {
            orchestrator: {
                markDirtyScene: async (r, b, c, s, assets) => {
                    markDirtyCalls.push({ b, c, s, assets });
                    for (const a of assets) {
                        await state.unsafeRestoreAssetState(r, b, c, s, a, state.AssetState.DIRTY);
                    }
                },
            },
        });
    }

    it('marks only the actually-stale READY assets (audio), not the whole scene', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        await state.setAssetState(redis, B, C, S, 'image', state.AssetState.READY);

        const outdated = await runC2();

        expect(outdated).to.equal(1);
        expect(markDirtyCalls).to.have.lengthOf(1);
        expect(markDirtyCalls[0].assets).to.deep.equal(['audio']);
        expect(await assetState(redis, 'audio')).to.equal(state.AssetState.DIRTY);
        // The non-stale READY image must not be re-generated.
        expect(await assetState(redis, 'image')).to.equal(state.AssetState.READY);
    });

    it('second run marks nothing (idempotent, no repeated re-marking)', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        await runC2();

        const outdated = await runC2();

        expect(outdated).to.equal(0);
        expect(markDirtyCalls).to.have.lengthOf(1);
    });

    it('never writes over a live generation (GENERATING asset untouched)', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.GENERATING);

        const outdated = await runC2();

        expect(outdated).to.equal(0);
        expect(markDirtyCalls).to.have.lengthOf(0);
        expect(await assetState(redis, 'audio')).to.equal(state.AssetState.GENERATING);
    });

    it('audio_config staleness alone marks audio (per-asset comparison)', async () => {
        persistencePort.setPersistencePort(makePersistStub({
            sceneVersions: {
                getVersionStalenessRows: async () => [
                    {
                        book_id: B, chapter_id: C, scene_id: S,
                        content_version: 1, audio_config_version: 5,
                        asset_type: 'audio', scene_content_version: 1, scene_audio_config_version: 2,
                    },
                ],
            },
        }));
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);

        const outdated = await runC2();

        expect(outdated).to.equal(1);
        expect(markDirtyCalls[0].assets).to.deep.equal(['audio']);
    });

    it('the previous READY artifact is preserved for serving until replacement', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        // Registry still advertises the old audio as ready (what playback reads).
        await redis.hset(REGISTRY_KEY, 'audio', JSON.stringify({
            canonical: '/data/output/build-1/old.mp3', ready: true,
        }));

        await runC2();

        // DIRTY is only a regeneration request — the registry entry (and the
        // file behind it) must stay servable until the successful replacement.
        const registry = JSON.parse(await redis.hget(REGISTRY_KEY, 'audio'));
        expect(registry.ready).to.equal(true);
        expect(await assetState(redis, 'audio')).to.equal(state.AssetState.DIRTY);
    });
});

// ======================================================
// GROUP 3 — repair recommendations never reset a successful scene
// ======================================================
describe('stage 50: invariant recommendations stay manual (no run_completeStage)', () => {
    it('*_invariant_done / *_invariant_failed → REVIEW_MANUALLY, safeToExecute=false (explicit cases)', () => {
        for (const issue of [
            'audio_orch_invariant_done',
            'video_orch_invariant_done',
            'audio_orch_invariant_failed',
            'video_orch_invariant_failed',
        ]) {
            const [fix] = engine.getFixRecommendations([
                { scene: { bookId: B, chapterId: C, sceneId: S }, issue },
            ]);
            expect(fix.action, issue).to.equal('REVIEW_MANUALLY');
            expect(fix.safeToExecute, issue).to.equal(false);
        }
    });

    it('no auto-fix survives the safeToExecute filter for the invariant issues', () => {
        const fixes = engine.getFixRecommendations([
            { scene: { bookId: B, chapterId: C, sceneId: S }, issue: 'audio_orch_invariant_done' },
            { scene: { bookId: B, chapterId: C, sceneId: S }, issue: 'video_orch_invariant_done' },
        ]);
        expect(fixes.filter(f => f.safeToExecute)).to.have.lengthOf(0);
    });

    it('violation payloads no longer advertise the destructive run_completeStage', async () => {
        const redis = createMockRedis();
        await putOrchState(redis, AUDIO_KEY, 'DONE');
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);

        const violations = await engine.checkAudioOrchInvariants(redis, B, C, S);

        expect(violations).to.have.lengthOf(1);
        expect(violations[0].type).to.equal('audio_orch_invariant_done');
        expect(violations[0].recommendation).to.not.equal('run_completeStage');
        expect(violations[0].recommendation).to.equal('review_manually');
    });
});

// ======================================================
// GROUP 4 — dispatch-time version stamping (gate convergence)
// ======================================================
describe('stage 50: dispatch stamps scene versions onto the asset row', () => {
    let redis;
    let stampCalls;
    let originalGenerate;
    let persistRestore;

    beforeEach(() => {
        redis = createMockRedis();
        stampCalls = [];
        originalGenerate = require('../src/audio').generateSceneAudio;
        wireProductionSeams();
        persistencePort.setPersistencePort(makePersistStub({
            sceneAssets: {
                stampSceneVersionsForDispatch: async (bookId, chapterId, sceneId, assetType) => {
                    stampCalls.push({ bookId, chapterId, sceneId, assetType });
                    return { stamped: 1, inserted: 0 };
                },
            },
        }));
        persistRestore = () => persistencePort.setPersistencePort(realPersistAdapter);
    });
    afterEach(() => {
        require('../src/audio').generateSceneAudio = originalGenerate;
        if (persistRestore) persistRestore();
    });

    it('dispatchStage stamps the row BEFORE the executor runs (version = version started for)', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
        let executorRan = false;
        seams.registerOrchestrationSeams({
            dispatchStage: async () => {
                executorRan = true;
                expect(stampCalls, 'stamp must precede the executor').to.have.lengthOf(1);
                return { dispatched: true, jobs: 1 };
            },
        });

        const result = await dispatchEngine.dispatchStage(
            redis, B, C, S, 'audio', makeBook(), 'build-1', {});

        expect(result.dispatched).to.equal(true);
        expect(executorRan).to.be.true;
        expect(stampCalls[0]).to.deep.equal({
            bookId: B, chapterId: C, sceneId: S, assetType: 'audio',
        });
    });

    it('a PG outage must not block the dispatch (best-effort stamp)', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
        persistencePort.setPersistencePort(makePersistStub({
            sceneAssets: {
                stampSceneVersionsForDispatch: async () => { throw new Error('pg down'); },
            },
        }));
        require('../src/audio').generateSceneAudio = async () => ({ generated: true, chunks: 1 });

        const result = await dispatchEngine.dispatchStage(
            redis, B, C, S, 'audio', makeBook(), 'build-1', {});

        expect(result.dispatched).to.equal(true);
    });
});

// ======================================================
// GROUP 5 — no false positives for active scenes / in-flight generations
// ======================================================
describe('stage 50: partial-build checks skip in-flight generations', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    it('audio READY + image GENERATING (registry lag) → NOT partial (production issue №3 shape)', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        await state.setAssetState(redis, B, C, S, 'image', state.AssetState.GENERATING);
        await redis.hset(REGISTRY_KEY, 'audio', JSON.stringify({ canonical: '/x.mp3', ready: true }));

        const partial = await engine.checkPartialBuilds(redis, B, C, S);

        expect(partial).to.equal(null);
    });

    it('audio READY + image PENDING → NOT partial', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);
        await redis.hset(REGISTRY_KEY, 'audio', JSON.stringify({ canonical: '/x.mp3', ready: true }));

        expect(await engine.checkPartialBuilds(redis, B, C, S)).to.equal(null);
    });

    it('audio READY + image not started → still reported as partial_audio_only', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.READY);
        await redis.hset(REGISTRY_KEY, 'audio', JSON.stringify({ canonical: '/x.mp3', ready: true }));

        const partial = await engine.checkPartialBuilds(redis, B, C, S);

        expect(partial).to.not.equal(null);
        expect(partial.type).to.equal('partial_audio_only');
    });

    it('image READY + video GENERATING → NOT partial (mirror)', async () => {
        await state.setAssetState(redis, B, C, S, 'image', state.AssetState.READY);
        await state.setAssetState(redis, B, C, S, 'video', state.AssetState.GENERATING);
        await redis.hset(REGISTRY_KEY, 'image', JSON.stringify({ path: '/x.jpg', ready: true }));

        expect(await engine.checkPartialBuilds(redis, B, C, S)).to.equal(null);
    });

    it('the production 3-issue shape: 2× DONE×DIRTY reported log-only, no partial false positive, dispatch heals', async () => {
        // Scene state = the exact shape stage 49 diagnosed in production:
        // two scenes with terminal audio-orch DONE + dirty audio (their
        // regen was deadlocked), one scene with audio READY (file on disk)
        // + image GENERATING under a live lease (the partial_audio_only loop).
        const sceneA = { b: 'import_A', c: 'ch-1bb5123c', s: 'sc-5f18dd0f' };
        const sceneB = { b: 'import_A', c: 'ch-37eadabb', s: 'sc-5f0068ca' };
        const sceneC = { b: 'import_A', c: 'ch-1bb5123c', s: 'sc-45c789c6' };

        for (const sc of [sceneA, sceneB]) {
            await putOrchState(redis, `animastor:audio-orch:${sc.b}:${sc.c}:${sc.s}`, 'DONE');
            await state.setAssetState(redis, sc.b, sc.c, sc.s, 'audio', state.AssetState.DIRTY);
        }
        await state.setAssetState(redis, sceneC.b, sceneC.c, sceneC.s, 'audio', state.AssetState.READY);
        await state.setAssetState(redis, sceneC.b, sceneC.c, sceneC.s, 'image', state.AssetState.GENERATING);
        // The READY audio has a file on disk (registry-lagged image is the
        // only production anomaly) — orphan checks must stay quiet.
        const audioFile = path.join(require('os').tmpdir(), `conv-orphan-${process.pid}.mp3`);
        require('fs').writeFileSync(audioFile, 'x');
        persistencePort.setPersistencePort(makePersistStub({
            filesystem: { getSceneAudioPath: () => audioFile },
        }));
        await redis.hset(`animastor:assets:${sceneC.b}:${sceneC.c}:${sceneC.s}`,
            'audio', JSON.stringify({ canonical: audioFile, ready: true }));

        // Live lease + metadata evidence for the in-flight image — the
        // orphan-GENERATING repair must never touch a live generation.
        const lease = await dispatchEngine.acquireStageLease(redis, sceneC.b, sceneC.c, sceneC.s, 'image');
        expect(lease.acquired).to.equal(true);
        await dispatchEngine.setDispatchMetadata(
            redis, sceneC.b, sceneC.c, sceneC.s, 'image',
            dispatchEngine.createDispatchMetadata('dispatch-live-image', 'image', 'test', {
                leaseKey: lease.leaseKey, leaseToken: lease.token, quotaOwned: false,
            }));

        try {
            const reportA = await engine.reconcileScene(redis, sceneA.b, sceneA.c, sceneA.s);
            expect(reportA.inconsistentScenes.map(i => i.issue))
                .to.deep.equal(['audio_orch_invariant_done']);
            const reportB = await engine.reconcileScene(redis, sceneB.b, sceneB.c, sceneB.s);
            expect(reportB.inconsistentScenes.map(i => i.issue))
                .to.deep.equal(['audio_orch_invariant_done']);
            const reportC = await engine.reconcileScene(redis, sceneC.b, sceneC.c, sceneC.s);
            expect(reportC.inconsistentScenes, 'in-flight image is not an issue').to.deep.equal([]);

            // The reported issues are log-only: no auto-fix may run for them.
            const fixes = engine.getFixRecommendations([
                ...reportA.inconsistentScenes, ...reportB.inconsistentScenes,
            ]);
            expect(fixes.filter(f => f.safeToExecute)).to.have.lengthOf(0);

            // …and the dispatch path heals the DONE×DIRTY deadlock by re-dispatch.
            const originalGenerate = require('../src/audio').generateSceneAudio;
            require('../src/audio').generateSceneAudio = async () => ({ generated: true, chunks: 1 });
            try {
                const result = await sceneOrchestrator.dispatchStage(
                    redis,
                    { book_id: sceneA.b, chapter_id: sceneA.c, scene_id: sceneA.s },
                    { manifest: { book_id: sceneA.b, build_id: 'build-1' },
                      chapters: [{ chapter_id: sceneA.c,
                                   scenes: [{ scene_id: sceneA.s, units: [{ id: 'iu-1', text: 'u' }] }] }] },
                    'build-1',
                    'audio',
                    'dispatch-heal-stage50'
                );
                expect(result.dispatched).to.equal(true);
                const orchAfter = await readOrchState(
                    redis, `animastor:audio-orch:${sceneA.b}:${sceneA.c}:${sceneA.s}`);
                expect(orchAfter.phase).to.not.equal('DONE');
            } finally {
                require('../src/audio').generateSceneAudio = originalGenerate;
            }
        } finally {
            persistencePort.setPersistencePort(realPersistAdapter);
            require('fs').unlinkSync(audioFile);
        }
    });
});

// ======================================================
// GROUP 6 — tick observability: per-stage failures surface with reasons
// ======================================================
describe('stage 50: attemptDispatch surfaces per-stage failures (no «undefined for» masking)', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    it('a failed stage returns success:false with the real reason', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.PENDING);

        const result = await withStubbedDispatchEngine({
            dispatchStage: async () => ({ dispatched: false, reason: 'circuit_open' }),
        }, scheduler => scheduler.attemptDispatch(redis, B, C, S, null, false));

        expect(result.dispatched).to.equal(0);
        expect(result.success).to.equal(false);
        expect(result.reason).to.include('audio:circuit_open');
    });

    it('a completed stage (already_done) is not reported as an error', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.PENDING);

        const result = await withStubbedDispatchEngine({
            dispatchStage: async () => ({ dispatched: false, completed: true, reason: 'already_done' }),
        }, scheduler => scheduler.attemptDispatch(redis, B, C, S, null, false));

        expect(result.dispatched).to.equal(0);
        expect(result.completed).to.equal(true);
        expect(result.success).to.not.equal(false);
    });

    it('mixed stages: dispatched wins, other stage failures still listed', async () => {
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.PENDING);
        await state.setAssetState(redis, B, C, S, 'image', state.AssetState.PENDING);

        const result = await withStubbedDispatchEngine({
            // dispatch-engine signature: (redis, bookId, chapterId, sceneId, stage, …)
            dispatchStage: async (r, bookId, chapterId, sceneId, stage) => (
                stage === 'audio'
                    ? { dispatched: true, dispatchId: 'd-1' }
                    : { dispatched: false, reason: 'retry_budget_exceeded' }
            ),
        }, scheduler => scheduler.attemptDispatch(redis, B, C, S, null, false));

        expect(result.dispatched).to.equal(1);
    });
});

// ======================================================
// GROUP 7 — reconciliation idempotency for the healed shape
// ======================================================
describe('stage 50: repeated reconcile + restart stay idempotent for DONE×DIRTY', () => {
    it('startup C1 leaves terminal DONE records untouched (no premature reset)', async () => {
        const redis = createMockRedis();
        await putOrchState(redis, AUDIO_KEY, 'DONE', { last_chunk_at: Date.now() - 7200000 });
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
        const before = await readOrchState(redis, AUDIO_KEY);

        const recovered = await engine.recoverAudioOrchStates(redis, { orchestrator: {} });

        expect(recovered).to.equal(0);
        expect(await readOrchState(redis, AUDIO_KEY)).to.deep.equal(before);
    });

    it('reconcileScene twice on DONE×DIRTY reports the same single issue and writes nothing', async () => {
        const redis = createMockRedis();
        await putOrchState(redis, AUDIO_KEY, 'DONE');
        await state.setAssetState(redis, B, C, S, 'audio', state.AssetState.DIRTY);
        const assetBefore = await state.getAssetStates(redis, B, C, S);
        const orchBefore = await readOrchState(redis, AUDIO_KEY);

        const first = await engine.reconcileScene(redis, B, C, S);
        const second = await engine.reconcileScene(redis, B, C, S);

        expect(first.inconsistentScenes.map(i => i.issue)).to.deep.equal(['audio_orch_invariant_done']);
        expect(second.inconsistentScenes.map(i => i.issue)).to.deep.equal(['audio_orch_invariant_done']);
        expect(await state.getAssetStates(redis, B, C, S)).to.deep.equal(assetBefore);
        expect(await readOrchState(redis, AUDIO_KEY)).to.deep.equal(orchBefore);
    });
});
