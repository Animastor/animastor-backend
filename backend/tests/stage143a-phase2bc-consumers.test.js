// =====================================================
// Stage 143a — Phase 2b/2c: remaining read-side consumers
// =====================================================
//
// Same contract as Phase 2a (task §"общий паттерн"): the LEGACY path runs
// first; only when it comes up EMPTY and IU_IMAGE_VERSIONED is ON is the
// published pointer consulted (through the injected facade / repo); flag OFF
// is byte-identical with ZERO PG calls; a pointer-store ERROR is never read as
// "file exists" (no false READY) and never as "no publication" (no silent
// regeneration).
//
// Covered consumers:
//   1  redis-helpers.recoverChunksFromDisk — hasIuImages ∪= live pointer
//   3  image/preview.getOrCreatePreview    — versioned source, ok/missing/absent
//   4  task-handler versioned publication  — canonical preview invalidation
//   5  /book/:id/storyboard + repo.listBuildPointerPaths — union, no truncation
//   6  player N6 (cover_iu_ready) + N7 (image_ready)
//
// Isolated PostgreSQL (55432) + isolated Redis (56379) only, never production.

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const AdmZip = require('adm-zip');

const database = require('../src/storage/postgres/database');
const schema = require('../src/storage/postgres/schema');
const pointerRepo = require('../src/storage/postgres/repositories/iu-image-pointer-repo');
const runtimeConfig = require('../src/config/runtime-config');
const imageService = require('../src/image');
const artifactNaming = require('@animastor/generation').artifactNaming;
const qidem = require('../src/helpers/queue-idempotency.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const redisHelpersFactory = require('../src/helpers/redis-helpers.cjs');
const preview = require('../src/image/preview');
const imageHelpers = require('../src/image/helpers');
const exportRoutes = require('../src/routes/book/export-routes.cjs');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const { createMockRedis } = require('./mocks/redis-mock');

// Canonical monorepo sources (clean-clone safe, see monorepo-source-bindings).
const playbackQueue = require('../../packages/animastor-player/src/playback-queue.cjs');
const sceneData = require('../../packages/animastor-player/src/scene-data.cjs');

// Consumer 2 harness — the dirty-regeneration branch runs inside processSingleIU.
const iuProcessor = require('../src/image/iu-processor');
const provider = require('@animastor/generation').comfyuiProvider;
const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
const repositories = require('../src/storage/postgres/repositories');
const { wireProductionSeams } = require('./helpers/wire-seams');

const BOOK = 'b143a2bc';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build-143a-2bc';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const IU_SEG = 'iu01';
const IU_SEG2 = 'iu02';
const ASSET_ID = `${PREFIX}_${IU_SEG}`;
const ASSET_ID2 = `${PREFIX}_${IU_SEG2}`;
const JOB = `${ASSET_ID}:iu_image`;

const RES = { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, iuId: IU_SEG, buildId: BUILD };
const RES2 = Object.assign({}, RES, { iuId: IU_SEG2 });

function setFlagOn() { process.env.IU_IMAGE_VERSIONED = '1'; }
function restoreFlag(saved) {
    if (saved === undefined) delete process.env.IU_IMAGE_VERSIONED;
    else process.env.IU_IMAGE_VERSIONED = saved;
}
async function ensureSchema() {
    for (const stmt of schema.IU_IMAGE_VERSIONED_SQL) await database.query(stmt);
}
async function cleanupPg() {
    await database.query(`DELETE FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
    await database.query(`DELETE FROM iu_image_pointers WHERE book_id = $1`, [BOOK]);
}

let _pngSeq = 0;
async function makePng(filePath, color) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    _pngSeq += 1;
    await sharp({
        create: {
            width: 64 + _pngSeq,
            height: 64 + _pngSeq,
            channels: 3,
            background: color || { r: 10, g: 100, b: 200 },
        },
    }).png().toFile(filePath);
    return fs.readFileSync(filePath);
}

/** Publish a pointer row and drop a live versioned file on disk. */
async function publishLive(root, { res = RES, iuSeg = IU_SEG, fence, bytes }) {
    const rel = pointerRepo.versionedRelPath(BUILD, `${PREFIX}_${iuSeg}`, fence);
    const pub = await pointerRepo.publishIuImagePointer(Object.assign({}, res, { relPath: rel, fence }));
    expect(pub.published, 'pointer published').to.equal(true);
    const abs = pointerRepo.resolveOutputPath(root, rel);
    fs.mkdirSync(path.dirname(abs.path), { recursive: true });
    fs.writeFileSync(abs.path, bytes || 'VERSIONED-' + iuSeg);
    return abs.path;
}

// =====================================================
// Consumer 1 — recoverChunksFromDisk
// =====================================================

describe('stage143a phase2bc — recoverChunksFromDisk versioned proof (isolated PG)', function () {
    this.timeout(30000);

    const scenes = [{ chapter_id: CHAPTER, scene_id: SCENE, scene_order: 1, scene_type: 'narration' }];
    const chunkId = artifactNaming.sceneChunkAudioName(BOOK, CHAPTER, SCENE, 1).replace(/\.mp3$/, '');

    let tmpRoot;
    let savedFlag;
    let savedOutput;

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        savedOutput = runtimeConfig.OUTPUT_DIR;
        await ensureSchema();
        await cleanupPg();
    });
    after(async () => {
        await cleanupPg();
        restoreFlag(savedFlag);
        runtimeConfig.OUTPUT_DIR = savedOutput;
        await database.closePool();
    });
    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-rec-'));
        runtimeConfig.OUTPUT_DIR = tmpRoot;
        await cleanupPg();
    });
    afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    function writeAudio() {
        const dir = path.join(tmpRoot, BUILD);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, artifactNaming.sceneAudioName(BOOK, CHAPTER, SCENE)), 'AUDIO');
        return dir;
    }
    async function recover(redis) {
        const helpers = redisHelpersFactory(redis, { isBookRegistered: async () => true });
        return helpers.recoverChunksFromDisk(BOOK, BUILD, scenes);
    }
    async function imageFlag(redis) {
        return JSON.parse(await redis.get(`animastor:chunk:${chunkId}`)).image;
    }

    it('flag OFF → legacy scan decides the image flag, zero PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        writeAudio();
        const redis = createMockRedis();
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const recovered = await recover(redis);
            expect(recovered).to.deep.equal([chunkId]);
            expect(await imageFlag(redis), 'no IU file on disk → not image-ready').to.equal(false);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });

    it('flag ON: a legacy canonical IU file wins — the pointer is never consulted', async () => {
        setFlagOn();
        const dir = writeAudio();
        fs.writeFileSync(path.join(dir, `${PREFIX}_iu01.png`), 'LEGACY');
        const redis = createMockRedis();
        const originalList = pointerRepo.listScenePointerPaths;
        let pointerCalls = 0;
        pointerRepo.listScenePointerPaths = async (...a) => { pointerCalls += 1; return originalList.apply(pointerRepo, a); };
        try {
            await recover(redis);
            expect(await imageFlag(redis)).to.equal(true);
            expect(pointerCalls, 'legacy hit short-circuits the facade').to.equal(0);
        } finally {
            pointerRepo.listScenePointerPaths = originalList;
        }
    });

    it('flag ON: pointer + live file → image ready (versioned-only build)', async () => {
        setFlagOn();
        writeAudio();
        await publishLive(tmpRoot, { fence: 11, bytes: 'V' });
        const redis = createMockRedis();
        await recover(redis);
        expect(await imageFlag(redis)).to.equal(true);
    });

    it('flag ON: pointer with a MISSING file → NOT ready (never a false READY)', async () => {
        setFlagOn();
        writeAudio();
        await pointerRepo.publishIuImagePointer(Object.assign({}, RES, {
            relPath: pointerRepo.versionedRelPath(BUILD, ASSET_ID, 12), fence: 12,
        }));
        const redis = createMockRedis();
        await recover(redis);
        expect(await imageFlag(redis)).to.equal(false);
    });

    it('flag ON: no pointer → NOT ready', async () => {
        setFlagOn();
        writeAudio();
        const redis = createMockRedis();
        await recover(redis);
        expect(await imageFlag(redis)).to.equal(false);
    });

    it('flag ON: pointer-store ERROR → only the legacy verdict, no throw, no false READY', async () => {
        setFlagOn();
        writeAudio();
        const redis = createMockRedis();
        const originalList = pointerRepo.listScenePointerPaths;
        pointerRepo.listScenePointerPaths = async () => { throw new Error('ECONNREFUSED'); };
        try {
            const recovered = await recover(redis);
            expect(recovered).to.deep.equal([chunkId]);
        } finally {
            pointerRepo.listScenePointerPaths = originalList;
        }
        expect(await imageFlag(redis), 'an outage must never fabricate READY').to.equal(false);
    });
});

// =====================================================
// Consumer 3 — preview.getOrCreatePreview
// =====================================================

describe('stage143a phase2bc — getOrCreatePreview versioned source (isolated PG)', function () {
    this.timeout(30000);

    const previewName = artifactNaming.sceneImagePreviewName(BOOK, CHAPTER, SCENE, IU_SEG);
    let tmpRoot;
    let savedFlag;
    let savedOutput;

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        savedOutput = runtimeConfig.OUTPUT_DIR;
        await ensureSchema();
        await cleanupPg();
    });
    after(async () => {
        await cleanupPg();
        restoreFlag(savedFlag);
        runtimeConfig.OUTPUT_DIR = savedOutput;
        await database.closePool();
    });
    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-prev-'));
        runtimeConfig.OUTPUT_DIR = tmpRoot;
        await cleanupPg();
    });
    afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const previewPath = () => path.join(tmpRoot, BUILD, previewName);

    it('flag OFF: legacy source → preview built, zero PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        await makePng(path.join(tmpRoot, BUILD, `${PREFIX}_iu01.png`));
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
            expect(out).to.not.equal(null);
            expect(out.created).to.equal(true);
            expect(fs.existsSync(out.path)).to.equal(true);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });

    it('flag ON: pointer + live file → preview built from the versioned source, no legacy file', async () => {
        setFlagOn();
        const png = await makePng(path.join(tmpRoot, 'src.png'));
        await publishLive(tmpRoot, { fence: 21, bytes: png });
        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out, 'a live publication must yield a preview').to.not.equal(null);
        expect(out.created).to.equal(true);
        expect(out.path).to.equal(previewPath());
        const meta = await sharp(out.path).metadata();
        expect(meta.width).to.be.at.most(320);
    });

    it('flag ON: pointer with a MISSING target → null (404), no preview written', async () => {
        setFlagOn();
        await pointerRepo.publishIuImagePointer(Object.assign({}, RES, {
            relPath: pointerRepo.versionedRelPath(BUILD, ASSET_ID, 22), fence: 22,
        }));
        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out, 'a broken publication is 404, not a legacy fallback').to.equal(null);
        expect(fs.existsSync(previewPath())).to.equal(false);
    });

    it('flag ON: no pointer + no legacy source → null (absent)', async () => {
        setFlagOn();
        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out).to.equal(null);
    });

    it('flag ON: pointer-store ERROR propagates (the route answers 500)', async () => {
        setFlagOn();
        const original = pointerRepo.getIuImagePointer;
        pointerRepo.getIuImagePointer = async () => { throw new Error('ECONNREFUSED'); };
        let err = null;
        try {
            await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        } catch (e) { err = e; } finally {
            pointerRepo.getIuImagePointer = original;
        }
        expect(err, 'a pointer-store outage must not be silently swallowed').to.not.equal(null);
        expect(err.message).to.match(/ECONNREFUSED/);
    });

    it('flag OFF: a live pointer is INERT — no legacy file → null, zero PG calls', async () => {
        setFlagOn();
        await publishLive(tmpRoot, { fence: 23 });
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
            expect(out).to.equal(null);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });

    // ── FIX: the published pointer must win over a stale legacy source ─────
    async function referencePreview(srcPath, destPath) {
        await sharp(srcPath)
            .resize({ width: imageHelpers.PREVIEW_WIDTH, withoutEnlargement: true })
            .png()
            .toFile(destPath);
        return fs.readFileSync(destPath);
    }

    it('FIX: a stale legacy source does not win — the preview is rebuilt from the versioned bytes', async () => {
        // A legacy canonical source (pre-flag generation) is still on disk…
        const legacySrc = await makePng(path.join(tmpRoot, 'legacy-src.png'), { r: 200, g: 10, b: 10 });
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${PREFIX}_iu01.png`), legacySrc);
        // …and the IU was regenerated in versioned mode (different bytes). The
        // task-handler already deleted the canonical preview of this build.
        setFlagOn();
        const versionedSrc = await makePng(path.join(tmpRoot, 'versioned-src.png'), { r: 10, g: 10, b: 200 });
        await publishLive(tmpRoot, { fence: 41, bytes: versionedSrc });

        const expectedFromVersioned = await referencePreview(path.join(tmpRoot, 'versioned-src.png'), path.join(tmpRoot, 'ref-versioned.png'));
        const expectedFromLegacy = await referencePreview(path.join(tmpRoot, 'legacy-src.png'), path.join(tmpRoot, 'ref-legacy.png'));

        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out).to.not.equal(null);
        expect(out.path).to.equal(previewPath());
        const bytes = fs.readFileSync(out.path);
        expect(bytes.equals(expectedFromVersioned), 'preview built from the new versioned source').to.equal(true);
        expect(bytes.equals(expectedFromLegacy), 'NOT the stale legacy source').to.equal(false);
    });

    it('FIX: a stale preview in ANOTHER build is ignored — the pointer of the requested build wins', async () => {
        const otherBuild = 'build-143a-2bc-other';
        const legacySrc = await makePng(path.join(tmpRoot, 'legacy-src-2.png'), { r: 30, g: 200, b: 30 });
        fs.mkdirSync(path.join(tmpRoot, otherBuild), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, otherBuild, `${PREFIX}_iu01.png`), legacySrc);
        // A stale preview already exists in the OTHER build dir.
        await referencePreview(path.join(tmpRoot, 'legacy-src-2.png'), path.join(tmpRoot, otherBuild, previewName));

        setFlagOn();
        const versionedSrc = await makePng(path.join(tmpRoot, 'versioned-src-2.png'), { r: 60, g: 60, b: 210 });
        await publishLive(tmpRoot, { fence: 42, bytes: versionedSrc });
        const expectedFromVersioned = await referencePreview(path.join(tmpRoot, 'versioned-src-2.png'), path.join(tmpRoot, 'ref-versioned-2.png'));

        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out).to.not.equal(null);
        expect(out.path, 'the requested build, not the other build').to.equal(previewPath());
        expect(out.path.startsWith(path.join(tmpRoot, otherBuild)), 'never the other build preview').to.equal(false);
        expect(fs.readFileSync(out.path).equals(expectedFromVersioned)).to.equal(true);
    });

    it('FIX: a broken (missing) publication is 404 even when a legacy source exists', async () => {
        const legacySrc = await makePng(path.join(tmpRoot, 'legacy-src-3.png'));
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${PREFIX}_iu01.png`), legacySrc);

        setFlagOn();
        await pointerRepo.publishIuImagePointer(Object.assign({}, RES, {
            relPath: pointerRepo.versionedRelPath(BUILD, ASSET_ID, 43), fence: 43,
        }));
        const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(out, 'the broken publication must not fall back to the legacy source').to.equal(null);
        expect(fs.existsSync(previewPath())).to.equal(false);
    });

    it('FIX flag OFF: the legacy source still decides, zero PG calls', async () => {
        setFlagOn();
        await publishLive(tmpRoot, { fence: 44, bytes: await makePng(path.join(tmpRoot, 'versioned-src-4.png'), { r: 5, g: 5, b: 220 }) });
        delete process.env.IU_IMAGE_VERSIONED;

        const legacySrc = await makePng(path.join(tmpRoot, 'legacy-src-4.png'), { r: 220, g: 5, b: 5 });
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${PREFIX}_iu01.png`), legacySrc);
        const expectedFromLegacy = await referencePreview(path.join(tmpRoot, 'legacy-src-4.png'), path.join(tmpRoot, 'ref-legacy-4.png'));

        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const out = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
            expect(out).to.not.equal(null);
            expect(fs.readFileSync(out.path).equals(expectedFromLegacy), 'flag OFF keeps the legacy decision').to.equal(true);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});

