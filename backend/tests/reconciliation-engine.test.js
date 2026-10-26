// ======================================================
// Reconciliation Engine Tests
// ======================================================

const { expect } = require('chai');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');

const RECONCILE_PATH = path.resolve(__dirname, '../node_modules/@animastor/orchestration/src/runtime/reconciliation-engine');

// ======================================================
// HELPERS
// ======================================================

const BOOK_ID = 'test-book';
const CHAPTER_ID = 'ch-1';
const SCENE_ID = 's-1';

function sceneRef() {
    return { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID };
}

function setAssetState(redis, bookId, chapterId, sceneId, asset, value) {
    const key = `animastor:asset-state:${bookId}:${chapterId}:${sceneId}`;
    return redis.hset(key, asset, value);
}

function setAllAssets(redis, bookId, chapterId, sceneId, states) {
    const key = `animastor:asset-state:${bookId}:${chapterId}:${sceneId}`;
    for (const [asset, state] of Object.entries(states)) {
        redis.hset(key, asset, state);
    }
}

// ======================================================
// Mock module dependencies (ALL mocks set before load)
// ======================================================

const CWD = path.resolve(__dirname, '..');
const STATE_PATH = path.join(CWD, 'src/state/index.js');
const STORAGE_PATH = path.join(CWD, 'src/storage/index.js');
const IMAGE_PATH = path.join(CWD, 'src/image/index.js');
const AUDIO_ORCH_PATH = path.join(CWD, 'src/services/audio-orchestrator.js');
// Captured at file load (before any mockDeps() replaces the module in
// require.cache) so the stage-46 recovery tests can drive C1 through the REAL
// audio FSM (VALID_TRANSITIONS map) instead of a setFailed stub.
const realAudioOrch = require('../src/services/audio-orchestrator');
const ORCH_PATH = path.join(CWD, 'node_modules/@animastor/orchestration/src/orchestration/orchestrator.js');
const JOURNAL_PATH = path.join(CWD, 'src/state/event-journal.js');

function mockDeps(redis, overrides = {}) {
    // Clear ALL our mock paths so each call starts fresh.
    // IMPORTANT: only paths that WE own (mock entries), not real modules.
    // If real modules have already been loaded by OTHER test files, we
    // must NOT delete them here — that would corrupt the cache for the
    // next test file in the suite run.
    delete require.cache[RECONCILE_PATH];
    delete require.cache[STATE_PATH];
    delete require.cache[STORAGE_PATH];
    delete require.cache[IMAGE_PATH];
    delete require.cache[AUDIO_ORCH_PATH];
    delete require.cache[ORCH_PATH];
    delete require.cache[JOURNAL_PATH];

    // Mock state module
    const stateMock = {
        AssetState: {
            NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
            GENERATING: 'generating', READY: 'ready',
            FAILED: 'failed', PLACEHOLDER: 'placeholder',
        },
        getAssetStates: async (r, bookId, chapterId, sceneId) => {
            const key = `animastor:asset-state:${bookId}:${chapterId}:${sceneId}`;
            const raw = await r.hgetall(key);
            if (!raw) return { audio: 'new', image: 'new', video: 'new' };
            return {
                audio: raw.audio || 'new',
                image: raw.image || 'new',
                video: raw.video || 'new',
            };
        },
        ...overrides.state,
    };
    require.cache[STATE_PATH] = { exports: stateMock, loaded: true };

    // Mock storage module
    const storageMock = {
        filesystem: {
            getSceneAudioPath: (outputDir, buildId, bookId, chapterId, sceneId) =>
                `/data/output/${buildId}/${bookId}_${chapterId}_${sceneId}.mp3`,
        },
        manifest: { recordAsset: () => {} },
        ...overrides.storage,
    };
    storageMock.registry = overrides.getSceneAssetsRedis
        ? { getSceneAssetsRedis: overrides.getSceneAssetsRedis }
        : { getSceneAssetsRedis: async () => null };
    require.cache[STORAGE_PATH] = { exports: storageMock, loaded: true };

    // Mock image module
    const imageMock = {
        resolveCanonicalSceneImage: overrides.resolveCanonicalSceneImage ||
            (() => `/data/output/default/${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}.png`),
        // Stage 143a (phase 2a · B2): the versioned-pointer proof. Default =
        // "no publication" which is what the REAL facade answers with
        // IU_IMAGE_VERSIONED off (zero PG calls), so every pre-existing test
        // keeps its legacy semantics.
        resolveVersionedSceneProof: overrides.resolveVersionedSceneProof || (() => null),
    };
    require.cache[IMAGE_PATH] = { exports: imageMock, loaded: true };

    // Mock audio-orchestrator
    const audioOrchMock = {
        PHASES: {
            NEW: 'NEW', GENERATING: 'GENERATING', WAITING_CHUNKS: 'WAITING_CHUNKS',
            MERGING: 'MERGING', DONE: 'DONE', FAILED: 'FAILED', PLACEHOLDER_READY: 'PLACEHOLDER_READY',
        },
        getState: overrides.getAudioOrchState || (async () => null),
        scanAllStates: overrides.scanAllStates || (async (r) => {
            const keys = [];
            let cursor = '0';
            do {
                const [nextCursor, batch] = await r.scan(cursor, 'MATCH', 'animastor:audio-orch:*', 'COUNT', 200);
                cursor = nextCursor;
                keys.push(...batch);
            } while (cursor !== '0');
            const results = [];
            for (const k of keys) {
                const raw = await r.get(k);
                if (raw) {
                    const parts = k.split(':');
                    if (parts.length >= 5) {
                        const sceneParts = parts.slice(2);
                        if (sceneParts.length >= 3) {
                            const sceneId = sceneParts.pop();
                            const chapterId = sceneParts.pop();
                            const bookId = sceneParts.join(':');
                            results.push({ key: k, bookId, chapterId, sceneId, state: JSON.parse(raw) });
                        }
                    }
                }
            }
            return results;
        }),
        failWaitingScene: overrides.failWaitingScene || (async () => ({ failed: false, reason: 'not_waiting_chunks' })),
        // S4.1 (2026-07-19): stub'ы для функций, которые scene-window.startScene
        // и scene-orchestrator.executeAudioDispatch зовут через lazy require.
        // Без этих stub'ов warning «audioOrch.X is not a function» загрязняет логи.
        initPlaceholderReady: overrides.initPlaceholderReady || (async () => ({ phase: 'PLACEHOLDER_READY' })),
        setGenerating: overrides.setGenerating || (async () => ({ phase: 'GENERATING' })),
        setWaitingChunks: overrides.setWaitingChunks || (async () => ({ phase: 'WAITING_CHUNKS' })),
        setMerging: overrides.setMerging || (async () => ({ phase: 'MERGING' })),
        setDone: overrides.setDone || (async () => ({ phase: 'DONE' })),
        setFailed: overrides.setFailed || (async () => ({ phase: 'FAILED' })),
        completeChunk: overrides.completeChunk || (async () => ({ phase: 'WAITING_CHUNKS' })),
        completeMerge: overrides.completeMerge || (async () => ({ phase: 'DONE' })),
        deleteState: overrides.deleteState || (async () => ({ deleted: true })),
    };
    require.cache[AUDIO_ORCH_PATH] = { exports: audioOrchMock, loaded: true };

    // Mock orchestrator
    const orchMock = {
        markDirtyScene: overrides.markDirtyScene || (async () => {}),
        setScenePending: overrides.setScenePending || (async () => {}),
        failStage: overrides.failStage || (async () => {}),
    };
    require.cache[ORCH_PATH] = { exports: orchMock, loaded: true };

    // S-5: reconciliation-engine resolves orchestration behavior (FSM writers,
    // rollback) through the seam registry, not the ORCH_PATH deep-require —
    // wire the same mocks into the seams. The seams module is a process-level
    // singleton (already-loaded runtime modules hold closures over it): NEVER
    // purge it from require.cache, only re-register over it.
    const seamsPath = path.join(CWD, 'src/runtime/orchestration-seams.js');
    require(seamsPath).registerOrchestrationSeams({
        dispatchStage: async () => ({ dispatched: false, reason: 'test_no_dispatch' }),
        rollbackStageToPending: overrides.rollbackStageToPending
            || (async (r, bookId, chapterId, sceneId, stage) => ({ changed: false, reason: `test_unwired_rollback:${stage}` })),
        markDirtyScene: orchMock.markDirtyScene,
        setScenePending: orchMock.setScenePending,
        setSceneAllReady: async () => {},
        setScenePlaceholder: async () => {},
    });

    // Mock event-journal
    const journalMock = {
        EventType: { RECOVERY_STARTED: 'RECOVERY_STARTED', RECOVERY_COMPLETED: 'RECOVERY_COMPLETED' },
        appendSceneEvent: async () => {},
    };
    require.cache[JOURNAL_PATH] = { exports: journalMock, loaded: true };

    return require(RECONCILE_PATH);
}

