// ======================================================
// 2026-11-04 — "ready" audio that is silence (ba_1788172242081/sc-4bb85e02)
// ======================================================
// Observed: a 10.85 s silent placeholder (max_volume -91 dB, 87021 bytes) at
// the canonical scene path made every "audio" command answer
//   [AUDIO] findExistingSceneChunks: enumerated 0/1 chunks: []
//   [AUDIO] Audio already ready, no generation needed
//   [PLACEHOLDER-AUDIO] Audio in status stale — updating to ready
//   [ORCH] [COMPLETE-STAGE] … audio → READY
// with worker_id = NULL and zero GPU jobs.
//
// Invariant under test: "already ready" / "already done" are claims about a
// FENCED GPU COMMIT of the current generation. A placeholder of ANY size
// yields neither, and a command for such a scene creates a GPU job.
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proxyquire = require('proxyquire');

const { artifactNaming } = require('@animastor/generation');
const marker = require('../src/audio/placeholder-marker');
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK = 'bk_audio_ready';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build_audio_ready';

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-audio-ready-'));
}

function paths(root) {
    const canonical = path.join(root, BUILD, artifactNaming.sceneAudioName(BOOK, CHAPTER, SCENE));
    const chunk = (i) => path.join(root, BUILD, artifactNaming.sceneChunkAudioName(BOOK, CHAPTER, SCENE, i));
    return { canonical, chunk };
}

function helpersStub(root) {
    return {
        log: () => {},
        warn: () => {},
        error: () => {},
        // getOutputPath(buildId) → <root>/<buildId>; getOutputPath(buildId, name) → <root>/<buildId>/<name>
        getOutputPath: (...args) => (args.length > 1
            ? path.join(root, ...args)
            : path.join(root, args[0])),
        escapeRegExp: (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        sanitizeFileSegment: (s) => s,
    };
}

/** Real validation/chunks/generation wired to a temp artifact root. */
function harness(root, opts = {}) {
    const helpers = helpersStub(root);
    const generationPkg = {
        artifactNaming,
        comfyuiProvider: opts.provider,
        promptProfiles: { assemblyProfile: { resolveAssembly: () => ({ profileName: 'qwen-tts', defaults: { defaultInstruct: '' } }) } },
        mediaRegistry: {},
    };

    const validation = proxyquire('../src/audio/validation', {
        './helpers': helpers,
        '@animastor/generation': generationPkg,
        'music-metadata': { parseFile: async () => ({ format: { duration: 10.848 } }) },
    });
    const chunks = proxyquire('../src/audio/chunks', {
        './helpers': helpers,
        '@animastor/generation': generationPkg,
    });
    const generation = proxyquire('../src/audio/generation', {
        './helpers': helpers,
        './validation': validation,
        './chunks': chunks,
        './segments': {
            buildSegments: () => [{ segment_type: 'narration', text: 'hello', unit_id: 'iu-1' }],
            narratorVoice: () => 'voice',
        },
        './ffmpeg': { probeDuration: async () => 10, findQuietestPoint: async () => 0, cutFirstHalf: async () => true },
        '@animastor/generation': generationPkg,
        '../services/profile-override': { getOverride: () => null },
        '../storage/postgres/repositories/scene-assets-repo': {
            getAsset: async () => (opts.asset === undefined ? { status: 'ready', path: paths(root).canonical } : opts.asset),
        },
        '../state': { getAssetStates: async () => ({ audio: opts.assetState || 'generating' }) },
        '../helpers/queue-idempotency.cjs': { releaseTaskDoneIfOrphan: async () => false },
    });
    return { validation, chunks, generation };
}

function providerSpy(sent = true) {
    const state = { calls: 0 };
    const provider = {
        getConnector: () => ({ nodes: {} }),
        profileNameFromConnector: () => 'qwen-tts',
        loadWorkflow: () => ({ nodes: {} }),
        applyValue: () => {},
        buildJobId: (id, type) => `${id}:${type}`,
        assembleMergedDialogueWorkflow: () => ({ nodes: {} }),
        generate: async () => { state.calls += 1; return { sent, reason: sent ? null : 'no_worker_available' }; },
    };
    return { provider, state };
}

function writeSilentFile(file, bytes = 87021) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 0));
}