// =====================================================
// Consumer 4 — task-handler canonical preview invalidation
// =====================================================

describe('stage143a phase2bc — publication invalidates the canonical preview (isolated PG)', function () {
    this.timeout(40000);

    const previewName = artifactNaming.sceneImagePreviewName(BOOK, CHAPTER, SCENE, IU_SEG);
    let tmpRoot;
    let redis;
    let savedFlag;
    let savedOutput;

    function fenceFor(epoch) {
        return qidem.computeIdemKey({
            workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD,
            params: { '120': { inputs: { seed: 7 } } }, generationEpoch: epoch,
        });
    }
    const FENCE1 = fenceFor(0);
    const FENCE2 = fenceFor(1);

    function withPublish(client) {
        if (typeof client.publish === 'function') return client;
        return new Proxy(client, {
            get(target, prop) {
                if (prop === 'publish') return async () => 0;
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }
    function makeHandler(client) {
        return taskHandlerFactory(client, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, {
            utils: { log: () => {} },
            cleanupService: {
                resolveAssetPath: (jobId, buildId) => ({
                    type: 'iu_image', extension: 'png',
                    fullPath: path.join(tmpRoot, buildId, `${String(jobId).replace(/:iu_image$/, '')}.png`),
                }),
            },
            audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {},
            placeholderAudio: {}, bookDiff: {},
            orchestrator: { completeStage: async () => {} },
            saveIURegistry: async () => {},
            iuRepo: { getImageUnitsForScene: async () => [] },
            getChunk: async () => null,
            saveChunk: async () => {},
        });
    }
    async function seedIntent(client, fence) {
        await client.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), JSON.stringify({
            fence, state: 'active', epoch: '0', supersedes: null, updated_at: Date.now(), history: [],
        }), 'EX', qidem.IDEM_INTENT_TTL_S);
    }
    async function primeDelivery(client, fence) {
        const reserve = await pointerRepo.reserveDispatchFence(Object.assign({ idemKey: fence }, RES));
        expect(reserve.status).to.be.oneOf(['created', 'reused']);
        await seedIntent(client, fence);
        await client.set(qidem.dispatchReceiptKey('d1', JOB), fence, 'EX', qidem.IDEM_RECEIPT_TTL_S);
        await dispatch.setDispatchMetadata(client, BOOK, CHAPTER, SCENE, 'image', {
            dispatch_id: 'd1', stage: 'image', started_at: Date.now(),
            worker: 'scheduler', retry_attempt: 0, status: 'dispatched',
        });
    }
    async function deliver(payload, fence) {
        return makeHandler(redis).handleTaskResult(JOB, payload.toString('base64'), BUILD, 'd1', { fence });
    }

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        savedOutput = runtimeConfig.OUTPUT_DIR;
        setFlagOn();
        await ensureSchema();
        await cleanupPg();
    });
    after(async () => {
        await cleanupPg();
        restoreFlag(savedFlag);
        runtimeConfig.OUTPUT_DIR = savedOutput;
        await database.closePool();
    });
    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-inv-'));
        runtimeConfig.OUTPUT_DIR = tmpRoot;
        redis = withPublish(createMockRedis());
        await cleanupPg();
    });
    afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const previewPath = () => path.join(tmpRoot, BUILD, previewName);

    it('a new publication deletes the stale canonical preview and keeps the immutable file', async () => {
        const v1 = await makePng(path.join(tmpRoot, 'src-v1.png'));
        await primeDelivery(redis, FENCE1);

        // A stale preview from a previous generation sits on disk.
        fs.mkdirSync(path.dirname(previewPath()), { recursive: true });
        fs.writeFileSync(previewPath(), 'STALE-PREVIEW-BYTES');

        const out = await deliver(v1, FENCE1);
        expect(out.versioned).to.equal(true);
        expect(out.published).to.equal(true);

        expect(fs.existsSync(previewPath()), 'the stale preview must be invalidated').to.equal(false);
        const row = await pointerRepo.getIuImagePointer(RES);
        const vfile = pointerRepo.resolveOutputPath(tmpRoot, row.path);
        expect(fs.existsSync(vfile.path), 'the immutable file is never deleted').to.equal(true);
    });

    it('the next /preview rebuilds from the NEW versioned file after a re-publication', async () => {
        const v1 = await makePng(path.join(tmpRoot, 'src-a.png'), { r: 200, g: 10, b: 10 });
        await primeDelivery(redis, FENCE1);
        await deliver(v1, FENCE1);

        const p1 = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(p1.created).to.equal(true);
        const bytes1 = fs.readFileSync(p1.path);

        // A second, distinct generation.
        const v2 = await makePng(path.join(tmpRoot, 'src-b.png'), { r: 10, g: 10, b: 200 });
        await primeDelivery(redis, FENCE2);
        await deliver(v2, FENCE2);
        expect(fs.existsSync(previewPath()), 'the v1 preview is invalidated by the v2 publication').to.equal(false);

        const p2 = await preview.getOrCreatePreview(BOOK, CHAPTER, SCENE, IU_SEG, BUILD);
        expect(p2.created).to.equal(true);
        const bytes2 = fs.readFileSync(p2.path);
        expect(bytes1.equals(bytes2), 'the preview is rebuilt from the new source').to.equal(false);
    });

    it('flag OFF: no invalidation, the legacy canonical preview is left untouched', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const v1 = await makePng(path.join(tmpRoot, 'src-off.png'));
        // Legacy delivery path (fencing off) writes the canonical PNG; a
        // canonical preview is NOT part of the versioned publication.
        await dispatch.setDispatchMetadata(redis, BOOK, CHAPTER, SCENE, 'image', {
            dispatch_id: 'd1', stage: 'image', started_at: Date.now(),
            worker: 'scheduler', retry_attempt: 0, status: 'dispatched',
        });
        fs.mkdirSync(path.dirname(previewPath()), { recursive: true });
        fs.writeFileSync(previewPath(), 'LEGACY-PREVIEW');
        const handler = taskHandlerFactory(redis, {
            OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'off',
        }, {
            utils: { log: () => {} },
            cleanupService: {
                resolveAssetPath: (jobId, buildId) => ({
                    type: 'iu_image', extension: 'png',
                    fullPath: path.join(tmpRoot, buildId, `${String(jobId).replace(/:iu_image$/, '')}.png`),
                }),
            },
            audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {},
            placeholderAudio: {}, bookDiff: {},
            orchestrator: { completeStage: async () => {} },
            saveIURegistry: async () => {},
            iuRepo: { getImageUnitsForScene: async () => [] },
            getChunk: async () => null,
            saveChunk: async () => {},
        });
        await handler.handleTaskResult(JOB, v1.toString('base64'), BUILD, 'd1', {});
        expect(fs.readFileSync(previewPath(), 'utf8'), 'flag OFF keeps the legacy preview').to.equal('LEGACY-PREVIEW');
    });
});