// ======================================================
// TESTS: ReconciliationReport
// ======================================================

describe('ReconciliationReport', () => {
    it('starts empty', () => {
        const engine = mockDeps(createMockRedis());
        const r = new engine.ReconciliationReport();
        const s = r.toSummary();
        expect(s.totalOrphanStates).to.equal(0);
        expect(s.totalOrphanAssets).to.equal(0);
        expect(s.totalPartialBuilds).to.equal(0);
        expect(s.totalStaleLocks).to.equal(0);
        expect(s.totalInconsistent).to.equal(0);
    });

    it('accumulates data from multiple checks', () => {
        const engine = mockDeps(createMockRedis());
        const r = new engine.ReconciliationReport();
        r.orphanStates.push({ type: 'orphan_video_state' });
        r.orphanAssets.push({ type: 'missing_audio_file' });
        r.partialBuilds.push({ type: 'partial_audio_only' });
        r.staleLocks.push({ type: 'lock_without_heartbeat' });
        r.inconsistentScenes.push({ scene: { sceneId: 's-1' }, issue: 'orphan_video_state' });
        const s = r.toSummary();
        expect(s.totalOrphanStates).to.equal(1);
        expect(s.totalOrphanAssets).to.equal(1);
        expect(s.totalPartialBuilds).to.equal(1);
        expect(s.totalStaleLocks).to.equal(1);
        expect(s.totalInconsistent).to.equal(1);
    });
});

// ======================================================
// TESTS: checkOrphanVideoState
// ======================================================

describe('checkOrphanVideoState', () => {
    let redis;

    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('returns null when video state is not READY', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', 'new');
        const engine = mockDeps(redis);
        expect(await engine.checkOrphanVideoState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('returns null when video is READY and file exists', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', 'ready');
        // Mock fs.access BEFORE loading the engine (the engine captures fs.promises at import time)
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async (fp) => {
            if (!fp.endsWith(`${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}.mp4`)) throw new Error('ENOENT');
        };
        try {
            const engine = mockDeps(redis);
            expect(await engine.checkOrphanVideoState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        } finally {
            require('fs').promises.access = origAccess;
        }
    });

    it('returns orphan report when video is READY but file missing', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', 'ready');
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async () => { throw new Error('ENOENT'); };
        try {
            const engine = mockDeps(redis);
            const result = await engine.checkOrphanVideoState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result).to.not.be.null;
            expect(result.type).to.equal('orphan_video_state');
            expect(result.recommendation).to.equal('regenerate_video');
            expect(result.missingFile).to.include('.mp4');
        } finally {
            require('fs').promises.access = origAccess;
        }
    });

    // PLACEHOLDER is treated the same as READY by checkOrphanVideoState
    // (both bypass the isVideoReady check) — if state says ready but file is gone, it's an orphan.
    it('reports orphan for PLACEHOLDER video when file is missing', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', 'placeholder');
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async () => { throw new Error('ENOENT'); };
        try {
            const engine = mockDeps(redis);
            const result = await engine.checkOrphanVideoState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result).to.not.be.null;
            expect(result.type).to.equal('orphan_video_state');
        } finally {
            require('fs').promises.access = origAccess;
        }
    });
});

// ======================================================
// TESTS: checkOrphanImageState
// ======================================================

describe('checkOrphanImageState', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('returns null when image state is not READY', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'generating');
        const engine = mockDeps(redis);
        expect(await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('returns null when image is READY and resolveCanonicalSceneImage returns a path', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            resolveCanonicalSceneImage: () => '/data/output/default/test.png',
        });
        expect(await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('returns orphan report when image is READY but resolveCanonicalSceneImage returns null', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            resolveCanonicalSceneImage: () => null,
        });
        const result = await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        expect(result.type).to.equal('orphan_image_state');
        expect(result.recommendation).to.equal('regenerate_image');
    });

    // ── Stage 143a (phase 2a · B2) ───────────────────────────────────
    it('empty legacy scan + a LIVE versioned pointer → no orphan (no false regeneration)', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            resolveCanonicalSceneImage: () => null,
            resolveVersionedSceneProof: async () => '/data/output/default/.versions/asset/7.png',
        });
        expect(await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('empty legacy scan + flag ON but NO pointer → orphan still reported (repair must happen)', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            resolveCanonicalSceneImage: () => null,
            resolveVersionedSceneProof: async () => null,
        });
        const result = await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        expect(result.type).to.equal('orphan_image_state');
    });

    it('an unreadable pointer store aborts the check (pass_incomplete) — never a regeneration on an outage', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            resolveCanonicalSceneImage: () => null,
            resolveVersionedSceneProof: async () => { throw new Error('ECONNREFUSED'); },
        });
        let err = null;
        try {
            await engine.checkOrphanImageState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        } catch (e) { err = e; }
        expect(err, 'the check must fail closed').to.not.be.null;
        expect(err.code).to.equal('pass_incomplete');
    });

    it('reconcileScene on a pointer-store outage returns WITHOUT orphan issues (no recommendation, no auto-fix)', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'ready');
        const engine = mockDeps(redis, {
            getSceneAssetsRedis: async () => null,
            resolveCanonicalSceneImage: () => null,
            resolveVersionedSceneProof: async () => { throw new Error('ECONNREFUSED'); },
        });
        const report = await engine.reconcileScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        const imageIssues = report.inconsistentScenes.filter((s) => s.issue === 'orphan_image_state');
        expect(imageIssues, 'an outage must not produce a regeneration recommendation').to.have.length(0);
        expect(report.orphanStates.filter((o) => o.type === 'orphan_image_state')).to.have.length(0);
    });
});

// ======================================================
// TESTS: checkOrphanAssets — Stage 143a (phase 2a · B2)
// ======================================================

