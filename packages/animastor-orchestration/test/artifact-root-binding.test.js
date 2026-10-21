// ======================================================
// STAGE 96 — ARTIFACT ROOT BINDING (поведение закрытых литералов)
// ======================================================
// Четыре production-литерала '/data/output' в orchestration-пакете
// (scene-callbacks.js:281,393 · reconciliation-engine.js:124,158)
// переведены на существующий шов artifactRoot (host-bindings, §32.30).
//
// Тесты проверяют ПОВЕДЕНИЕ на свежих исходниках пакета (src/, а не
// npm-копия в backend/node_modules):
//   — путь строится из привязанного корня, а не из литерала;
//   — при корне '/data/output' (контракт сохранённых данных PG/Redis)
//     результирующая строка байт-в-байт равна прежней.
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindHostModules } = require('../src/host/host-bindings');
const { createMockRedis } = require('./mocks/redis-mock');

const engine = require('../src/runtime/reconciliation-engine');
const callbacks = require('../src/orchestration/scene-callbacks');

const BOOK = 'b1';
const CHAPTER = 'ch1';
const SCENE = 'sc1';

let tmpRoot;
let redis;
let currentStates;

const imageStub = {
    resolveCanonicalSceneImage: () => null,
    getImageMetadata: async () => null,
};
const videoStub = {
    validateVideoFile: () => ({ valid: false, duration: null, metadata: null }),
};

const stateStub = {
    AssetState: {
        NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
        GENERATING: 'generating', READY: 'ready',
        FAILED: 'failed', PLACEHOLDER: 'placeholder',
    },
    getAssetStates: async () => ({ audio: 'new', ...currentStates }),
};

const failFast = (name) => () => {
    throw new Error(`[ARTIFACT-ROOT-TEST] ${name} not wired`);
};

function wire(artifactRootValue) {
    bindHostModules({
        state: () => stateStub,
        media: () => ({ audio: {}, image: imageStub, video: videoStub }),
        journal: () => ({ appendSceneEvent: async () => {} }),
        artifactRoot: () => artifactRootValue,
    });
}

describe('Stage 96 — artifactRoot-шов вместо литералов', () => {
    before(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage96-artifact-root-'));
        fs.mkdirSync(path.join(tmpRoot, 'default'), { recursive: true });
        redis = createMockRedis();
        wire(tmpRoot);
    });

    after(() => {
        // Вернуть дефолтный fail-fast, как в test/test-bindings.js
        bindHostModules({
            state: failFast('state'),
            media: failFast('media'),
            journal: failFast('journal'),
            artifactRoot: failFast('artifactRoot'),
        });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    describe('reconciliation-engine — checkOrphanVideoState', () => {
        it('missingFile строится из привязанного корня, а не из литерала', async () => {
            currentStates = { video: 'ready' };
            const res = await engine.checkOrphanVideoState(redis, BOOK, CHAPTER, SCENE);
            expect(res).to.be.an('object');
            expect(res.missingFile).to.equal(`${tmpRoot}/default/${BOOK}_${CHAPTER}_${SCENE}.mp4`);
        });

        it('null, когда файл существует ПОД ПРИВЯЗАННЫМ корнем', async () => {
            const file = path.join(tmpRoot, 'default', `${BOOK}_${CHAPTER}_${SCENE}.mp4`);
            fs.writeFileSync(file, 'x');
            try {
                currentStates = { video: 'ready' };
                expect(await engine.checkOrphanVideoState(redis, BOOK, CHAPTER, SCENE)).to.be.null;
            } finally {
                fs.rmSync(file, { force: true });
            }
        });
    });

    describe('reconciliation-engine — checkOrphanImageState', () => {
        it('resolveCanonicalSceneImage получает привязанный корень', async () => {
            let seenRoot = null;
            imageStub.resolveCanonicalSceneImage = (root) => { seenRoot = root; return null; };
            try {
                currentStates = { image: 'ready' };
                const res = await engine.checkOrphanImageState(redis, BOOK, CHAPTER, SCENE);
                expect(seenRoot).to.equal(tmpRoot);
                expect(res).to.be.an('object');
                expect(res.type).to.equal('orphan_image_state');
            } finally {
                imageStub.resolveCanonicalSceneImage = () => null;
            }
        });
    });

    describe('scene-callbacks — handleVideoCompleted', () => {
        it('validateVideoFile получает путь под привязанным корнем', async () => {
            let seenPath = null;
            videoStub.validateVideoFile = (p) => {
                seenPath = p;
                return { valid: false, duration: null, metadata: null };
            };
            try {
                currentStates = { video: 'generating' };
                const res = await callbacks.handleVideoCompleted(redis, BOOK, CHAPTER, SCENE, 'build1');
                expect(seenPath).to.equal(`${tmpRoot}/build1/${BOOK}_${CHAPTER}_${SCENE}.mp4`);
                expect(res).to.deep.include({ ok: false, retryable: true, reason: 'video_invalid' });
            } finally {
                videoStub.validateVideoFile = () => ({ valid: false, duration: null, metadata: null });
            }
        });
    });

    describe('scene-callbacks — handleImageCompleted', () => {
        it('resolveCanonicalSceneImage получает привязанный корень', async () => {
            let seenRoot = null;
            imageStub.resolveCanonicalSceneImage = (root) => { seenRoot = root; return null; };
            try {
                currentStates = { image: 'generating' };
                const res = await callbacks.handleImageCompleted(redis, BOOK, CHAPTER, SCENE, 'build1');
                expect(seenRoot).to.equal(tmpRoot);
                expect(res).to.deep.include({ ok: false, retryable: true, reason: 'image_not_found' });
            } finally {
                imageStub.resolveCanonicalSceneImage = () => null;
            }
        });
    });

    describe('обратная совместимость (контракт контейнерных путей)', () => {
        it('при корне /data/output строка байт-в-байт равна прежнему литералу', async () => {
            wire('/data/output');
            try {
                let seenPath = null;
                videoStub.validateVideoFile = (p) => {
                    seenPath = p;
                    return { valid: false, duration: null, metadata: null };
                };
                currentStates = { video: 'generating' };
                await callbacks.handleVideoCompleted(redis, BOOK, CHAPTER, SCENE, 'build1');
                // ровно то, что до Stage 96 формировал шаблон
                expect(seenPath).to.equal(`/data/output/build1/${BOOK}_${CHAPTER}_${SCENE}.mp4`);

                currentStates = { video: 'ready' };
                const orphan = await engine.checkOrphanVideoState(redis, BOOK, CHAPTER, SCENE);
                expect(orphan.missingFile).to.equal(`/data/output/default/${BOOK}_${CHAPTER}_${SCENE}.mp4`);
            } finally {
                videoStub.validateVideoFile = () => ({ valid: false, duration: null, metadata: null });
                wire(tmpRoot);
            }
        });
    });
});