// =====================================================
// Consumer 5 — /storyboard export union + listBuildPointerPaths
// =====================================================

describe('stage143a phase2bc — /book/:id/storyboard union (isolated PG)', function () {
    this.timeout(30000);

    let tmpRoot;
    let server;
    let baseUrl;
    let savedFlag;

    const scenes = [{ chapter_id: CHAPTER, scene_id: SCENE }];

    function makeServer(root) {
        const app = express();
        exportRoutes(app, null, {
            config: { OUTPUT_DIR: root, BOOKS_DIR: path.join(root, 'books') },
            book: {
                loadBook: (id) => (id === BOOK ? { manifest: { build_id: BUILD } } : null),
                collectScenes: () => scenes,
                addDirToZip: () => {},
            },
            audio: {},
            utils: { log: () => {} },
        });
        return new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
    }
    async function fetchStoryboard() {
        const res = await fetch(`${baseUrl}/api/v1/book/${BOOK}/storyboard`);
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, buf };
    }
    function zipEntries(buf) {
        const zip = new AdmZip(buf);
        const map = new Map();
        for (const e of zip.getEntries()) {
            if (e.isDirectory) continue;
            map.set(e.entryName, e.getData());
        }
        return map;
    }

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        await ensureSchema();
        await cleanupPg();
    });
    after(async () => {
        await cleanupPg();
        restoreFlag(savedFlag);
        await database.closePool();
    });
    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-exp-'));
        await cleanupPg();
        server = await makeServer(tmpRoot);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });
    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeLegacy(name, bytes) {
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, name), bytes || 'LEGACY');
    }
    /** Publish a pointer + file WITHOUT going through a reservation. */
    async function publishPointer(iuSeg, fence, bytes) {
        const rel = pointerRepo.versionedRelPath(BUILD, `${PREFIX}_${iuSeg}`, fence);
        await pointerRepo.publishIuImagePointer({
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, iuId: iuSeg, buildId: BUILD,
            relPath: rel, fence,
        });
        const abs = pointerRepo.resolveOutputPath(tmpRoot, rel);
        fs.mkdirSync(path.dirname(abs.path), { recursive: true });
        fs.writeFileSync(abs.path, bytes || 'VERSIONED-' + iuSeg);
    }

    it('flag OFF: legacy-only archive keeps the historical entry names, zero PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        writeLegacy(`${PREFIX}_iu01.png`, 'LEGACY-A');
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const out = await fetchStoryboard();
            expect(out.status).to.equal(200);
            const entries = zipEntries(out.buf);
            expect([...entries.keys()]).to.deep.equal([`${PREFIX}_iu01.png`]);
            expect(entries.get(`${PREFIX}_iu01.png`).toString()).to.equal('LEGACY-A');
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });

    it('flag ON: pointer-only build exports the canonical iu_id.png with versioned bytes', async () => {
        setFlagOn();
        await publishPointer(IU_SEG, 31, 'VERSIONED-BYTES');
        const out = await fetchStoryboard();
        expect(out.status).to.equal(200);
        const entries = zipEntries(out.buf);
        expect([...entries.keys()]).to.deep.equal([`${IU_SEG}.png`]);
        expect(entries.get(`${IU_SEG}.png`).toString()).to.equal('VERSIONED-BYTES');
    });

    it('flag ON: union of legacy + pointers, no duplicate names, pointer wins on collision', async () => {
        setFlagOn();
        writeLegacy(`${PREFIX}_iu01.png`, 'LEGACY-01');
        await publishPointer(IU_SEG, 32, 'POINTER-01');   // same IU as the legacy file
        await publishPointer(IU_SEG2, 33, 'POINTER-02');  // versioned-only IU
        const out = await fetchStoryboard();
        expect(out.status).to.equal(200);
        const entries = zipEntries(out.buf);
        expect([...entries.keys()].sort()).to.deep.equal([`${IU_SEG}.png`, `${IU_SEG2}.png`]);
        expect(entries.get(`${IU_SEG}.png`).toString(), 'pointer wins over legacy').to.equal('POINTER-01');
        expect(entries.get(`${IU_SEG2}.png`).toString()).to.equal('POINTER-02');
    });

    it('flag ON: a pointer with a missing file is skipped; zero files → 404', async () => {
        setFlagOn();
        await pointerRepo.publishIuImagePointer({
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, iuId: IU_SEG, buildId: BUILD,
            relPath: pointerRepo.versionedRelPath(BUILD, ASSET_ID, 34), fence: 34,
        });
        const out = await fetchStoryboard();
        expect(out.status, 'no live storyboard file → existing 404').to.equal(404);
    });

    it('flag ON: pointer-store ERROR → legacy-only export + 404 when legacy is empty (read-only, no false ready)', async () => {
        setFlagOn();
        const originalList = pointerRepo.listBuildPointerPaths;
        pointerRepo.listBuildPointerPaths = async () => { throw new Error('ECONNREFUSED'); };
        try {
            let out = await fetchStoryboard();
            expect(out.status).to.equal(404);
            writeLegacy(`${PREFIX}_iu01.png`, 'LEGACY-ONLY');
            out = await fetchStoryboard();
            expect(out.status).to.equal(200);
            const entries = zipEntries(out.buf);
            expect(entries.get(`${IU_SEG}.png`).toString()).to.equal('LEGACY-ONLY');
        } finally {
            pointerRepo.listBuildPointerPaths = originalList;
        }
    });

    it('flag ON: no silent truncation — every published pointer is exported', async () => {
        setFlagOn();
        const N = 60;
        for (let i = 1; i <= N; i++) {
            const seg = `iu${String(i).padStart(2, '0')}`;
            await publishPointer(seg, 100 + i, `BYTES-${seg}`);
        }
        const out = await fetchStoryboard();
        expect(out.status).to.equal(200);
        const entries = zipEntries(out.buf);
        expect(entries.size, 'all pointers, no LIMIT truncation').to.equal(N);
    });

    it('repo.listBuildPointerPaths: flag OFF → [] with zero PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const rows = await pointerRepo.listBuildPointerPaths({ bookId: BOOK, buildId: BUILD });
            expect(rows).to.deep.equal([]);
            expect(calls).to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});