describe('checkOrphanAssets — stage143a phase2a (B2)', () => {
    let redis;
    let origAccess;

    const ASSET_IMAGE_PATH = '/data/output/default/test.png';
    const assetsWithImage = async () => ({
        image: { path: ASSET_IMAGE_PATH, ready: true },
        audio: null,
        video: null,
    });

    beforeEach(() => {
        redis = createMockRedis();
        // The canonical file is gone (versioned-only build).
        origAccess = require('fs').promises.access;
        require('fs').promises.access = async (fp) => {
            if (fp === ASSET_IMAGE_PATH) throw new Error('ENOENT');
        };
    });
    afterEach(() => {
        require('fs').promises.access = origAccess;
        delete require.cache[RECONCILE_PATH];
    });

    it('missing canonical file + LIVE versioned pointer → no issue', async () => {
        const engine = mockDeps(redis, {
            getSceneAssetsRedis: assetsWithImage,
            resolveVersionedSceneProof: async () => '/data/output/default/.versions/asset/7.png',
        });
        expect(await engine.checkOrphanAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('missing canonical file + no pointer → missing_image_file is still reported (legacy semantics)', async () => {
        const engine = mockDeps(redis, {
            getSceneAssetsRedis: assetsWithImage,
            resolveVersionedSceneProof: async () => null,
        });
        const issues = await engine.checkOrphanAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(issues).to.be.an('array').that.is.not.empty;
        expect(issues[0].type).to.equal('missing_image_file');
    });

    it('an unreadable pointer store aborts the check (pass_incomplete) instead of recommending a regeneration', async () => {
        const engine = mockDeps(redis, {
            getSceneAssetsRedis: assetsWithImage,
            resolveVersionedSceneProof: async () => { throw new Error('ECONNREFUSED'); },
        });
        let err = null;
        try {
            await engine.checkOrphanAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        } catch (e) { err = e; }
        expect(err).to.not.be.null;
        expect(err.code).to.equal('pass_incomplete');
    });

    it('canonical file present → untouched legacy path (no facade call)', async () => {
        let proofCalls = 0;
        const engine = mockDeps(redis, {
            getSceneAssetsRedis: async () => ({
                image: { path: '/data/output/default/present.png', ready: true }, audio: null, video: null,
            }),
            resolveVersionedSceneProof: async () => { proofCalls += 1; return '/x.png'; },
        });
        expect(await engine.checkOrphanAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        expect(proofCalls, 'legacy hit never reaches the facade (flag OFF ⇒ 0 PG calls)').to.equal(0);
    });
});

// ======================================================
// TESTS: checkOrphanAudioState
// ======================================================

describe('checkOrphanAudioState', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('returns null when audio state is not READY', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'pending');
        const engine = mockDeps(redis);
        expect(await engine.checkOrphanAudioState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('returns null when audio is READY and file exists', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async (fp) => {
            if (!fp.endsWith(`${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}.mp3`)) throw new Error('ENOENT');
        };
        try {
            const engine = mockDeps(redis);
            expect(await engine.checkOrphanAudioState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        } finally {
            require('fs').promises.access = origAccess;
        }
    });

    it('returns orphan report when audio is READY but file missing', async () => {
        redis = createMockRedis();
        setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async () => { throw new Error('ENOENT'); };
        try {
            const engine = mockDeps(redis);
            const result = await engine.checkOrphanAudioState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(result).to.not.be.null;
            expect(result.type).to.equal('orphan_audio_state');
            expect(result.missingFile).to.include('.mp3');
        } finally {
            require('fs').promises.access = origAccess;
        }
    });
});

// NOTE: checkOrphanAssets and checkPartialBuilds tests are skipped because
// they require require.cache mocking of `storage.registry.getSceneAssetsRedis`
// which has an unfixed cross-test isolation issue in this file.
// These functions are indirectly covered by reconcileScene tests above.

// ======================================================
// TESTS: checkStalledAudioScenes
// ======================================================

describe('checkStalledAudioScenes', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('returns 0 when no audio-orch states exist', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const count = await engine.checkStalledAudioScenes(redis, {});
        expect(count).to.equal(0);
    });

    it('returns 0 when states are not in WAITING_CHUNKS', async () => {
        redis = createMockRedis();
        const audioOrchKey = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        await redis.set(audioOrchKey, JSON.stringify({
            phase: 'GENERATING', build_id: 'build-1', last_chunk_at: Date.now() - 60000,
        }));
        const engine = mockDeps(redis);
        const count = await engine.checkStalledAudioScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('returns 0 when last_chunk_at is recent', async () => {
        redis = createMockRedis();
        const audioOrchKey = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        await redis.set(audioOrchKey, JSON.stringify({
            phase: 'WAITING_CHUNKS', build_id: 'build-1', last_chunk_at: Date.now() - 1000,
        }));
        const engine = mockDeps(redis);
        const count = await engine.checkStalledAudioScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('returns >0 for stalled WAITING_CHUNKS (last_chunk_at older than threshold)', async () => {
        redis = createMockRedis();
        const audioOrchKey = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        await redis.set(audioOrchKey, JSON.stringify({
            phase: 'WAITING_CHUNKS', build_id: 'build-1',
            last_chunk_at: Date.now() - 1900000, // ~31.7 min ago, > 30 min threshold (AUDIO_CHUNK_STALL_MS = 1_800_000)
        }));
        const engine = mockDeps(redis);
        const count = await engine.checkStalledAudioScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(1);
    });

    it('skips WAITING_CHUNKS without last_chunk_at', async () => {
        redis = createMockRedis();
        const audioOrchKey = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        await redis.set(audioOrchKey, JSON.stringify({
            phase: 'WAITING_CHUNKS', build_id: 'build-1',
        }));
        const engine = mockDeps(redis);
        const count = await engine.checkStalledAudioScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });
});

// ======================================================
// TESTS: checkStalledVideoScenes
// ======================================================
// Видео-генерация долгая: watchdog НЕ должен убивать нормальную долгую
// генерацию коротким фиксированным порогом. Порог застоя = max(база,
// video_timeout_minutes из layer-config + 5 мин буфера) — hub затаймливает
// воркера раньше, watchdog срабатывает только если не пришло НИЧЕГО.

describe('checkStalledVideoScenes', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    function setVideoOrch(redis, phase, extra = {}) {
        const key = `animastor:video-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        return redis.set(key, JSON.stringify({ phase, build_id: 'build-1', ...extra }));
    }

    it('returns 0 when no video-orch states exist', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('returns 0 when phase is not WAITING_CHUNKS', async () => {
        redis = createMockRedis();
        await setVideoOrch(redis, 'GENERATING', { started_at: Date.now() - 60000 });
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('returns 0 when last_group_at is recent (долгая, но живая генерация)', async () => {
        redis = createMockRedis();
        await setVideoOrch(redis, 'WAITING_CHUNKS', { last_group_at: Date.now() - 1000 });
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('fails scene stalled beyond base threshold (нет прогресса за весь порог)', async () => {
        redis = createMockRedis();
        // Базовый порог = STALL_FAILSAFE_MS * 2. При GPU_TIMEOUT_MS=600s это 60 мин.
        // Застой 70 мин > 60 мин, layer-config не задан → база.
        await setVideoOrch(redis, 'WAITING_CHUNKS', { last_group_at: Date.now() - 70 * 60 * 1000 });
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(1);
    });

    it('УВАЖАЕТ layer-config video_timeout_minutes: долгая генерация (50 мин) при timeout=120 НЕ считается застоем', async () => {
        redis = createMockRedis();
        // per-book timeout 120 мин → порог = 120 + 5 = 125 мин. Генерация 50 мин
        // без прогресса — это ещё норма (первая группа LTX может идти долго).
        await redis.set(`animastor:layer-config:${BOOK_ID}`, JSON.stringify({ video_timeout_minutes: 120 }));
        await setVideoOrch(redis, 'WAITING_CHUNKS', { last_group_at: Date.now() - 50 * 60 * 1000 });
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(0);
    });

    it('фолбэк на базу при отсутствии layer-config: 70 мин без прогресса → stalled', async () => {
        redis = createMockRedis();
        await setVideoOrch(redis, 'WAITING_CHUNKS', { last_group_at: Date.now() - 70 * 60 * 1000 });
        const engine = mockDeps(redis);
        const count = await engine.checkStalledVideoScenes(redis, { orchestrator: { failStage: async () => {} } });
        expect(count).to.equal(1);
    });
});

// ======================================================
// TESTS: checkStaleLocks
// ======================================================

describe('checkStaleLocks', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('returns null when no locks exist', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        expect(await engine.checkStaleLocks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('detects lock without heartbeat', async () => {
        redis = createMockRedis();
        await redis.set(`animastor:audio-scene-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({ pid: 123 }));
        const engine = mockDeps(redis);
        const result = await engine.checkStaleLocks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        expect(result[0].type).to.equal('lock_without_heartbeat');
    });

    it('detects stale heartbeat (> 5 min)', async () => {
        redis = createMockRedis();
        await redis.set(`animastor:audio-scene-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({ pid: 123 }));
        await redis.set(`animastor:scene-heartbeat:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, String(Date.now() - 6 * 60 * 1000));
        const engine = mockDeps(redis);
        const result = await engine.checkStaleLocks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        expect(result[0].type).to.equal('stale_heartbeat');
    });

    it('returns null when heartbeat is recent', async () => {
        redis = createMockRedis();
        await redis.set(`animastor:audio-scene-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({ pid: 123 }));
        await redis.set(`animastor:scene-heartbeat:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, String(Date.now() - 1000));
        const engine = mockDeps(redis);
        expect(await engine.checkStaleLocks(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });
});

// ======================================================
// TESTS: checkStaleDispatchLeases — TTL-based liveness
// ======================================================
// Audit c8b79f6 (incident 2026-08-28): liveness is the lease's REMAINING TTL
// (renewal keeps it pinned), never metadata.started_at age. A live renewed
// video dispatch — however old — must NOT be flagged stale; a lease whose
// renewals stopped must be flagged once its TTL decays past the grace window.

describe('checkStaleDispatchLeases (audit c8b79f6: TTL-based liveness)', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    const dispatchEngine = require('../node_modules/@animastor/orchestration/src/runtime/dispatch-engine');
    const leaseManager = require('../node_modules/@animastor/orchestration/src/runtime/lease-manager');

    // Seed lease + metadata like dispatchStage does, with a controllable started_at.
    async function seedDispatch(stage, dispatchId, startedAtAgoMs) {
        const lease = await dispatchEngine.acquireStageLease(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, stage);
        expect(lease.acquired).to.equal(true);
        const metadata = dispatchEngine.createDispatchMetadata(dispatchId, stage, 'scheduler', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        });
        metadata.started_at = Date.now() - startedAtAgoMs;
        await dispatchEngine.setDispatchMetadata(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, stage, metadata);
        return lease;
    }

    it('renewed video dispatch, started_at 28 min old → NOT stale', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const lease = await seedDispatch('video', 'dispatch-alive', 28 * 60 * 1000);
        // Renewal timer keeps the TTL pinned at the renewal target.
        const renewed = await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
        expect(renewed.renewed).to.equal(true);

        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('video job alive 45 min into a 60-min timeout (renewed) → NOT stale, no RELEASE_STALE_LEASE', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const lease = await seedDispatch('video', 'dispatch-long', 45 * 60 * 1000);
        await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);

        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        // No stale issue → no RELEASE_STALE_LEASE recommendation.
        const fixes = engine.getFixRecommendations([]);
        expect(fixes.find(f => f.action === 'RELEASE_STALE_LEASE')).to.not.exist;
    });

    it('queued dispatch waiting for an offline GPU (renewed, hours old) → NOT stale', async () => {
        // While the backend is alive the renewal timer runs regardless of worker
        // availability, so a job waiting in the hub queue must not be re-dispatched
        // into duplicate copies just because it has been waiting a long time.
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const lease = await seedDispatch('video', 'dispatch-queued', 3 * 60 * 60 * 1000);
        await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);

        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('freshly acquired lease (before first renewal) → NOT stale', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        await seedDispatch('video', 'dispatch-fresh', 0);

        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('renewals stopped → TTL decayed past grace → stale_dispatch_lease', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const lease = await seedDispatch('video', 'dispatch-dead', 20 * 60 * 1000);
        // Owner died: TTL decayed below (renewal target - grace).
        const decayed = leaseManager.getRenewalTargetTtlS('video') - leaseManager.STALE_LEASE_GRACE_S - 60;
        await redis.expire(lease.leaseKey, decayed);

        const result = await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        const stale = result.find(r => r.type === 'stale_dispatch_lease' && r.stage === 'video');
        expect(stale).to.exist;
        expect(stale.recommendation).to.equal('release_lease_and_move_to_pending');
    });

    it('lease exists but metadata missing → orphan_dispatch_lease', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const leaseKey = dispatchEngine.getLeaseKey(BOOK_ID, CHAPTER_ID, SCENE_ID, 'image');
        await redis.set(leaseKey, 'dispatch-orphan-token', 'EX', 600);

        const result = await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        expect(result.find(r => r.type === 'orphan_dispatch_lease' && r.stage === 'image')).to.exist;
    });

    it('no leases → null', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
    });

    it('lease without expiry (TTL=-1) → stale_dispatch_lease (recovered, never eternal)', async () => {
        redis = createMockRedis();
        const engine = mockDeps(redis);
        // Hand-craft lease + metadata with NO expiry (TTL=-1).
        const leaseKey = dispatchEngine.getLeaseKey(BOOK_ID, CHAPTER_ID, SCENE_ID, 'video');
        await redis.set(leaseKey, 'dispatch-noexpiry-token'); // no EX
        const metadata = dispatchEngine.createDispatchMetadata('dispatch-noexpiry', 'video', 'scheduler', {
            leaseKey, leaseToken: 'dispatch-noexpiry-token', quotaOwned: true,
        });
        await redis.set(dispatchEngine.getDispatchMetaKey(BOOK_ID, CHAPTER_ID, SCENE_ID, 'video'), JSON.stringify(metadata)); // no EX
        expect(await redis.ttl(leaseKey)).to.equal(-1);

        const result = await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(result).to.not.be.null;
        const stale = result.find(r => r.type === 'stale_dispatch_lease' && r.stage === 'video');
        expect(stale).to.exist;
        expect(stale.leaseTtlS).to.equal(-1);
    });

    it('agrees with shouldSkipDispatch for the same lease state (shared isLeaseStale)', async () => {
        // Both entry points are call sites of the SAME predicate
        // leaseManager.isLeaseStale(redis.ttl(leaseKey), stage) — they must
        // never diverge, otherwise reconciliation and the dispatch gate would
        // disagree about liveness.
        redis = createMockRedis();
        const engine = mockDeps(redis);

        // (a) healthy renewed lease → neither flags stale.
        const lease = await seedDispatch('video', 'dispatch-consistent', 40 * 60 * 1000);
        await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);
        expect(await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        expect((await dispatchEngine.shouldSkipDispatch(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video')).reason)
            .to.equal('lease_active');

        // (b) TTL decayed past grace → both flag stale.
        const decayed = leaseManager.getRenewalTargetTtlS('video') - leaseManager.STALE_LEASE_GRACE_S - 60;
        await redis.expire(lease.leaseKey, decayed);
        const staleList = await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(staleList.find(r => r.type === 'stale_dispatch_lease' && r.stage === 'video')).to.exist;
        expect((await dispatchEngine.shouldSkipDispatch(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video')).reason)
            .to.equal('stale_lease');
    });
});

// ======================================================
// TESTS: applyFix — RELEASE_STALE_LEASE (recovery + de-dup)
// ======================================================

describe('applyFix — RELEASE_STALE_LEASE (audit c8b79f6 recovery)', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    const dispatchEngine = require('../node_modules/@animastor/orchestration/src/runtime/dispatch-engine');
    const leaseManager = require('../node_modules/@animastor/orchestration/src/runtime/lease-manager');

    it('releases a truly stale lease, frees quota, marks scene dirty, re-activates it', async () => {
        redis = createMockRedis();
        const markDirtyCalls = [];
        const engine = mockDeps(redis, {
            markDirtyScene: async (r, bookId, chapterId, sceneId) => {
                markDirtyCalls.push({ bookId, chapterId, sceneId });
            },
        });

        // Stub the hub HTTP layer — unit test must not reach the real GPU hub.
        const hubCalls = [];
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts) => {
            hubCalls.push({ url: String(url), method: opts && opts.method });
            return { ok: true, status: 200, json: async () => ({}) };
        };

        try {
            // Seed a video dispatch whose renewals stopped (TTL decayed past grace).
            const lease = await dispatchEngine.acquireStageLease(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video');
            const metadata = dispatchEngine.createDispatchMetadata('dispatch-dead', 'video', 'scheduler', {
                leaseKey: lease.leaseKey,
                leaseToken: lease.token,
                quotaOwned: true,
            });
            await dispatchEngine.setDispatchMetadata(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', metadata);
            await dispatchEngine.acquireQuota(redis, 'video');
            await redis.expire(lease.leaseKey, 60);

            const counterBefore = await dispatchEngine.getActiveCounter(redis, 'video');
            expect(counterBefore).to.equal(1);

            const result = await engine.applyFix(redis, {
                scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
                action: 'RELEASE_STALE_LEASE',
                reason: 'Stale dispatch lease detected',
            });

            expect(result.success).to.equal(true);
            // Lease + metadata gone, quota slot returned.
            expect(await redis.get(lease.leaseKey)).to.be.null;
            expect(await dispatchEngine.getDispatchMetadata(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video')).to.be.null;
            expect(await dispatchEngine.getActiveCounter(redis, 'video')).to.equal(counterBefore - 1);
            // Scene is dirty + back in the active index for a legitimate re-dispatch.
            expect(markDirtyCalls.length).to.equal(1);
            const active = await redis.smembers('animastor:active-scenes');
            expect(active).to.include(`${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`);
            // The dead dispatch's hub copies are purged so they cannot accumulate.
            expect(hubCalls.length).to.equal(1);
            expect(hubCalls[0].url).to.include('/queue/clear');
            expect(hubCalls[0].url).to.include('dispatch_id=dispatch-dead');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('does not release a live renewed lease if applied (defense in depth)', async () => {
        // Even if a stale_dispatch_lease fix were somehow produced for a live
        // lease, cancellation goes through the ownership-checked path. Here we
        // only assert the check itself never produces such a fix for a renewed
        // lease (the root-cause guard).
        redis = createMockRedis();
        const engine = mockDeps(redis);
        const lease = await dispatchEngine.acquireStageLease(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video');
        const metadata = dispatchEngine.createDispatchMetadata('dispatch-alive', 'video', 'scheduler', {
            leaseKey: lease.leaseKey,
            leaseToken: lease.token,
            quotaOwned: true,
        });
        metadata.started_at = Date.now() - 40 * 60 * 1000;
        await dispatchEngine.setDispatchMetadata(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', metadata);
        await leaseManager.renewLeaseIfOwner(redis, lease.leaseKey, lease.token);

        const stale = await engine.checkStaleDispatchLeases(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(stale).to.be.null;
        const fixes = engine.getFixRecommendations([]);
        expect(fixes.find(f => f.action === 'RELEASE_STALE_LEASE')).to.not.exist;
    });
});

// ======================================================
// TESTS: getFixRecommendations
// ======================================================

describe('getFixRecommendations', () => {
    before(() => { mockDeps(createMockRedis()); });

    it('returns REGENERATE_MISSING_ASSET for orphan_video_state', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'orphan_video_state' }]);
        expect(fixes[0].action).to.equal('REGENERATE_MISSING_ASSET');
        expect(fixes[0].safeToExecute).to.be.true;
    });

    it('returns PROGRESS_TO_IMAGE for partial_audio_only', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'partial_audio_only' }]);
        expect(fixes[0].action).to.equal('PROGRESS_TO_IMAGE');
    });

    it('returns PROGRESS_TO_VIDEO for partial_image_video_missing', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'partial_image_video_missing' }]);
        expect(fixes[0].action).to.equal('PROGRESS_TO_VIDEO');
    });

    it('returns RELEASE_STALE_LOCKS for stale_locks', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'stale_locks' }]);
        expect(fixes[0].action).to.equal('RELEASE_STALE_LOCKS');
    });

    it('returns RECOVER_ORPHAN_ASSETS for orphan_assets', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'orphan_assets' }]);
        expect(fixes[0].action).to.equal('RECOVER_ORPHAN_ASSETS');
    });

    it('returns MOVE_TO_PENDING for stuck_state with reason', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([
            { scene: sceneRef(), issue: 'stuck_state', state: 'audio_generating', ageMinutes: 30 },
        ]);
        expect(fixes[0].action).to.equal('MOVE_TO_PENDING');
        expect(fixes[0].reason).to.include('Stuck in');
    });

    it('returns RELEASE_STALE_LEASE for stale_dispatch_lease', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'stale_dispatch_lease' }]);
        expect(fixes[0].action).to.equal('RELEASE_STALE_LEASE');
    });

    it('returns RECONCILE_COUNTER_DRIFT with stage for counter_drift', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([
            { scene: sceneRef(), issue: 'counter_drift', stage: 'audio', drift: 5, leaseCount: 2, counterValue: 7 },
        ]);
        expect(fixes[0].action).to.equal('RECONCILE_COUNTER_DRIFT');
        expect(fixes[0].stage).to.equal('audio');
    });

    it('returns REVIEW_MANUALLY for unknown issues', () => {
        const engine = require(RECONCILE_PATH);
        const fixes = engine.getFixRecommendations([{ scene: sceneRef(), issue: 'unknown_issue' }]);
        expect(fixes[0].action).to.equal('REVIEW_MANUALLY');
        expect(fixes[0].safeToExecute).to.be.false;
    });
});

