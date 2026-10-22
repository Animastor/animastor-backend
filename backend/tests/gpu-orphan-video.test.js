// ======================================================
// Stage 122 — video orphaned completion marker (audit 121 · N2)
//
// Proven defect (audit 121 · N2): the orphan-marker release (Stage 120 · M-c)
// existed only in the IMAGE path. The video send loop
// (`scene-orchestrator.executeVideoDispatch`) had none: an orphaned
// `animastor:idempotency:done:*` marker (the group file was wiped without
// releasing it) suppressed the job as `already_completed` forever — the
// dispatch engine deferred 900 s, retried, got the same verdict, and the
// scene stayed in the active index.
//
// Fix under test (Stage 122 · N2): the video send loop now frees the orphan
// through the PersistencePort op `idem.releaseTaskDoneIfOrphan` (the
// orchestration tier cannot require the backend helper directly) and retries
// the job ONCE. An `already_completed` verdict on the SEND path is by
// construction an orphan: a cached group never reaches this loop.
//
// This drives the REAL `dispatchStage` → `executeVideoDispatch` (orchestration
// package). ISOLATION CONTRACT: the mocha bootstrap
// (tests/generation-test-bindings.cjs) wires the production host-bindings and
// ports GLOBALLY for every suite — this harness must NOT touch that global
// state. It therefore stubs the host-bindings seam and the persistence port
// THROUGH proxyquire (module-local fakes) and restores the production
// video-fsm adapter in afterEach (that port is lazily required inside
// executeVideoDispatch, so proxyquire cannot intercept it). The orphan
// release itself runs the REAL queue-idempotency helper against an in-memory
// Redis. No hub, no PG, no network, no global mutation.
// ======================================================

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const path = require('path');

const ORCH = path.join(__dirname, '../node_modules/@animastor/orchestration/src');
const qidem = require('../src/helpers/queue-idempotency.cjs');
const videoFsmPort = require(path.join(ORCH, 'runtime/video-fsm-port'));
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK = 'n2video_book';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build_n2video';
const JOB_ID = 'n2video_book_ch-1_sc-1_g0:video';
const scene = { book_id: BOOK, chapter_id: CHAPTER, scene_id: SCENE };
const loadedBook = { manifest: { book_id: BOOK, build_id: BUILD }, chapters: [] };
const sceneDataObj = { chapter_id: CHAPTER, scene_id: SCENE };

// The video FSM port double: one group, never cached on disk.
const videoFsmStub = {
    PHASES: { NEW: 'new', GENERATING: 'generating', WAITING_CHUNKS: 'waiting_chunks', MERGING: 'merging', DONE: 'done', FAILED: 'failed' },
    getState: async () => null,
    initState: async () => {},
    setWaitingChunks: async () => {},
    setDone: async () => {},
    setFailed: async () => {},
    deleteState: async () => {},
    markGroupDone: async () => {},
    groupSuffixes: () => [''],
    groupFilePath: () => '/tmp/opencode/never-written.mp4',
    isGroupFileValid: () => false,
    completeGroup: async () => ({ completed: false }),
    failWaitingScene: async () => {},
    scanAllStates: async () => [],
};

// Module-LOCAL host-bindings fake — the global seam (wired by the mocha
// bootstrap for every suite) is never touched.
function makeLocalHostBindings(wired) {
    const map = new Map(Object.entries(wired));
    const hostBinding = (name) => {
        const v = map.get(name);
        if (typeof v !== 'function') throw new Error(`host-bindings(fake): '${name}' is not wired`);
        return v();
    };
    return {
        bindHostModules: (impls = {}) => { for (const [k, v] of Object.entries(impls)) map.set(k, v); },
        clearHostBindings: () => map.clear(),
        hostBinding,
        hostCall: hostBinding,
        isHostBindingWired: (name) => map.has(name),
        lazyHostBinding(name) {
            const [root, ...rest] = name.split('.');
            return new Proxy({}, {
                get(_, prop) {
                    let target = hostBinding(root);
                    for (const key of rest) target = target[key];
                    return target[prop];
                },
            });
        },
        requiredHostBindings: () => [...map.keys()],
    };
}

// Module-LOCAL persistence-port fake — only the two ops the video dispatch
// path uses; the orphan release delegates to the REAL backend helper.
function makeLocalPersistPort() {
    return {
        OPS: ['idem.releaseTaskDoneIfOrphan', 'sceneAssets.getDirtyUnitIds'],
        setPersistencePort: () => {},
        persistence: () => ({ idem: {}, sceneAssets: {} }),
        persist: (op) => {
            if (op === 'idem.releaseTaskDoneIfOrphan') {
                return (redis, sendResult) => qidem.releaseTaskDoneIfOrphan(redis, sendResult);
            }
            if (op === 'sceneAssets.getDirtyUnitIds') return async () => [];
            throw new Error(`persistence-port(fake): op '${op}' is not wired`);
        },
        isPersistencePortWired: () => true,
        _resetPersistencePort: () => {},
    };
}

