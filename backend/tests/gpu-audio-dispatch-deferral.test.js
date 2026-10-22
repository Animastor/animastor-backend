// ======================================================
// Stage 118 — audio dispatch deferral classification (audit 117 · B3/M3/M5)
//
// The capacity deferral only works when the executor REPORTS WHY nothing
// was enqueued. The Stage 116 implementation computed that reason inside
// `sendPerSegmentAudio` only — the MERGED (pure-dialogue) branch filled the
// reason map but never classified it, so a pure-dialogue scene reported the
// generic 'no_jobs_generated' and kept the 5-second dispatch/cancel/rollback
// loop the deferral was built to remove.
//
// Isolated: the real `backend/src/audio/generation.js` with a stubbed
// provider seam, stubbed segments/validation/chunks and an in-memory Redis.
// No production Redis/PG, no hub, no network.
// ======================================================

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const BOOK = 'test-stage118-book';
const CHAPTER = 'ch-stage118';
const SCENE = 'sc-stage118';
const BUILD = 'build_test-stage118-book';

function makeRedis() {
    const strings = new Map();
    return {
        set: async (key, value, ...args) => {
            let nx = false;
            for (const a of args) if (String(a).toUpperCase() === 'NX') nx = true;
            if (nx && strings.has(key)) return null;
            strings.set(key, String(value));
            return 'OK';
        },
        get: async (key) => (strings.has(key) ? strings.get(key) : null),
        del: async (...keys) => { let n = 0; for (const k of keys.flat()) if (strings.delete(k)) n++; return n; },
        sadd: async () => 1,
        srem: async () => 1,
    };
}

/**
 * The real audio generation module with the provider seam stubbed.
 * @param {object} sendResult - what provider.generate() answers.
 * @param {Array}  segments   - the segments of the scene.
 */
function makeGeneration({ sendResult, segments }) {
    const providerStub = {
        getConnector: () => ({ nodes: {} }),
        profileNameFromConnector: () => 'qwen-tts',
        loadWorkflow: () => ({ nodes: {} }),
        applyValue: () => {},
        buildJobId: (id, type) => `${id}:${type}`,
        assembleMergedDialogueWorkflow: () => ({ nodes: { merged: true } }),
        generate: async () => sendResult,
    };
    return proxyquire('../src/audio/generation', {
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
        './helpers': {
            log: () => {}, warn: () => {}, error: () => {},
            getOutputPath: () => '/tmp/opencode/never-written.wav',
            sanitizeFileSegment: (s) => s,
        },
        './validation': { isSceneAudioReady: async () => false },
        './chunks': { makeChunkId: () => 'chunk-0001' },
        './segments': { buildSegments: () => segments, narratorVoice: () => 'voice' },
        './ffmpeg': { probeDuration: async () => 1, findQuietestPoint: async () => 0, cutFirstHalf: async () => true },
    });
}

const PURE_DIALOGUE = [
    { segment_type: 'dialogue', speaker: 'alice', text: 'alice: hello', speaker_name: 'Alice' },
    { segment_type: 'dialogue', speaker: 'bob', text: 'bob: hi', speaker_name: 'Bob' },
];
const MIXED = [
    { segment_type: 'narration', speaker: 'narrator', text: 'once upon a time', speaker_name: 'Narrator' },
    { segment_type: 'dialogue', speaker: 'alice', text: 'alice: hello', speaker_name: 'Alice' },
];

function sceneData() {
    return {
        chapter_id: CHAPTER, scene_id: SCENE, scene_type: 'dialogue',
        payload: { audio: { full_text: 'hello hi' } },
    };
}
const loadedBook = { chapters: [{ id: CHAPTER, scenes: [{ id: SCENE, segments: [] }] }] };

describe('Stage 118: audio dispatch deferral classification (audit 117 · B3)', () => {
    it('B3: the MERGED (pure-dialogue) path reports WHY nothing was enqueued', async () => {
        const generation = makeGeneration({
            sendResult: { sent: false, reason: 'no_worker_available', error: 'no live worker' },
            segments: PURE_DIALOGUE,
        });
        const res = await generation.generateSceneAudio(
            makeRedis(), sceneData(), loadedBook, BUILD, BOOK, 'dispatch-1'
        );
        expect(res.generated).to.equal(false);
        expect(res.reason).to.equal('no_jobs_accepted');
        // the merged path used to leave the reason EMPTY ⇒ the orchestrator
        // fell back to 'no_jobs_generated' ⇒ no deferral ⇒ a 5 s retry loop
        expect(res.deferReason).to.equal('no_worker_available');
    });

    it('B3: the per-segment (mixed) path reports the same classification', async () => {
        const generation = makeGeneration({
            sendResult: { sent: false, reason: 'no_worker_available', error: 'no live worker' },
            segments: MIXED,
        });
        const res = await generation.generateSceneAudio(
            makeRedis(), sceneData(), loadedBook, BUILD, BOOK, 'dispatch-1'
        );
        expect(res.generated).to.equal(false);
        expect(res.deferReason).to.equal('no_worker_available');
    });

    it('M5: an AMBIGUOUS post outcome travels as its own reason', async () => {
        const generation = makeGeneration({
            sendResult: { sent: false, reason: 'ambiguous_post', error: 'timeout', ambiguous: true },
            segments: PURE_DIALOGUE,
        });
        const res = await generation.generateSceneAudio(
            makeRedis(), sceneData(), loadedBook, BUILD, BOOK, 'dispatch-1'
        );
        expect(res.deferReason).to.equal('ambiguous_post');
    });

    it('M3: a REAL failure keeps the historic semantics (no deferral)', async () => {
        const generation = makeGeneration({
            sendResult: { sent: false, error: 'connector exploded' },
            segments: PURE_DIALOGUE,
        });
        const res = await generation.generateSceneAudio(
            makeRedis(), sceneData(), loadedBook, BUILD, BOOK, 'dispatch-1'
        );
        expect(res.generated).to.equal(false);
        expect(res.deferReason).to.equal(null);
    });

    it('a successful send carries no deferral reason', async () => {
        const generation = makeGeneration({
            sendResult: { sent: true },
            segments: PURE_DIALOGUE,
        });
        const res = await generation.generateSceneAudio(
            makeRedis(), sceneData(), loadedBook, BUILD, BOOK, 'dispatch-1'
        );
        expect(res.generated).to.equal(true);
        expect(res.deferReason).to.equal(null);
    });
});