// ======================================================
// TESTS: applyFix — RELEASE_STALE_LOCKS
// ======================================================

describe('applyFix — RELEASE_STALE_LOCKS', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('removes all lock keys for the scene', async () => {
        redis = createMockRedis();
        const lockKey1 = `animastor:audio-scene-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        const lockKey2 = `animastor:video-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
        await redis.set(lockKey1, 'data1');
        await redis.set(lockKey2, 'data2');

        const engine = mockDeps(redis);
        const result = await engine.applyFix(redis, {
            scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
            action: 'RELEASE_STALE_LOCKS',
        });
        expect(result.success).to.be.true;
        expect(await redis.get(lockKey1)).to.be.null;
        expect(await redis.get(lockKey2)).to.be.null;
    });
});

// ======================================================
// TESTS: applyFix — REGENERATE_MISSING_ASSET
// ======================================================

describe('applyFix — REGENERATE_MISSING_ASSET', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('calls orchestrator.setScenePending for audio', async () => {
        redis = createMockRedis();
        const calls = [];
        const engine = mockDeps(redis, {
            setScenePending: async (r, bookId, chapterId, sceneId, assetType) => {
                calls.push({ bookId, chapterId, sceneId, assetType });
            },
        });
        const result = await engine.applyFix(redis, {
            scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
            action: 'REGENERATE_MISSING_ASSET',
            reason: 'AUDIO_READY but no audio file (audio)',
        });
        expect(result.success).to.be.true;
        expect(calls.length).to.equal(1);
        expect(calls[0].assetType).to.equal('audio');
    });

    it('calls orchestrator.setScenePending for video', async () => {
        redis = createMockRedis();
        const calls = [];
        const engine = mockDeps(redis, {
            setScenePending: async (r, bookId, chapterId, sceneId, assetType) => {
                calls.push({ assetType });
            },
        });
        const result = await engine.applyFix(redis, {
            scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
            action: 'REGENERATE_MISSING_ASSET',
            reason: 'VIDEO_READY but no video file (video)',
        });
        expect(result.success).to.be.true;
        expect(calls[0].assetType).to.equal('video');
    });

    it('calls orchestrator.setScenePending for image', async () => {
        redis = createMockRedis();
        const calls = [];
        const engine = mockDeps(redis, {
            setScenePending: async (r, bookId, chapterId, sceneId, assetType) => {
                calls.push({ assetType });
            },
        });
        const result = await engine.applyFix(redis, {
            scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
            action: 'REGENERATE_MISSING_ASSET',
            reason: 'IMAGE_READY but no image file (IU) (image)',
        });
        expect(result.success).to.be.true;
        expect(calls[0].assetType).to.equal('image');
    });
});