// =====================================================
// Consumer 6 — player N6 (cover_iu_ready) + N7 (image_ready)
// =====================================================

const COVER_CH = 'ch-cover';
const COVER_SC = 'sc-cover';

function playerImageFacade(overrides = {}) {
    return Object.assign({
        resolveIuImagePath: async () => null,
        resolveVersionedSceneProof: async () => null,
        listPublishedIuIdsForScene: async () => [],
    }, overrides);
}

describe('stage143a phase2bc — N6 cover_iu_ready counts published pointers', function () {
    this.timeout(20000);

    let tmpRoot;
    let server;
    let baseUrl;
    let savedFlag;

    function makeCtx(root, redis) {
        return {
            redis,
            outputRoot: root,
            getChunk: async () => null,
            playerModel: {
                loadBook: () => ({
                    chapters: [{
                        chapter_id: COVER_CH, type: 'cover',
                        scenes: [{ scene_id: COVER_SC, units: [{ id: IU_SEG }, { id: IU_SEG2 }] }],
                    }],
                }),
            },
            iuRepo: {
                getImageUnitsForScene: async (buildId, b, ch, sc) =>
                    (ch === COVER_CH && sc === COVER_SC ? [{ unit_id: IU_SEG }, { unit_id: IU_SEG2 }] : []),
            },
            log: () => {},
        };
    }
    async function makeServer(root, redis, image) {
        const app = express();
        playbackQueue(app, makeCtx(root, redis), {
            getAllChunks: async () => ['c1'],
            getBookWindowStatus: async () => ({}),
            layerConfig: { get: async () => ({ image_enabled: true }) },
            sceneAssetsRepo: {},
            computeIuReady: async () => 0,
            image,
        });
        return new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
    }
    async function start(redis, image) {
        server = await makeServer(tmpRoot, redis, image);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    }
    async function assetsState() {
        const res = await fetch(`${baseUrl}/api/v1/book/${BOOK}/assets-state`);
        return { status: res.status, body: await res.json() };
    }
    async function makeRedis() {
        const redis = createMockRedis();
        // assets-state reads chunk metadata in one round trip; the shared mock
        // does not implement MGET, so provide it here.
        redis.mget = async (keys) => Promise.all(keys.map((k) => redis.get(k)));
        await redis.set('animastor:chunk:c1', JSON.stringify({
            build_id: BUILD, book_id: BOOK, chapter_id: 'ch-main', scene_id: 'sc-main',
            audio_status: 'pending', image_status: 'pending', video_status: 'pending',
        }));
        return redis;
    }

    before(() => { savedFlag = process.env.IU_IMAGE_VERSIONED; });
    after(() => restoreFlag(savedFlag));
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-n6-')); });
    afterEach(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        server = null;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('flag ON + published cover pointers → cover_iu_ready = total (no canonical files)', async () => {
        setFlagOn();
        await start(await makeRedis(), playerImageFacade({
            listPublishedIuIdsForScene: async () => [IU_SEG, IU_SEG2],
        }));
        const out = await assetsState();
        expect(out.status).to.equal(200);
        expect(out.body.cover_iu_total).to.equal(2);
        expect(out.body.cover_iu_ready).to.equal(2);
    });

    it('flag ON + no pointer → cover_iu_ready stays 0', async () => {
        setFlagOn();
        await start(await makeRedis(), playerImageFacade({ listPublishedIuIdsForScene: async () => [] }));
        const out = await assetsState();
        expect(out.body.cover_iu_ready).to.equal(0);
    });

    it('flag ON + pointer-store ERROR → cover NOT ready (no false READY)', async () => {
        setFlagOn();
        await start(await makeRedis(), playerImageFacade({
            listPublishedIuIdsForScene: async () => { throw new Error('ECONNREFUSED'); },
        }));
        const out = await assetsState();
        expect(out.body.cover_iu_ready).to.equal(0);
    });

    it('flag ON + canonical cover files present → ready without consulting pointers', async () => {
        setFlagOn();
        const redis = await makeRedis();
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${BOOK}_${COVER_CH}_${COVER_SC}_iu01.png`), 'x');
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${BOOK}_${COVER_CH}_${COVER_SC}_iu02.png`), 'x');
        let calls = 0;
        await start(redis, playerImageFacade({ listPublishedIuIdsForScene: async () => { calls += 1; return []; } }));
        const out = await assetsState();
        expect(out.body.cover_iu_ready).to.equal(2);
        expect(calls, 'the legacy disk hit short-circuits the facade').to.equal(0);
    });

    it('flag OFF → legacy behavior, zero PG calls (real facade)', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            await start(await makeRedis(), imageService);
            const out = await assetsState();
            expect(out.body.cover_iu_ready).to.equal(0);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});