/** The real scene-orchestrator with the provider/video-generation seams scripted. */
function loadOrchestrator(generateScript) {
    const providerStub = {
        listWorkflows: () => ['video-workflow'],
        generate: async () => generateScript.next(),
    };
    const mediaStub = {
        video: {
            generateVideoAnimation: async () => ({
                success: true,
                jobSpecs: [{ job_id: JOB_ID, unit_ids: ['u1'] }],
            }),
        },
        audio: {},
        image: {},
    };
    const stateStub = {
        AssetState: { NEW: 'new', DIRTY: 'dirty', GENERATING: 'generating', READY: 'ready' },
        getAssetStates: async () => ({ audio: 'ready', image: 'ready', video: 'generating' }),
    };

    return proxyquire(path.join(ORCH, 'orchestration/scene-orchestrator'), {
        // Isolated fakes — the GLOBAL host-bindings/persistence wiring that the
        // mocha bootstrap installs for every suite stays untouched.
        '../host/host-bindings': makeLocalHostBindings({
            state: () => stateStub,
            media: () => mediaStub,
            journal: () => ({ appendSceneEvent: async () => {} }),
        }),
        '../runtime/persistence-port': makeLocalPersistPort(),
        '@animastor/generation': {
            comfyuiProvider: providerStub,
            mediaRegistry: { hasMediaType: () => true },
        },
        '../runtime/runtime-scheduler': {
            removeSceneFromActiveIndex: async () => {},
            addSceneToActiveIndex: async () => {},
        },
        '../runtime/scene-data-port': {
            sceneDataOp: (op) => (op === 'findSceneRuntimeData' ? () => sceneDataObj : () => null),
        },
        '../runtime/audio-fsm-port': {
            audioFsmOp: () => () => async () => null,
            audioFsmPhases: () => ({ DONE: 'done' }),
        },
        '../runtime/layer-config-port': {
            layerConfigOp: () => () => async () => null,
        },
        './scene-utils': { log: () => {}, warn: () => {}, error: () => {}, logEvent: async () => {} },
        './scene-callbacks': { handleAudioCompleted: () => {}, handleImageCompleted: () => {}, handleVideoCompleted: () => {} },
        './scene-restoration': { restoreSceneChunkStatus: async () => {} },
        './orchestrator': {
            completeStage: async () => ({}),
            failStage: async () => ({}),
            setScenePending: async () => ({ changed: true }),
            setSceneGenerating: async () => ({ changed: true }),
            rollbackStageToPending: async () => ({ changed: true }),
        },
    });
}

/** A scripted provider.generate: yields results in order, then repeats last. */
function script(...results) {
    let i = 0;
    return { next: () => results[Math.min(i++, results.length - 1)], get calls() { return i; } };
}

describe('Stage 122: video orphaned completion marker (audit 121 · N2)', function () {
    this.timeout(15000);
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
        // The video-fsm port is lazily required INSIDE executeVideoDispatch —
        // proxyquire cannot intercept it, so the GLOBAL port carries the stub
        // for the duration of each test. afterEach restores the exact
        // production adapter the mocha bootstrap wired.
        videoFsmPort.setVideoFsmPort(videoFsmStub);
    });

    afterEach(() => {
        // Restore the production video-fsm adapter (what
        // tests/generation-test-bindings.cjs wired at bootstrap).
        videoFsmPort.setVideoFsmPort(require('../src/storage/video-fsm-adapter'));
    });

    function orphanIdemKey() {
        return qidem.computeIdemKey({ workspaceId: null, jobId: JOB_ID, jobType: 'video', buildId: BUILD, params: {}, generationEpoch: 1 });
    }

    it('frees the orphaned marker and regenerates the video job ONCE', async () => {
        const idemKey = orphanIdemKey();
        await redis.set(qidem.idemDoneKey(idemKey), '1');
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(true);

        // #1 already_completed (orphan) → release via port + retry → #2 sent.
        const s = script(
            { sent: false, reason: 'already_completed', idem_key: idemKey },
            { sent: true },
        );
        const orchestrator = loadOrchestrator(s);

        const result = await orchestrator.dispatchStage(redis, scene, loadedBook, BUILD, 'video', 'dispatch-v1');

        expect(result.dispatched).to.equal(true);
        expect(result.jobs).to.equal(1);
        expect(s.calls).to.equal(2); // exactly ONE retry — never a loop
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(false); // orphan gone
    });

    it('does NOT retry on a non-orphan verdict (duplicate_pending stays bounded)', async () => {
        const idemKey = orphanIdemKey();
        // A parallel dispatch already claimed the task → duplicate_pending, NOT
        // already_completed. The fix must not release and must NOT retry.
        const s = script({ sent: false, reason: 'duplicate_pending', idem_key: idemKey });
        const orchestrator = loadOrchestrator(s);

        const result = await orchestrator.dispatchStage(redis, scene, loadedBook, BUILD, 'video', 'dispatch-v2');

        expect(result.dispatched).to.equal(false);
        expect(result.reason).to.equal('duplicate_pending');
        expect(result.retryable).to.equal(true);
        expect(s.calls).to.equal(1); // ONE attempt, no retry loop
    });

    it('an orphan with NO idem_key is not retried (defensive)', async () => {
        const s = script({ sent: false, reason: 'already_completed' }); // no idem_key
        const orchestrator = loadOrchestrator(s);

        const result = await orchestrator.dispatchStage(redis, scene, loadedBook, BUILD, 'video', 'dispatch-v3');

        expect(result.dispatched).to.equal(false);
        expect(s.calls).to.equal(1); // no retry without an addressable marker
    });
});