// ======================================================
// TESTS: applyFix — MOVE_TO_PENDING
// ======================================================

describe('applyFix — MOVE_TO_PENDING', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('calls orchestrator.markDirtyScene and scheduler.removeSceneFromActiveIndex', async () => {
        redis = createMockRedis();
        const calls = { markDirty: [], removeActive: [] };
        const engine = mockDeps(redis, {
            markDirtyScene: async (r, bookId, chapterId, sceneId) => {
                calls.markDirty.push({ bookId, chapterId, sceneId });
            },
        });
        const result = await engine.applyFix(redis, {
            scene: { bookId: BOOK_ID, chapterId: CHAPTER_ID, sceneId: SCENE_ID },
            action: 'MOVE_TO_PENDING',
            reason: 'Stuck in audio_generating for 30 minutes',
        });
        expect(result.success).to.be.true;
        expect(calls.markDirty.length).to.equal(1);
        expect(result.details).to.include('DIRTY');
    });
});

// ======================================================
// TESTS: reconcileScene — full scene check
// ======================================================

describe('reconcileScene', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('reports no issues for a clean scene', async () => {
        redis = createMockRedis();
        setAllAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'pending', image: 'new', video: 'new',
        });
        const engine = mockDeps(redis, { getSceneAssetsRedis: async () => null });
        const report = await engine.reconcileScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(report.toSummary().totalInconsistent).to.equal(0);
    });

    it('reports orphan video for READY state without file', async () => {
        redis = createMockRedis();
        setAllAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'pending', image: 'new', video: 'ready',
        });
        const origAccess = require('fs').promises.access;
        require('fs').promises.access = async () => { throw new Error('ENOENT'); };
        try {
            const engine = mockDeps(redis, { getSceneAssetsRedis: async () => null });
            const report = await engine.reconcileScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
            expect(report.toSummary().totalOrphanStates).to.equal(1);
            expect(report.orphanStates[0].type).to.equal('orphan_video_state');
        } finally {
            require('fs').promises.access = origAccess;
        }
    });

    it('reports stale locks', async () => {
        redis = createMockRedis();
        setAllAssets(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'pending', image: 'new', video: 'new',
        });
        await redis.set(`animastor:audio-scene-lock:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({ pid: 123 }));
        const engine = mockDeps(redis, { getSceneAssetsRedis: async () => null });
        const report = await engine.reconcileScene(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(report.toSummary().totalStaleLocks).to.equal(1);
    });
});

// ======================================================
// TESTS: recoverAudioOrchStates — startup phase C1
// ======================================================
// Regression for the production startup warn (stages 42/44):
//   [STARTUP] Reconcile errors: audio_orch: Cannot read properties of
//   undefined (reading 'findExistingSceneChunks')
// The C1 leg resolves `media.audio.chunks` through the host-binding seam.
// The composition root must register the two audio sub-modules the extracted
// package expects (chunks/segments) — the same modules the pre-move files
// required as '../audio/chunks' and '../audio/segments'. The audio barrel is
// flat, so without that registration every non-terminal audio-orch state
// aborts the whole C1 phase with a TypeError.

describe('recoverAudioOrchStates (startup C1)', () => {
    let redis;
    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    it('host media binding exposes the audio.chunks / audio.segments sub-modules', () => {
        const media = require('@animastor/orchestration').hostBinding('media');
        expect(media.audio.chunks, 'media.audio.chunks must be registered').to.be.an('object');
        expect(media.audio.chunks.findExistingSceneChunks).to.be.a('function');
        expect(media.audio.segments, 'media.audio.segments must be registered').to.be.an('object');
        expect(media.audio.segments.buildSegments).to.be.a('function');
        // flat barrel surface stays intact for every other media.audio consumer
        expect(media.audio.findExistingSceneChunks).to.be.a('function');
        expect(media.audio.buildSegments).to.be.a('function');
    });

    it('GENERATING state with no chunks on disk → FAILED, no audio_orch error', async () => {
        redis = createMockRedis();
        await redis.set(`animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({
            phase: 'GENERATING', expected_count: 0, chunks_received: 0,
            build_id: null, started_at: Date.now() - 86400000,
        }));
        const calls = { failed: 0, assetResync: 0, dirty: 0 };
        const engine = mockDeps(redis, {
            state: { unsafeRestoreAssetState: async () => { calls.assetResync++; } },
            setFailed: async () => { calls.failed++; return { phase: 'FAILED' }; },
        });

        const recovered = await engine.recoverAudioOrchStates(redis, {
            orchestrator: { markDirtyScene: async () => { calls.dirty++; } },
        });

        expect(recovered).to.equal(1);
        expect(calls.failed, 'audio-orch state must be driven to FAILED').to.equal(1);
        expect(calls.assetResync, 'asset.audio must be resynced to FAILED').to.equal(1);
        expect(calls.dirty, 'scene must be marked dirty for re-dispatch').to.equal(1);
    });

    it('GENERATING state with all chunks on disk → merge recovery, no audio_orch error', async () => {
        redis = createMockRedis();
        await redis.set(`animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`, JSON.stringify({
            phase: 'GENERATING', expected_count: 2, chunks_received: 2,
            build_id: 'build-test', started_at: Date.now() - 86400000,
        }));
        const calls = { completeChunk: 0, failed: 0 };
        const engine = mockDeps(redis, {
            state: { unsafeRestoreAssetState: async () => {} },
            completeChunk: async () => { calls.completeChunk++; return { phase: 'MERGING' }; },
            setFailed: async () => { calls.failed++; return { phase: 'FAILED' }; },
        });

        // stub the chunk enumeration on the registered media binding: 2/2 present
        const media = require('@animastor/orchestration').hostBinding('media');
        const origFind = media.audio.chunks.findExistingSceneChunks;
        media.audio.chunks.findExistingSceneChunks = () => [1, 2];
        try {
            const recovered = await engine.recoverAudioOrchStates(redis, { orchestrator: {} });
            expect(recovered).to.equal(1);
            expect(calls.completeChunk, 'completeChunk merge recovery must run').to.equal(1);
            expect(calls.failed).to.equal(0);
        } finally {
            media.audio.chunks.findExistingSceneChunks = origFind;
        }
    });
});