describe('stage143a phase2bc — N7 scene status image_ready from the pointer', function () {
    this.timeout(20000);

    let tmpRoot;
    let server;
    let baseUrl;
    let savedFlag;

    function makeCtx(root) {
        return {
            outputRoot: root,
            buildDir: (b) => path.join(root, b),
            getEffectiveBuildId: () => BUILD,
            sceneAudioPath: (b, book, ch, sc) => path.join(root, b, artifactNaming.sceneAudioName(book, ch, sc)),
            playerModel: { loadBook: () => ({ chapters: [] }) },
            playerPorts: {},
            iuRepo: {},
            redis: createMockRedis(),
            isBookRegistered: async () => true,
            log: () => {},
        };
    }
    async function start(image) {
        const app = express();
        sceneData(app, makeCtx(tmpRoot), { image, bookProjections: {} });
        server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    }
    async function status() {
        const res = await fetch(`${baseUrl}/api/v1/scene/${BOOK}/${CHAPTER}/${SCENE}/status`);
        return { status: res.status, body: await res.json() };
    }

    before(() => { savedFlag = process.env.IU_IMAGE_VERSIONED; });
    after(() => restoreFlag(savedFlag));
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-n7-')); });
    afterEach(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        server = null;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('flag ON + live published pointer → image_ready true (no canonical file)', async () => {
        setFlagOn();
        await start(playerImageFacade({ resolveVersionedSceneProof: async () => '/data/output/x.png' }));
        const out = await status();
        expect(out.status).to.equal(200);
        expect(out.body.image_ready).to.equal(true);
    });

    it('flag ON + no pointer → image_ready false', async () => {
        setFlagOn();
        await start(playerImageFacade({ resolveVersionedSceneProof: async () => null }));
        const out = await status();
        expect(out.body.image_ready).to.equal(false);
    });

    it('flag ON + pointer-store ERROR → image_ready false (never a false READY)', async () => {
        setFlagOn();
        await start(playerImageFacade({ resolveVersionedSceneProof: async () => { throw new Error('ECONNREFUSED'); } }));
        const out = await status();
        expect(out.body.image_ready).to.equal(false);
    });

    it('flag ON + legacy IU file on disk → ready without consulting the facade', async () => {
        setFlagOn();
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, BUILD, `${PREFIX}_iu01.png`), 'x');
        let calls = 0;
        await start(playerImageFacade({ resolveVersionedSceneProof: async () => { calls += 1; return '/x.png'; } }));
        const out = await status();
        expect(out.body.image_ready).to.equal(true);
        expect(calls).to.equal(0);
    });

    it('flag OFF → legacy verdict, zero PG calls (real facade)', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            await start(imageService);
            const out = await status();
            expect(out.body.image_ready).to.equal(false);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});

