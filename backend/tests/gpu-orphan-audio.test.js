// ======================================================
// Stage 122 — audio orphaned completion marker (audit 121 · N2)
//
// Proven defect (audit 121 · N2): the orphan-marker release added at Stage
// 120 (M-c) existed ONLY in the image path (`iu-processor`). The audio send
// paths had none: an orphaned `animastor:idempotency:done:*` marker (the
// chunk was wiped without releasing it) suppressed the task as
// `already_completed` forever — the dispatch engine deferred it 900 s,
// retried, got the same verdict, and the scene stayed in the active index.
//
// Fix under test (Stage 122 · N2): `generateSceneAudio` (both the MERGED
// pure-dialogue branch and the per-segment branch) now runs the shared
// `releaseTaskDoneIfOrphan` helper — an `already_completed` verdict on the
// SEND path is by construction an ORPHAN (the chunk was probed absent), so
// the marker is freed and the send is retried ONCE.
//
// Isolated: the REAL `backend/src/audio/generation.js` with the provider
// seam, segments/chunks/ffmpeg/validation stubbed (proxyquire) and the REAL
// queue-idempotency helper against an in-memory Redis. The `already_completed`
// verdict is injected (the provider stub answers it) so the release+retry is
// driven deterministically — no hub, no PG, no network.
// ======================================================

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const qidem = require('../src/helpers/queue-idempotency.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK = 'n2audio_book';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build_n2audio';

const PURE_DIALOGUE = [
    { segment_type: 'dialogue', speaker: 'alice', text: 'alice: hello', speaker_name: 'Alice' },
    { segment_type: 'dialogue', speaker: 'bob', text: 'bob: hi', speaker_name: 'Bob' },
];

function sceneData() {
    return { chapter_id: CHAPTER, scene_id: SCENE, scene_type: 'dialogue', payload: { audio: { full_text: 'hello hi' } } };
}
const loadedBook = { chapters: [{ id: CHAPTER, scenes: [{ id: SCENE, segments: [] }] }] };

/**
 * The real audio generation module; the provider seam answers from `script`
 * (a function of the 1-based call index) so a scenario can inject
 * already_completed → sent. `calls` counts provider.generate invocations.
 */
function makeGeneration(script) {
    const providerStub = {
        getConnector: () => ({ nodes: {} }),
        profileNameFromConnector: () => 'qwen-tts',
        loadWorkflow: () => ({ nodes: {} }),
        applyValue: () => {},
        buildJobId: (id, type) => `${id}:${type}`,
        assembleMergedDialogueWorkflow: () => ({ nodes: { merged: true } }),
        generate: async (spec) => script.next(spec),
    };
    const generation = proxyquire('../src/audio/generation', {
        '@animastor/generation': {
            comfyuiProvider: providerStub,
            promptProfiles: { assemblyProfile: { resolveAssembly: () => ({ profileName: 'qwen-tts', type: 'audio', sections: [], defaults: {} }) } },
            artifactNaming: {
                sceneAudioName: () => 'scene.wav',
                sceneAudioPreviewName: () => 'scene.mp3',
                chunkAudioName: () => 'chunk.wav',
                chunkAudioPreviewName: () => 'chunk.mp3',
            },
        },
        '../services/profile-override': { getOverride: () => null },
        './helpers': { log: () => {}, warn: () => {}, error: () => {}, getOutputPath: () => '/tmp/opencode/never-written.wav', sanitizeFileSegment: (s) => s },
        './validation': { isSceneAudioReady: async () => false },
        './chunks': { makeChunkId: () => 'chunk-n2audio', findExistingSceneChunks: () => [] },
        './segments': { buildSegments: () => PURE_DIALOGUE, narratorVoice: () => 'voice' },
        './ffmpeg': { probeDuration: async () => 1, findQuietestPoint: async () => 0, cutFirstHalf: async () => true },
    });
    return { generation, providerStub };
}

/** A scripted provider.generate: yields results in order, then repeats last. */
function script(...results) {
    let i = 0;
    return {
        next: () => results[Math.min(i++, results.length - 1)],
        get calls() { return i; },
    };
}

describe('Stage 122: audio orphaned completion marker (audit 121 · N2)', function () {
    this.timeout(15000);
    let redis;

    beforeEach(() => { redis = createMockRedis(); });

    const AUDIO_JOB = 'chunk-n2audio:audio';

    it('frees the orphaned marker and regenerates the chunk ONCE (merged path)', async () => {
        // ORPHAN: a completion marker survives without its chunk.
        const idemKey = qidem.computeIdemKey({ workspaceId: null, jobId: AUDIO_JOB, jobType: 'audio', buildId: BUILD, params: {}, generationEpoch: 1 });
        await redis.set(qidem.idemDoneKey(idemKey), '1');
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(true);

        // #1 already_completed (orphan) → release + retry → #2 sent.
        const s = script(
            { sent: false, reason: 'already_completed', idem_key: idemKey },
            { sent: true },
        );
        const { generation } = makeGeneration(s);

        const res = await generation.generateSceneAudio(redis, sceneData(), loadedBook, BUILD, BOOK, 'dispatch-a1');

        expect(res.generated).to.equal(true);
        expect(res.chunks).to.equal(1);
        expect(res.reason).to.equal(null);
        // exactly ONE retry (2 provider calls total) — never a loop
        expect(s.calls).to.equal(2);
        // the orphan marker is gone
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(false);
    });

    it('restart recovery: a later dispatch sends first-try once the marker is gone', async () => {
        const idemKey = qidem.computeIdemKey({ workspaceId: null, jobId: AUDIO_JOB, jobType: 'audio', buildId: BUILD, params: {}, generationEpoch: 1 });
        await redis.set(qidem.idemDoneKey(idemKey), '1');

        // dispatch A — orphan released + regenerated.
        const sA = script({ sent: false, reason: 'already_completed', idem_key: idemKey }, { sent: true });
        const { generation: genA } = makeGeneration(sA);
        const rA = await genA.generateSceneAudio(redis, sceneData(), loadedBook, BUILD, BOOK, 'dispatch-restart-1');
        expect(rA.generated).to.equal(true);
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(false);

        // dispatch B (post-restart, fresh in-memory redis is gone but the
        // marker was already freed): the task is NOT suppressed — it sends on
        // the FIRST provider call. No already_completed, no eternal deferral.
        const sB = script({ sent: true });
        const { generation: genB } = makeGeneration(sB);
        const rB = await genB.generateSceneAudio(redis, sceneData(), loadedBook, BUILD, BOOK, 'dispatch-restart-2');
        expect(rB.generated).to.equal(true);
        expect(sB.calls).to.equal(1);
    });

    it('does NOT retry on a non-orphan verdict (duplicate_pending stays bounded)', async () => {
        // A parallel dispatch already claimed the task: the verdict is
        // duplicate_pending, NOT already_completed. The fix must not release
        // anything and must NOT retry — the outcome is a bounded deferral.
        const idemKey = qidem.computeIdemKey({ workspaceId: null, jobId: AUDIO_JOB, jobType: 'audio', buildId: BUILD, params: {}, generationEpoch: 1 });
        const s = script({ sent: false, reason: 'duplicate_pending', idem_key: idemKey });
        const { generation } = makeGeneration(s);

        const res = await generation.generateSceneAudio(redis, sceneData(), loadedBook, BUILD, BOOK, 'dispatch-p1');

        expect(res.generated).to.equal(false);
        expect(res.deferReason).to.equal('duplicate_pending');
        expect(s.calls).to.equal(1); // ONE send attempt, no retry loop
    });

    it('an orphan with NO idem_key is not retried (defensive)', async () => {
        const s = script({ sent: false, reason: 'already_completed' }); // no idem_key
        const { generation } = makeGeneration(s);
        const res = await generation.generateSceneAudio(redis, sceneData(), loadedBook, BUILD, BOOK, 'dispatch-n1');
        expect(res.generated).to.equal(false);
        expect(s.calls).to.equal(1); // no retry without an addressable marker
    });
});