// ======================================================
// TESTS: recoverAudioOrchStates — REAL audio FSM (stage 46)
// ======================================================
// Stage 45 fixed the host binding, but C1's setFailed() writes still no-oped
// on the July-2026 orphan GENERATING keys: the host FSM map forbade
// GENERATING → FAILED, so transitionState() returned invalid_transition and
// the record stayed GENERATING forever (production warn:
// `[AUDIO-ORCH] ⚠️ Invalid transition: GENERATING → FAILED`). These tests
// drive C1 through the REAL audio-orchestrator FSM (captured at file load),
// so the VALID_TRANSITIONS map itself is under test — not a setFailed stub.

describe('recoverAudioOrchStates — real audio FSM (stage 46)', () => {
    const AUDIO_KEY = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
    let redis;

    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    function seed(redisRef, state) {
        return redisRef.set(AUDIO_KEY, JSON.stringify({ build_id: null, ...state }));
    }

    async function readState(redisRef) {
        const raw = await redisRef.get(AUDIO_KEY);
        return raw ? JSON.parse(raw) : null;
    }

    it('stuck GENERATING record → FAILED through the real FSM (restart_recovery)', async () => {
        redis = createMockRedis();
        await seed(redis, {
            phase: 'GENERATING', expected_count: 0, chunks_received: 0,
            started_at: Date.now() - 86400000,
        });
        const calls = { dirty: 0 };
        const engine = mockDeps(redis, {
            setFailed: (...args) => realAudioOrch.setFailed(...args),
            state: { unsafeRestoreAssetState: async () => {} },
        });

        const recovered = await engine.recoverAudioOrchStates(redis, {
            orchestrator: { markDirtyScene: async () => { calls.dirty++; } },
        });

        expect(recovered).to.equal(1);
        const state = await readState(redis);
        expect(state.phase, 'C1 must persist FAILED through the FSM map').to.equal('FAILED');
        expect(state.fail_reason).to.equal('restart_recovery');
        expect(state.failed_at).to.be.a('number');
        expect(calls.dirty, 'scene must be marked dirty for re-dispatch').to.equal(1);
    });

    it('terminal record is not modified by recovery', async () => {
        redis = createMockRedis();
        const terminal = {
            phase: 'DONE', expected_count: 3, chunks_received: 3,
            build_id: 'build-terminal', started_at: 1780000000000,
            last_chunk_at: 1780000001000,
        };
        await seed(redis, terminal);
        const engine = mockDeps(redis, {
            setFailed: (...args) => realAudioOrch.setFailed(...args),
            state: { unsafeRestoreAssetState: async () => {} },
        });

        const recovered = await engine.recoverAudioOrchStates(redis, { orchestrator: {} });

        expect(recovered).to.equal(0);
        expect(await readState(redis)).to.deep.equal(terminal);
    });

    it('active generation is not failed just because the record is old — merge recovery wins', async () => {
        redis = createMockRedis();
        await seed(redis, {
            phase: 'GENERATING', expected_count: 2, chunks_received: 2,
            build_id: 'build-active', started_at: Date.now() - 86400000,
        });
        const calls = { completeChunk: 0, failed: 0 };
        const engine = mockDeps(redis, {
            completeChunk: async () => { calls.completeChunk++; return { phase: 'MERGING' }; },
            setFailed: (...args) => { calls.failed++; return realAudioOrch.setFailed(...args); },
            state: { unsafeRestoreAssetState: async () => {} },
        });

        const media = require('@animastor/orchestration').hostBinding('media');
        const origFind = media.audio.chunks.findExistingSceneChunks;
        media.audio.chunks.findExistingSceneChunks = () => [1, 2];
        try {
            const recovered = await engine.recoverAudioOrchStates(redis, { orchestrator: {} });
            expect(recovered).to.equal(1);
            expect(calls.completeChunk, 'merge recovery must run').to.equal(1);
            expect(calls.failed, 'age alone must never drive FAILED').to.equal(0);
            expect((await readState(redis)).phase).to.not.equal('FAILED');
        } finally {
            media.audio.chunks.findExistingSceneChunks = origFind;
        }
    });

    it('repeated recovery is idempotent — second run leaves FAILED untouched', async () => {
        redis = createMockRedis();
        await seed(redis, {
            phase: 'GENERATING', expected_count: 0, chunks_received: 0,
            started_at: Date.now() - 86400000,
        });
        const engine = mockDeps(redis, {
            setFailed: (...args) => realAudioOrch.setFailed(...args),
            state: { unsafeRestoreAssetState: async () => {} },
        });
        const orch = { markDirtyScene: async () => {} };

        expect(await engine.recoverAudioOrchStates(redis, { orchestrator: orch })).to.equal(1);
        const afterFirst = await readState(redis);
        expect(afterFirst.phase).to.equal('FAILED');

        expect(await engine.recoverAudioOrchStates(redis, { orchestrator: orch })).to.equal(0);
        expect(await readState(redis)).to.deep.equal(afterFirst);
    });

    it('forbidden transitions stay forbidden through the real FSM (PLACEHOLDER_READY → FAILED)', async () => {
        redis = createMockRedis();
        await seed(redis, {
            phase: 'PLACEHOLDER_READY', expected_count: 4, chunks_received: 0,
            started_at: Date.now() - 86400000, build_id: 'build-early',
        });
        // PLACEHOLDER_READY is non-terminal for the FSM but C1's switch sends
        // it to the default branch (deleteState) — assert the FSM itself still
        // refuses the premature FAILED write even if a caller tries it.
        const result = await realAudioOrch.setFailed(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'premature');
        expect(result.success).to.be.false;
        expect(result.reason).to.equal('invalid_transition');
        expect((await readState(redis)).phase).to.equal('PLACEHOLDER_READY');
    });
});