describe('audio ready semantics: a placeholder is never "ready"', function () {
    this.timeout(15000);
    let root;
    let redis;

    beforeEach(() => {
        root = tmpRoot();
        redis = createMockRedis();
        writeSilentFile(paths(root).canonical);
    });

    afterEach(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    });

    it('rejects a marked placeholder even when a chunk file exists', async () => {
        const p = paths(root);
        writeSilentFile(p.chunk(1), 2048);
        marker.writePlaceholderMarker(p.canonical, { durationSec: 10.848 });

        const { validation } = harness(root, {});
        const probe = await validation.isSceneAudioCommitted(BUILD, BOOK, CHAPTER, SCENE, 1);

        expect(probe.ready).to.equal(false);
        expect(probe.reason).to.equal('placeholder_marker');
    });

    it('rejects a canonical file with no committed chunk (the 04.11 case)', async () => {
        const { validation } = harness(root, {});
        const probe = await validation.isSceneAudioCommitted(BUILD, BOOK, CHAPTER, SCENE, 1);

        expect(probe.ready).to.equal(false);
        expect(probe.reason).to.equal('no_committed_chunks');
        expect(probe.chunks).to.deep.equal([]);
    });

    it('accepts a scene whose expected chunks are on disk (fenced commit)', async () => {
        const p = paths(root);
        writeSilentFile(p.chunk(1), 49530);
        writeSilentFile(p.chunk(2), 50000);

        const { validation } = harness(root, {});
        const probe = await validation.isSceneAudioCommitted(BUILD, BOOK, CHAPTER, SCENE, 2);

        expect(probe.ready).to.equal(true);
        expect(probe.reason).to.equal('committed');
        expect(probe.chunks).to.deep.equal([1, 2]);
    });

    it('isSceneAudioReady (legacy probe) also refuses a marked placeholder', async () => {
        marker.writePlaceholderMarker(paths(root).canonical, { durationSec: 10.848 });
        const { validation } = harness(root, {});

        expect(await validation.isSceneAudioReady(BUILD, BOOK, CHAPTER, SCENE)).to.equal(false);
    });

    it('dispatches a GPU job for a silent scene with no chunk (no already_ready)', async () => {
        const spy = providerSpy(true);
        const { generation } = harness(root, { provider: spy.provider });

        const result = await generation.generateSceneAudio(
            redis, { chapter_id: CHAPTER, scene_id: SCENE, scene_type: 'narration', payload: {} },
            {}, BUILD, BOOK, 'dispatch-test'
        );

        expect(spy.state.calls).to.equal(1);
        expect(result.generated).to.equal(true);
        expect(result.reason).to.equal(null);

        // The chunk record must not claim audio that no GPU produced.
        const chunkKey = `animastor:chunk:${artifactNaming.iuAssetId(BOOK, CHAPTER, SCENE, '0001')}`;
        const raw = await redis.get(chunkKey);
        if (raw) expect(JSON.parse(raw).audio_status).to.not.equal('ready');
    });

    it('still skips a scene whose audio was committed (normal fast path)', async () => {
        const p = paths(root);
        writeSilentFile(p.chunk(1), 49530);
        const spy = providerSpy(true);
        const { generation } = harness(root, { provider: spy.provider, asset: { status: 'ready', path: p.canonical } });

        const result = await generation.generateSceneAudio(
            redis, { chapter_id: CHAPTER, scene_id: SCENE, scene_type: 'narration', payload: {} },
            {}, BUILD, BOOK, 'dispatch-test'
        );

        expect(spy.state.calls).to.equal(0);
        expect(result.generated).to.equal(false);
        expect(result.reason).to.equal('already_ready');
    });
});

describe('placeholder service: no ready without a fenced commit', function () {
    this.timeout(15000);
    let root;

    beforeEach(() => { root = tmpRoot(); });
    afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

    function loadService(asset, recorder = []) {
        return proxyquire('../src/services/placeholder-audio', {
            '../config/runtime-config': { OUTPUT_DIR: root },
            '../storage/postgres/repositories/scene-assets-repo': {
                getAsset: async () => asset,
                upsertAsset: async (row) => { recorder.push(row); return row; },
            },
            '../storage/postgres/repositories/iu-repo': { getImageUnitsForScene: async () => [{ estimated_duration_sec: '10.8' }] },
            '@animastor/generation': {
                artifactNaming,
                dirtyGrammar: { estimateSpeechDurationSec: () => 10.8 },
            },
            '../audio': {
                generateSilentAudio: async (p) => { writeSilentFile(p, 87021); },
            },
            '../audio/placeholder-marker': marker,
        });
    }

    it('does not register an existing 87 KB file as ready (safety branch removed)', async () => {
        const canonical = paths(root).canonical;
        writeSilentFile(canonical, 87021);
        const recorder = [];
        const service = loadService(null, recorder);

        const res = await service.ensurePlaceholderAudio(BUILD, BOOK, CHAPTER, SCENE);

        expect(res.reason).to.equal('existing_file_untouched');
        expect(recorder.filter((r) => r.status === 'ready')).to.deep.equal([]);
    });

    it('refuses to upgrade a marked placeholder to ready', async () => {
        const canonical = paths(root).canonical;
        writeSilentFile(canonical, 87021);
        marker.writePlaceholderMarker(canonical, { durationSec: 10.848 });
        const recorder = [];
        const service = loadService({ status: 'stale', path: canonical }, recorder);

        const res = await service.replacePlaceholderWithRealAudio(BOOK, CHAPTER, SCENE, BUILD, canonical, 10.848, { committed: true });

        expect(res.replaced).to.equal(false);
        expect(res.reason).to.equal('placeholder_not_ready');
        expect(recorder.map((r) => r.status)).to.deep.equal(['placeholder']);
    });

    it('does not upgrade a stale record without a commit proof', async () => {
        const canonical = paths(root).canonical;
        writeSilentFile(canonical, 87021);
        const recorder = [];
        const service = loadService({ status: 'stale', path: canonical }, recorder);

        const res = await service.replacePlaceholderWithRealAudio(BOOK, CHAPTER, SCENE, BUILD, canonical, 10.848, {});

        expect(res.replaced).to.equal(false);
        expect(res.reason).to.equal('not_committed_from_stale');
        expect(recorder).to.deep.equal([]);
    });

    it('upgrades a stale record only with a verified commit', async () => {
        const canonical = paths(root).canonical;
        writeSilentFile(canonical, 87021);
        const recorder = [];
        const service = loadService({ status: 'stale', path: canonical }, recorder);

        const res = await service.replacePlaceholderWithRealAudio(BOOK, CHAPTER, SCENE, BUILD, canonical, 10.848, { committed: true });

        expect(res.replaced).to.equal(true);
        expect(recorder.map((r) => r.status)).to.deep.equal(['ready']);
    });
});