// =====================================================
// Consumer 2 — dirty-regeneration cleanup is scoped to canonical names
// =====================================================

describe('stage143a phase2bc — dirty IU regeneration never touches the versioned store', function () {
    this.timeout(30000);

    const UNIT = { id: IU_SEG, text: 'Unit text' };
    const loadedBook = {
        manifest: { book_id: BOOK, build_id: BUILD },
        chapters: [{ chapter_id: CHAPTER, scenes: [{ scene_id: SCENE, units: [UNIT] }] }],
    };

    let tmpRoot;
    let savedOutput;
    let originalGenerate;
    let originalUpsert;

    before(() => {
        savedOutput = runtimeConfig.OUTPUT_DIR;
        originalGenerate = provider.generate;
        originalUpsert = repositories.iu.upsertImageUnit;
        wfLoader.configure({
            workflowsDir: path.join(__dirname, '../ai/workflows'),
            connectorsDir: path.join(__dirname, '../ai/connectors'),
        });
        wfLoader.loadWorkflows();
        wireProductionSeams();
    });
    after(() => {
        provider.generate = originalGenerate;
        repositories.iu.upsertImageUnit = originalUpsert;
        runtimeConfig.OUTPUT_DIR = savedOutput;
    });
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '143a2bc-c2-'));
        runtimeConfig.OUTPUT_DIR = tmpRoot;
        // Keep the test PG-free: metadata persistence is not under test here.
        repositories.iu.upsertImageUnit = async () => {};
    });
    afterEach(() => {
        repositories.iu.upsertImageUnit = originalUpsert;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('deletes the stale canonical PNG + preview but keeps {build}/.versions/** immutable bytes', async () => {
        provider.generate = async (request) => ({ sent: true, jobId: request.jobId });

        const buildDir = path.join(tmpRoot, BUILD);
        const versionsRel = path.join('.versions', 'scene-1', '7.png');
        fs.mkdirSync(path.join(buildDir, path.dirname(versionsRel)), { recursive: true });
        fs.writeFileSync(path.join(buildDir, versionsRel), 'IMMUTABLE-VERSIONED');
        fs.writeFileSync(path.join(buildDir, `${ASSET_ID}.png`), 'STALE-CANONICAL');
        fs.writeFileSync(path.join(buildDir, `${PREFIX}_pr01.png`), 'STALE-PREVIEW');

        const sceneData = { payload: { units: [UNIT] }, chapter: {} };
        const out = await iuProcessor.processSingleIU(
            createMockRedis(), UNIT, 0, sceneData, loadedBook, BUILD,
            BOOK, CHAPTER, SCENE, 0, 'Unit text', new Set([IU_SEG]), 'dispatch-c2');

        expect(out.sent).to.equal(true);
        expect(fs.existsSync(path.join(buildDir, versionsRel)), 'the immutable versioned file must survive').to.equal(true);
        expect(fs.readFileSync(path.join(buildDir, versionsRel), 'utf8')).to.equal('IMMUTABLE-VERSIONED');
        expect(fs.existsSync(path.join(buildDir, `${ASSET_ID}.png`)), 'old canonical PNG removed').to.equal(false);
        expect(fs.existsSync(path.join(buildDir, `${PREFIX}_pr01.png`)), 'old canonical preview removed').to.equal(false);
    });
});