// ======================================================
// TESTS: orch invariants — FAILED + DIRTY (stage 47)
// ======================================================
// Stage 46 recovery left three July-2026 scenes at
//   audio-orch phase=FAILED (fail_reason=restart_recovery) + asset.audio=dirty,
// and every reconcile cycle logged `audio_orch_invariant_failed`. That state is
// the deliberate output of the C1 leg (setFailed → unsafeRestoreAssetState
// FAILED → markDirtyScene DIRTY + PG status='stale'): shouldScheduleAssets()
// re-dispatches only PENDING/DIRTY (a FAILED asset is terminal for the
// scheduler), and the violation's own recommendation is 'mark_dirty' — the
// pre-stage-47 check rejected exactly the state it told operators to produce.
// These tests pin the contract:
//   • allowed combinations (FAILED × {failed,pending,dirty}, DONE × ready,
//     intermediate × {pending,generating,dirty}) produce NO invariant error;
//   • real contradictions (FAILED × ready, DONE × dirty, intermediate × ready)
//     are still reported;
//   • a second recovery run is a no-op and never clears the dirty marker;
//   • the recommendation for a real FAILED-phase contradiction stays log-only.

describe('orch invariants — FAILED + DIRTY (stage 47)', () => {
    const AUDIO_KEY = `animastor:audio-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
    const VIDEO_KEY = `animastor:video-orch:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;

    afterEach(() => { delete require.cache[RECONCILE_PATH]; });

    // Audio: the phase record is read through the AudioFsmPort → host
    // audio-orchestrator, which this harness mocks at AUDIO_ORCH_PATH — so
    // getState is overridden to read the seeded key instead of returning null
    // (a null orchState would make the check vacuously pass).
    async function audioCheck(redis, phase, audioState) {
        await redis.set(AUDIO_KEY, JSON.stringify({
            phase, expected_count: 1, chunks_received: 0,
            build_id: 'build-inv', started_at: Date.now(),
        }));
        await setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', audioState);
        const engine = mockDeps(redis, {
            getAudioOrchState: async (r, b, c, s) => {
                const raw = await r.get(`animastor:audio-orch:${b}:${c}:${s}`);
                return raw ? JSON.parse(raw) : null;
            },
        });
        return engine.checkAudioOrchInvariants(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
    }

    // Video: no video-orchestrator mock in this harness — the REAL FSM reader
    // resolves through the wired VideoFsmPort (see .mocharc test bindings).
    async function videoCheck(redis, phase, videoState) {
        await redis.set(VIDEO_KEY, JSON.stringify({
            phase, started_at: Date.now(), build_id: 'build-inv',
        }));
        await setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'video', videoState);
        const engine = mockDeps(redis);
        return engine.checkVideoOrchInvariants(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
    }

    describe('allowed combinations produce no false positives', () => {
        it('audio FAILED + dirty (C1 recovery outcome) → null', async () => {
            expect(await audioCheck(createMockRedis(), 'FAILED', 'dirty')).to.be.null;
        });

        it('audio FAILED + failed (failStage without redispatch) → null', async () => {
            expect(await audioCheck(createMockRedis(), 'FAILED', 'failed')).to.be.null;
        });

        it('audio FAILED + pending (failStage with redispatch) → null', async () => {
            expect(await audioCheck(createMockRedis(), 'FAILED', 'pending')).to.be.null;
        });

        it('audio DONE + ready (terminal success) → null', async () => {
            expect(await audioCheck(createMockRedis(), 'DONE', 'ready')).to.be.null;
        });

        it('audio intermediate phase + dirty/pending → null', async () => {
            expect(await audioCheck(createMockRedis(), 'WAITING_CHUNKS', 'dirty')).to.be.null;
            expect(await audioCheck(createMockRedis(), 'WAITING_CHUNKS', 'pending')).to.be.null;
            expect(await audioCheck(createMockRedis(), 'GENERATING', 'generating')).to.be.null;
        });

        it('video FAILED + dirty (C1b recovery outcome) → null', async () => {
            expect(await videoCheck(createMockRedis(), 'FAILED', 'dirty')).to.be.null;
        });

        it('video FAILED + failed / pending → null', async () => {
            expect(await videoCheck(createMockRedis(), 'FAILED', 'failed')).to.be.null;
            expect(await videoCheck(createMockRedis(), 'FAILED', 'pending')).to.be.null;
        });
    });

    describe('real contradictions are still reported', () => {
        it('audio FAILED + ready → audio_orch_invariant_failed', async () => {
            const violations = await audioCheck(createMockRedis(), 'FAILED', 'ready');
            expect(violations, 'FAILED orchestrator + accepted asset is a contradiction').to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('audio_orch_invariant_failed');
            expect(violations[0].audioState).to.equal('ready');
            expect(violations[0].expected).to.equal('FAILED, PENDING or DIRTY');
        });

        it('audio FAILED + generating → still reported (in-flight state is not a FAILED end state)', async () => {
            const violations = await audioCheck(createMockRedis(), 'FAILED', 'generating');
            expect(violations).to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('audio_orch_invariant_failed');
        });

        it('audio DONE + dirty → audio_orch_invariant_done (terminal invariant not weakened)', async () => {
            const violations = await audioCheck(createMockRedis(), 'DONE', 'dirty');
            expect(violations).to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('audio_orch_invariant_done');
        });

        it('audio intermediate + ready → audio_orch_invariant_intermediate', async () => {
            const violations = await audioCheck(createMockRedis(), 'WAITING_CHUNKS', 'ready');
            expect(violations).to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('audio_orch_invariant_intermediate');
        });

        it('video FAILED + ready → video_orch_invariant_failed', async () => {
            const violations = await videoCheck(createMockRedis(), 'FAILED', 'ready');
            expect(violations).to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('video_orch_invariant_failed');
            expect(violations[0].expected).to.equal('FAILED, PENDING or DIRTY');
        });
    });

    describe('recommendation for a FAILED-phase violation stays log-only', () => {
        it('audio_orch_invariant_failed → REVIEW_MANUALLY, safeToExecute=false', () => {
            const engine = mockDeps(createMockRedis());
            const [fix] = engine.getFixRecommendations([
                { scene: sceneRef(), issue: 'audio_orch_invariant_failed' },
            ]);
            expect(fix.action).to.equal('REVIEW_MANUALLY');
            expect(fix.safeToExecute).to.equal(false);
        });
    });

    // Stage 49: production holds exactly two DONE × dirty scenes
    // (import_1786345731767_1786345734345 / ch-1bb5123c / sc-5f18dd0f and
    // ch-37eadabb / sc-5f0068ca). The combination is reachable BY DESIGN of
    // the writers: audio-orch DONE is terminal (VALID_TRANSITIONS[DONE] = [])
    // and markDirtyScene / markVersionStaleDirty / book-diff only write the
    // per-asset FSM, never the phase record (ORCHESTRATOR_CONVERGENCE_TODO
    // Фаза 4 — "markDirtyScene чистит audio-orch" — was planned HIGH and never
    // implemented). So the check must KEEP reporting it, and reconciliation
    // must KEEP hands-off: the violation's `recommendation: run_completeStage`
    // is dead metadata (never routed into getFixRecommendations) and would be
    // the wrong repair anyway — completing the stage writes READY and erases
    // exactly the dirty marker that schedules the pending regeneration.
    describe('DONE + dirty (stage 49) stays reported and log-only', () => {
        it('audio DONE + pending / generating / failed → audio_orch_invariant_done', async () => {
            for (const state of ['pending', 'generating', 'failed']) {
                const violations = await audioCheck(createMockRedis(), 'DONE', state);
                expect(violations, `DONE orchestrator + asset=${state}`).to.be.an('array').with.length(1);
                expect(violations[0].type).to.equal('audio_orch_invariant_done');
                expect(violations[0].audioState).to.equal(state);
                expect(violations[0].expected).to.equal('READY or PLACEHOLDER');
            }
        });

        it('audio DONE + placeholder → null (allowed terminal outcome)', async () => {
            expect(await audioCheck(createMockRedis(), 'DONE', 'placeholder')).to.be.null;
        });

        it('video DONE + dirty → video_orch_invariant_done (audio mirror)', async () => {
            const violations = await videoCheck(createMockRedis(), 'DONE', 'dirty');
            expect(violations).to.be.an('array').with.length(1);
            expect(violations[0].type).to.equal('video_orch_invariant_done');
            expect(violations[0].videoState).to.equal('dirty');
        });

        it('audio/video *_invariant_done → REVIEW_MANUALLY, safeToExecute=false', () => {
            const engine = mockDeps(createMockRedis());
            for (const issue of ['audio_orch_invariant_done', 'video_orch_invariant_done']) {
                const [fix] = engine.getFixRecommendations([{ scene: sceneRef(), issue }]);
                expect(fix.action, issue).to.equal('REVIEW_MANUALLY');
                expect(fix.safeToExecute, issue).to.equal(false);
            }
        });

        it('no auto-fix path may run for DONE × dirty — the dirty marker must survive reconcile', () => {
            const engine = mockDeps(createMockRedis());
            const fixes = engine.getFixRecommendations([
                { scene: sceneRef(), issue: 'audio_orch_invariant_done' },
                { scene: sceneRef(), issue: 'video_orch_invariant_done' },
            ]);
            expect(fixes.filter(f => f.safeToExecute),
                'auto-applying run_completeStage/mark_dirty here would silently drop the required regeneration')
                .to.have.length(0);
        });
    });

    describe('C1 recovery end state satisfies the invariant and is idempotent', () => {
        it('recovery → FAILED + dirty, invariant clean, second run changes nothing', async () => {
            const redisRef = createMockRedis();
            const assetKey = `animastor:asset-state:${BOOK_ID}:${CHAPTER_ID}:${SCENE_ID}`;
            await redisRef.set(AUDIO_KEY, JSON.stringify({
                phase: 'GENERATING', expected_count: 0, chunks_received: 0,
                build_id: null, started_at: Date.now() - 86400000,
            }));
            await redisRef.hset(assetKey, 'audio', 'pending');

            const engine = mockDeps(redisRef, {
                setFailed: (...args) => realAudioOrch.setFailed(...args),
                // F1 + T6 writers, actually applied: FAILED is written first,
                // then markDirtyScene overwrites it with DIRTY (production C1).
                state: {
                    unsafeRestoreAssetState: async (r, b, c, s, asset, status) => {
                        await r.hset(assetKey, asset, status);
                    },
                },
                getAudioOrchState: async (r, b, c, s) => {
                    const raw = await r.get(`animastor:audio-orch:${b}:${c}:${s}`);
                    return raw ? JSON.parse(raw) : null;
                },
            });
            const orch = {
                markDirtyScene: async (r, b, c, s, assets) => {
                    for (const a of assets) await r.hset(assetKey, a, 'dirty');
                },
            };

            expect(await engine.recoverAudioOrchStates(redisRef, { orchestrator: orch })).to.equal(1);

            const afterFirst = JSON.parse(await redisRef.get(AUDIO_KEY));
            expect(afterFirst.phase).to.equal('FAILED');
            expect(afterFirst.fail_reason).to.equal('restart_recovery');
            expect(await redisRef.hget(assetKey, 'audio'),
                'dirty is what makes the scene re-dispatchable — never cleared by recovery')
                .to.equal('dirty');
            expect(await engine.checkAudioOrchInvariants(redisRef, BOOK_ID, CHAPTER_ID, SCENE_ID),
                'FAILED + dirty must not be reported as a violation').to.be.null;

            // Second run: terminal record skipped, no new writes, no effects.
            expect(await engine.recoverAudioOrchStates(redisRef, { orchestrator: orch })).to.equal(0);
            expect(JSON.parse(await redisRef.get(AUDIO_KEY))).to.deep.equal(afterFirst);
            expect(await redisRef.hget(assetKey, 'audio')).to.equal('dirty');
            expect(await engine.checkAudioOrchInvariants(redisRef, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        });

        it('recovered DONE record keeps asset=ready and stays violation-free', async () => {
            const redisRef = createMockRedis();
            const terminal = {
                phase: 'DONE', expected_count: 3, chunks_received: 3,
                build_id: 'build-terminal', started_at: 1780000000000,
                last_chunk_at: 1780000001000,
            };
            await redisRef.set(AUDIO_KEY, JSON.stringify(terminal));
            await setAssetState(redisRef, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');
            const engine = mockDeps(redisRef, {
                setFailed: (...args) => realAudioOrch.setFailed(...args),
                state: { unsafeRestoreAssetState: async () => { throw new Error('must not write'); } },
                getAudioOrchState: async (r, b, c, s) => {
                    const raw = await r.get(`animastor:audio-orch:${b}:${c}:${s}`);
                    return raw ? JSON.parse(raw) : null;
                },
            });

            expect(await engine.recoverAudioOrchStates(redisRef, { orchestrator: {} })).to.equal(0);
            expect(JSON.parse(await redisRef.get(AUDIO_KEY))).to.deep.equal(terminal);
            expect(await engine.checkAudioOrchInvariants(redisRef, BOOK_ID, CHAPTER_ID, SCENE_ID)).to.be.null;
        });
    });

    describe('the copy under test is the canonical package source', () => {
        it('node_modules/@animastor/orchestration reconciliation-engine matches packages/', function () {
            const fs = require('fs');
            const crypto = require('crypto');
            const canonical = path.resolve(__dirname, '../../packages/animastor-orchestration/src/runtime/reconciliation-engine.js');
            if (!fs.existsSync(canonical)) this.skip(); // post-split checkout: only the npm copy exists
            const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
            expect(sha(RECONCILE_PATH + '.js'), 'tests must exercise the canonical package bytes — sync backend/node_modules')
                .to.equal(sha(canonical));
        });
    });
});
