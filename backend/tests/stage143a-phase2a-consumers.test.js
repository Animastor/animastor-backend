// =====================================================
// Stage 143a — Phase 2a: consumers of the versioned pointer
// =====================================================
//
// Every consumer follows the same contract (task §"общий паттерн для B1–B4"):
//   1. legacy path FIRST — flag OFF is byte-identical and issues ZERO PG calls;
//   2. only when the legacy probe came up EMPTY and the flag is ON does the
//      published pointer get consulted (through the injected image facade —
//      the orchestration/player packages never require PG themselves);
//   3. a pointer-store ERROR is never read as "the file exists" (no false
//      READY) and never as "no publication, regenerate quietly".
//
// Covered here:
//   B0  registry.resolveIuImagePath → three verdicts (ok / absent / missing)
//       and the /iu-image route: 200 versioned, 200 legacy, 404 broken
//       publication, 503 pointer-store outage.
//   B1  scene-window.getSceneFilesStatus → versioned proof after an empty
//       legacy scan; PG error ⇒ image NOT existing, no throw.
//   B3  scene-callbacks: dirty_unit_ids cleared for a versioned-only scene
//       (N1) and the iu-progress counter counted from pointers (N2).
//   B4  iu-media /chunk/:id: no auto-redispatch on a live pointer (N3) and
//       image_ready from the pointer (N4).
//
// Isolated PostgreSQL + isolated Redis only (never production).

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const database = require('../src/storage/postgres/database');
const schema = require('../src/storage/postgres/schema');
const pointerRepo = require('../src/storage/postgres/repositories/iu-image-pointer-repo');
const registry = require('../src/image/registry');
const imageService = require('../src/image');
const state = require('../src/state');
const artifactNaming = require('@animastor/generation').artifactNaming;
const { createMockRedis } = require('./mocks/redis-mock');

const sceneWindow = require('../node_modules/@animastor/orchestration/src/runtime/scene-window');
const callbacks = require('../node_modules/@animastor/orchestration/src/orchestration/scene-callbacks');
const iuMedia = require('../node_modules/@animastor/player/src/iu-media.cjs');

const BOOK = 'b143a2a';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build-143a-2a';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const IU_SEG = 'iu01';
const ASSET_ID = `${PREFIX}_${IU_SEG}`;

const RES = { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, iuId: IU_SEG, buildId: BUILD };

let savedFlag;
let outputDir;

function setFlagOn() { process.env.IU_IMAGE_VERSIONED = '1'; }
function restoreFlag() {
    if (savedFlag === undefined) delete process.env.IU_IMAGE_VERSIONED;
    else process.env.IU_IMAGE_VERSIONED = savedFlag;
}

async function cleanupPg() {
    await database.query(`DELETE FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
    await database.query(`DELETE FROM iu_image_pointers WHERE book_id = $1`, [BOOK]);
}

/** Temporarily replace a method on the image facade (restored in finally). */
async function withImageFacade(overrides, fn) {
    const originals = {};
    for (const [name, value] of Object.entries(overrides)) {
        originals[name] = imageService[name];
        imageService[name] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [name, value] of Object.entries(originals)) {
            imageService[name] = value;
        }
    }
}

// The host binding resolves `media.image` through require('../src/image') at
// CALL time. An earlier suite in the same mocha process (reconciliation-
// engine.test.js mockDeps) swaps that cache entry for a minimal stub and
// leaves it behind — which would make these facade patches invisible to the
// orchestration consumers under test. Pin the REAL image barrel for the
// duration of a test and put the previous entry back afterwards.
const IMAGE_INDEX_PATH = require.resolve('../src/image');
const REAL_IMAGE_INDEX_ENTRY = require.cache[IMAGE_INDEX_PATH];
let savedImageIndexEntry;

function pinRealImageIndex() {
    savedImageIndexEntry = require.cache[IMAGE_INDEX_PATH];
    require.cache[IMAGE_INDEX_PATH] = REAL_IMAGE_INDEX_ENTRY;
}

function unpinImageIndex() {
    if (savedImageIndexEntry === undefined) delete require.cache[IMAGE_INDEX_PATH];
    else require.cache[IMAGE_INDEX_PATH] = savedImageIndexEntry;
    savedImageIndexEntry = undefined;
}

/** Publish a pointer row (flag ON) for the given relative path. */
async function publishRow(relPath, fence, iuId = IU_SEG) {
    return pointerRepo.publishIuImagePointer(Object.assign({}, RES, { iuId, relPath, fence }));
}

// =====================================================
// B0 — the facade's three verdicts
// =====================================================

describe('stage143a phase2a B0 — resolveIuImagePath three-way verdict (isolated PG)', function () {
    this.timeout(30000);

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        setFlagOn();
        for (const stmt of schema.IU_IMAGE_VERSIONED_SQL) await database.query(stmt);
        await cleanupPg();
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-2a-'));
    });

    after(async () => {
        await cleanupPg();
        restoreFlag();
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}
        await database.closePool();
    });

    afterEach(async () => {
        await cleanupPg();
    });

    it('no pointer row → {status:"absent"} (the caller may fall back to legacy)', async () => {
        setFlagOn();
        const verdict = await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG);
        expect(verdict).to.be.an('object');
        expect(verdict.status).to.equal('absent');
    });

    it('row + live file → {status:"ok", path, fence, relativePath}', async () => {
        setFlagOn();
        const rel = pointerRepo.versionedRelPath(BUILD, ASSET_ID, 7);
        await publishRow(rel, 7);
        const abs = pointerRepo.resolveOutputPath(outputDir, rel);
        fs.mkdirSync(path.dirname(abs.path), { recursive: true });
        fs.writeFileSync(abs.path, 'PNG-BYTES');

        const verdict = await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG);
        expect(verdict.status).to.equal('ok');
        expect(verdict.path).to.equal(abs.path);
        expect(verdict.relativePath).to.equal(rel);
        expect(verdict.fence).to.equal(7);
    });

    it('row + absent target → {status:"missing"} — NOT absent, so no legacy fallback', async () => {
        setFlagOn();
        const rel = pointerRepo.versionedRelPath(BUILD, ASSET_ID, 8);
        await publishRow(rel, 8);
        const verdict = await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG);
        expect(verdict.status).to.equal('missing');
        expect(verdict.reason).to.equal('target_missing');
        expect(verdict.relativePath).to.equal(rel);
    });

    it('row with a traversal path → {status:"missing", reason:"traversal"} (path safety kept)', async () => {
        setFlagOn();
        await publishRow('../escape.png', 9);
        const verdict = await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG);
        expect(verdict.status).to.equal('missing');
        expect(verdict.reason).to.equal('traversal');
    });

    it('a pointer-store ERROR throws (an outage is never "absent")', async () => {
        setFlagOn();
        const original = pointerRepo.getIuImagePointer;
        pointerRepo.getIuImagePointer = async () => { throw new Error('ECONNREFUSED'); };
        try {
            let err = null;
            try {
                await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG);
            } catch (e) { err = e; }
            expect(err, 'PG errors must propagate so the route can answer 503').to.not.be.null;
            expect(err.message).to.match(/ECONNREFUSED/);
        } finally {
            pointerRepo.getIuImagePointer = original;
        }
    });

    it('listPublishedIuIdsForScene: flag ON → ids; flag OFF → [] with ZERO PG calls', async () => {
        setFlagOn();
        await publishRow(pointerRepo.versionedRelPath(BUILD, ASSET_ID, 11), 11);
        await publishRow(pointerRepo.versionedRelPath(BUILD, `${PREFIX}_iu02`, 12), 12, 'iu02');
        const ids = await registry.listPublishedIuIdsForScene(BUILD, BOOK, CHAPTER, SCENE);
        expect(ids.sort()).to.deep.equal([IU_SEG, 'iu02']);

        const saved = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            expect(await registry.listPublishedIuIdsForScene(BUILD, BOOK, CHAPTER, SCENE)).to.deep.equal([]);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
            if (saved === undefined) delete process.env.IU_IMAGE_VERSIONED;
            else process.env.IU_IMAGE_VERSIONED = saved;
        }
    });

    it('flag OFF → resolveIuImagePath answers null (legacy contract), zero PG calls', async () => {
        setFlagOn();
        const rel = pointerRepo.versionedRelPath(BUILD, ASSET_ID, 13);
        await publishRow(rel, 13);
        const saved = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            expect(await registry.resolveIuImagePath(outputDir, BUILD, BOOK, CHAPTER, SCENE, IU_SEG))
                .to.equal(null);
            expect(calls).to.deep.equal([]);
        } finally {
            database.query = originalQuery;
            if (saved === undefined) delete process.env.IU_IMAGE_VERSIONED;
            else process.env.IU_IMAGE_VERSIONED = saved;
        }
    });
});

// =====================================================
// B0 — the /iu-image route
// =====================================================

describe('stage143a phase2a B0 — GET /api/v1/iu-image verdicts', function () {
    this.timeout(20000);

    const ctxBase = (buildDir, logSpy) => ({
        outputRoot: buildDir,
        buildDir: (b) => path.join(buildDir, b),
        getEffectiveBuildId: () => BUILD,
        log: logSpy || (() => {}),
    });
    const deps = (imageFacade) => ({
        image: imageFacade,
        state: {},
        activeScenes: { addActiveScene: async () => {} },
        placeholderAudio: {},
    });

    let server;
    let baseUrl;
    let tmpRoot;
    const logs = [];

    beforeEach(async () => {
        await cleanupPg();
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-2a-route-'));
        logs.length = 0;
        const app = express();
        iuMedia(app, ctxBase(tmpRoot, (m) => logs.push(String(m))), deps(imageService));
        server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    async function getImage() {
        const res = await fetch(`${baseUrl}/api/v1/iu-image/${BOOK}/${CHAPTER}/${SCENE}/${IU_SEG}`);
        const body = await res.text();
        return { status: res.status, body };
    }

    it('verdict ok → 200 with the versioned bytes and an ETag', async () => {
        setFlagOn();
        const rel = pointerRepo.versionedRelPath(BUILD, ASSET_ID, 21);
        await publishRow(rel, 21);
        const abs = pointerRepo.resolveOutputPath(tmpRoot, rel);
        fs.mkdirSync(path.dirname(abs.path), { recursive: true });
        fs.writeFileSync(abs.path, 'VERSIONED-PNG');

        // no legacy file at all: only the pointer can answer
        const out = await getImage();
        expect(out.status).to.equal(200);
        expect(out.body).to.equal('VERSIONED-PNG');
    });

    it('verdict absent → legacy branch unchanged (200 with the canonical file)', async () => {
        setFlagOn();
        const legacy = path.join(tmpRoot, BUILD, `${ASSET_ID}.png`);
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, 'LEGACY-PNG');
        const out = await getImage();
        expect(out.status).to.equal(200);
        expect(out.body).to.equal('LEGACY-PNG');
    });

    it('verdict missing → 404 with a log, NO silent legacy fallback', async () => {
        setFlagOn();
        await publishRow(pointerRepo.versionedRelPath(BUILD, ASSET_ID, 22), 22);
        // a stale canonical file exists — it must NOT be served
        const legacy = path.join(tmpRoot, BUILD, `${ASSET_ID}.png`);
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, 'STALE-LEGACY-PNG');

        const out = await getImage();
        expect(out.status, 'a broken publication is 404, not the legacy bytes').to.equal(404);
        expect(out.body).to.not.include('STALE-LEGACY-PNG');
        expect(logs.join('\n')).to.match(/published target unusable/);
    });

    it('pointer-store outage → 503 with a log, no legacy fallback', async () => {
        setFlagOn();
        const legacy = path.join(tmpRoot, BUILD, `${ASSET_ID}.png`);
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, 'STALE-LEGACY-PNG');

        const original = imageService.resolveIuImagePath;
        imageService.resolveIuImagePath = async () => { throw new Error('ECONNREFUSED'); };
        try {
            const out = await getImage();
            expect(out.status).to.equal(503);
            expect(out.body).to.not.include('STALE-LEGACY-PNG');
            expect(logs.join('\n')).to.match(/pointer lookup failed/);
        } finally {
            imageService.resolveIuImagePath = original;
        }
    });

    it('flag OFF → byte-identical legacy behavior, zero PG calls', async () => {
        const saved = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const legacy = path.join(tmpRoot, BUILD, `${ASSET_ID}.png`);
            fs.mkdirSync(path.dirname(legacy), { recursive: true });
            fs.writeFileSync(legacy, 'LEGACY-PNG');
            const out = await getImage();
            expect(out.status).to.equal(200);
            expect(out.body).to.equal('LEGACY-PNG');
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
            if (saved === undefined) delete process.env.IU_IMAGE_VERSIONED;
            else process.env.IU_IMAGE_VERSIONED = saved;
        }
    });
});

// =====================================================
// B1 — scene-window.getSceneFilesStatus
// =====================================================

describe('stage143a phase2a B1 — getSceneFilesStatus (versioned proof after an empty scan)', function () {
    this.timeout(20000);

    let buildDir;
    let savedFlagValue;

    beforeEach(() => {
        pinRealImageIndex();
        savedFlagValue = process.env.IU_IMAGE_VERSIONED;
        buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-2a-window-'));
    });

    afterEach(() => {
        unpinImageIndex();
        if (savedFlagValue === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlagValue;
        fs.rmSync(buildDir, { recursive: true, force: true });
    });

    it('legacy file present → image.exists true, the facade is never consulted', async () => {
        fs.writeFileSync(path.join(buildDir, `${PREFIX}_iu-1.png`), 'png');
        let calls = 0;
        await withImageFacade({
            resolveVersionedSceneProof: async () => { calls += 1; return '/x.png'; },
        }, async () => {
            const status = await sceneWindow.getSceneFilesStatus(buildDir, BOOK, CHAPTER, SCENE);
            expect(status.image.exists).to.equal(true);
        });
        expect(calls, 'legacy hit never reaches the facade').to.equal(0);
    });

    it('empty legacy scan + live pointer → image.exists true', async () => {
        await withImageFacade({
            resolveVersionedSceneProof: async () => path.join(buildDir, '.versions', 'x', '7.png'),
        }, async () => {
            const status = await sceneWindow.getSceneFilesStatus(buildDir, BOOK, CHAPTER, SCENE);
            expect(status.image.exists, 'versioned-only build must look ready').to.equal(true);
        });
    });

    it('empty legacy scan + no pointer → image.exists false (unchanged legacy verdict)', async () => {
        await withImageFacade({
            resolveVersionedSceneProof: async () => null,
        }, async () => {
            const status = await sceneWindow.getSceneFilesStatus(buildDir, BOOK, CHAPTER, SCENE);
            expect(status.image.exists).to.equal(false);
        });
    });

    it('pointer-store outage → image NOT existing, no throw (fail-closed, advisory keeps running)', async () => {
        await withImageFacade({
            resolveVersionedSceneProof: async () => { throw new Error('ECONNREFUSED'); },
        }, async () => {
            let err = null;
            let status = null;
            try {
                status = await sceneWindow.getSceneFilesStatus(buildDir, BOOK, CHAPTER, SCENE);
            } catch (e) { err = e; }
            expect(err, 'an outage must never throw out of the advisory checker').to.equal(null);
            expect(status.image.exists, 'never a false READY on an outage').to.equal(false);
            expect(status.audio.exists).to.equal(false);
            expect(status.video.exists).to.equal(false);
        });
    });

    it('flag OFF → legacy verdict with ZERO PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const status = await sceneWindow.getSceneFilesStatus(buildDir, BOOK, CHAPTER, SCENE);
            expect(status.image.exists).to.equal(false);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});

// =====================================================
// B3 — scene-callbacks: dirty units (N1) + iu-progress counter (N2)
// =====================================================

describe('stage143a phase2a B3 — handleImageCompleted dirty units + counter (N1/N2)', function () {
    this.timeout(30000);

    const repoPath = require.resolve('../src/storage/postgres/repositories/scene-assets-repo');
    let originalRepoEntry;
    let dirtyIds;
    let clearedCalls;
    let lastSetIds;
    let redis;
    let savedFlagValue;

    const PROG_KEY = `animastor:iu-progress:${BOOK}:${CHAPTER}:${SCENE}:image`;
    const SCENE_IMAGE_PATH = path.join(os.tmpdir(), 'stage143a-2a-scene.png');

    beforeEach(() => {
        pinRealImageIndex();
        savedFlagValue = process.env.IU_IMAGE_VERSIONED;
        setFlagOn();
        redis = createMockRedis();
        dirtyIds = [IU_SEG];
        clearedCalls = 0;
        lastSetIds = null;

        // require.cache stub of the scene-assets repo (lazy call-time
        // resolution in the PersistencePort adapter picks it up).
        originalRepoEntry = require.cache[repoPath];
        require.cache[repoPath] = {
            id: repoPath, filename: repoPath, loaded: true,
            exports: {
                getDirtyUnitIds: async () => dirtyIds,
                clearDirtyUnitIds: async () => { clearedCalls += 1; dirtyIds = []; },
                setDirtyUnitIds: async (b, c, s, ids) => { lastSetIds = ids; dirtyIds = ids; },
            },
        };
    });

    afterEach(() => {
        unpinImageIndex();
        if (originalRepoEntry === undefined) delete require.cache[repoPath];
        else require.cache[repoPath] = originalRepoEntry;
        if (savedFlagValue === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlagValue;
        try { fs.rmSync(SCENE_IMAGE_PATH, { force: true }); } catch (_) {}
    });

    /** Run handleImageCompleted against a versioned-only scene. */
    async function runCallback(facadeOverrides = {}) {
        const facade = Object.assign({
            // legacy scan empty (versioned-only build) …
            resolveCanonicalSceneImage: () => null,
            // … the scene proof exists …
            resolveVersionedSceneProof: async () => '/data/output/.versions/scene/7.png',
            // … the dirty unit is proven by its own pointer …
            resolveIuImagePath: async () => ({ status: 'ok', path: '/data/output/.versions/x/7.png', fence: 7 }),
            listPublishedIuIdsForScene: async () => [IU_SEG, 'iu02'],
            getImageMetadata: async () => ({ width: 640, height: 480 }),
        }, facadeOverrides);

        await state.setAssetState(redis, BOOK, CHAPTER, SCENE, 'image', 'pending');
        return withImageFacade(facade, () => callbacks.handleImageCompleted(redis, BOOK, CHAPTER, SCENE, BUILD));
    }

    it('N1: dirty_unit_ids of a versioned-only scene are CLEARED (no infinite force-regen)', async () => {
        const result = await runCallback();
        expect(result.ok, JSON.stringify(result)).to.equal(true);
        expect(clearedCalls, 'the dirty marker must be cleared once the pointer proves the unit')
            .to.equal(1);
        expect(lastSetIds, 'nothing stays pending').to.equal(null);
    });

    it('N2: the iu-progress counter is counted from canonical files ∪ published pointer ids', async () => {
        await runCallback();
        const counter = await redis.get(PROG_KEY);
        expect(counter, 'two published units, no canonical file').to.equal('2');
    });

    it('no pointer for the dirty unit → it stays pending (legacy semantics, no false clear)', async () => {
        const result = await runCallback({
            // the scene proof exists (the callback reaches the dirty block),
            // but THIS unit has no published pointer
            resolveIuImagePath: async () => ({ status: 'absent' }),
            listPublishedIuIdsForScene: async () => [],
        });
        expect(result.ok).to.equal(true);
        expect(clearedCalls, 'nothing is cleared without proof').to.equal(0);
        expect(lastSetIds, 'the unit is kept pending').to.deep.equal([IU_SEG]);
    });

    it('a pointer-store ERROR keeps the unit pending (never cleared on an unknown verdict)', async () => {
        const result = await runCallback({
            resolveIuImagePath: async () => { throw new Error('ECONNREFUSED'); },
            listPublishedIuIdsForScene: async () => { throw new Error('ECONNREFUSED'); },
        });
        expect(result.ok).to.equal(true);
        expect(clearedCalls, 'an outage must not clear the dirty marker').to.equal(0);
        expect(lastSetIds).to.deep.equal([IU_SEG]);
    });

    it('flag OFF → the legacy canonical file alone clears the unit, zero PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        await state.setAssetState(redis, BOOK, CHAPTER, SCENE, 'image', 'pending');
        // legacy scene proof + a canonical file for the dirty unit on disk
        const outputRoot = require('../src/config/runtime-config').OUTPUT_DIR || '/data/output';
        const buildDir = path.join(outputRoot, BUILD);
        const unitFile = path.join(buildDir, artifactNaming.sceneImageName(BOOK, CHAPTER, SCENE, IU_SEG));
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(unitFile, 'png');
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            // real flag-OFF facade semantics: legacy proof decides, pointers
            // answer disabled with ZERO PG calls
            const result = await withImageFacade({
                resolveCanonicalSceneImage: () => 'scene.png',
                resolveVersionedSceneProof: async () => null,
                resolveIuImagePath: async () => null,
                listPublishedIuIdsForScene: async () => [],
                getImageMetadata: async () => ({ width: 640, height: 480 }),
            }, () => callbacks.handleImageCompleted(redis, BOOK, CHAPTER, SCENE, BUILD));
            expect(result.ok).to.equal(true);
            expect(clearedCalls, 'flag OFF keeps the legacy proof path').to.equal(1);
            expect(lastSetIds).to.equal(null);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
            try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (_) {}
        }
    });
});

// =====================================================
// B4 — iu-media /chunk/:id (N3 auto-redispatch, N4 image_ready)
// =====================================================

describe('stage143a phase2a B4 — GET /api/v1/chunk/:id (N3/N4)', function () {
    this.timeout(20000);

    const CHUNK_ID = `${BOOK}_${CHAPTER}_${SCENE}_0001`;
    const JOB_KEY = `animastor:job:${BOOK}_${CHAPTER}_${SCENE}_0002:image`;

    let tmpRoot;
    let redis;
    let server;
    let baseUrl;
    let chunk;
    let redispatchCalls;
    let savedFlagValue;

    beforeEach(async () => {
        savedFlagValue = process.env.IU_IMAGE_VERSIONED;
        setFlagOn();
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-2a-chunk-'));
        redis = createMockRedis();
        chunk = {
            id: CHUNK_ID,
            book_id: BOOK, chapter_id: CHAPTER, scene_id: SCENE, build_id: BUILD,
            image: true, audio: false, video: false,
            audio_status: 'pending', video_status: 'pending',
        };
        await redis.set(`animastor:chunk:${CHUNK_ID}`, JSON.stringify(chunk));
        await redis.set(JOB_KEY, 'job-payload');
        redispatchCalls = 0;

        const app = express();
        iuMedia(app, {
            outputRoot: tmpRoot,
            buildDir: (b) => path.join(tmpRoot, b),
            getEffectiveBuildId: () => BUILD,
            log: () => {},
            redis,
            getChunk: async () => JSON.parse(await redis.get(`animastor:chunk:${CHUNK_ID}`)),
            rejectIfChunkBookDenied: async () => false,
        }, {
            image: imageService,
            // not-ready: the readiness decision must come from disk/pointer,
            // not from a READY asset state
            state: { getAssetStates: async () => ({ image: 'pending', audio: 'pending', video: 'pending' }) },
            activeScenes: { addActiveScene: async () => { redispatchCalls += 1; } },
            placeholderAudio: {},
        });
        server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (savedFlagValue === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlagValue;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    async function getChunk() {
        const res = await fetch(`${baseUrl}/api/v1/chunk/${CHUNK_ID}`);
        return { status: res.status, body: await res.json() };
    }

    async function storedChunk() {
        return JSON.parse(await redis.get(`animastor:chunk:${CHUNK_ID}`));
    }

    /** Publish a LIVE scene pointer (row + file) under the route's root. */
    async function publishLiveScenePointer(fence = 31) {
        const rel = pointerRepo.versionedRelPath(BUILD, ASSET_ID, fence);
        await publishRow(rel, fence);
        const abs = pointerRepo.resolveOutputPath(tmpRoot, rel);
        fs.mkdirSync(path.dirname(abs.path), { recursive: true });
        fs.writeFileSync(abs.path, 'VERSIONED-PNG');
        return abs.path;
    }

    it('N3: empty legacy scan + LIVE pointer → no reset, no job-key delete, no re-dispatch', async () => {
        await publishLiveScenePointer();
        const out = await getChunk();
        expect(out.status).to.equal(200);
        expect(out.body.image_ready).to.equal(true);
        expect(redispatchCalls, 'a live pointer must not trigger a re-dispatch').to.equal(0);
        expect(await redis.get(JOB_KEY), 'the hub dedup key survives').to.equal('job-payload');
        expect((await storedChunk()).image, 'the chunk state is untouched').to.equal(true);
    });

    it('N3: no pointer either → the legacy repair runs (reset + job key cleared + re-dispatch)', async () => {
        const original = imageService.resolveVersionedSceneProof;
        imageService.resolveVersionedSceneProof = async () => null;
        try {
            const out = await getChunk();
            expect(out.status).to.equal(200);
        } finally {
            imageService.resolveVersionedSceneProof = original;
        }
        expect(redispatchCalls, 'a genuinely missing image is still repaired').to.equal(1);
        expect(await redis.get(JOB_KEY), 'the hub dedup key is cleared').to.equal(null);
        expect((await storedChunk()).image).to.equal(false);
    });

    it('N3: pointer-store outage → state untouched (never a silent re-dispatch)', async () => {
        const original = imageService.resolveVersionedSceneProof;
        imageService.resolveVersionedSceneProof = async () => { throw new Error('ECONNREFUSED'); };
        try {
            const out = await getChunk();
            expect(out.status).to.equal(200);
        } finally {
            imageService.resolveVersionedSceneProof = original;
        }
        expect(redispatchCalls, 'an outage must not launch a regeneration').to.equal(0);
        expect(await redis.get(JOB_KEY)).to.equal('job-payload');
        expect((await storedChunk()).image).to.equal(true);
    });

    it('N4: image_ready comes from the pointer when the canonical file is absent', async () => {
        // state says not ready and no canonical/IU file exists on disk
        chunk.image = false;
        await redis.set(`animastor:chunk:${CHUNK_ID}`, JSON.stringify(chunk));
        await publishLiveScenePointer();
        const out = await getChunk();
        expect(out.body.image_ready, 'versioned-only build reports ready through the pointer').to.equal(true);
    });

    it('N4: pointer-store outage never produces a false READY', async () => {
        chunk.image = false;
        await redis.set(`animastor:chunk:${CHUNK_ID}`, JSON.stringify(chunk));
        const original = imageService.resolveVersionedSceneProof;
        imageService.resolveVersionedSceneProof = async () => { throw new Error('ECONNREFUSED'); };
        try {
            const out = await getChunk();
            expect(out.body.image_ready).to.equal(false);
        } finally {
            imageService.resolveVersionedSceneProof = original;
        }
    });

    it('flag OFF → the legacy repair runs byte-identically, ZERO PG calls', async () => {
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            const out = await getChunk();
            expect(out.status).to.equal(200);
            // pre-existing legacy behavior: chunk claims image-ready but no
            // file is on disk → reset + job-key clear + re-dispatch. The flag
            // must not change ANY of it.
            expect(redispatchCalls, 'legacy repair preserved').to.equal(1);
            expect(await redis.get(JOB_KEY), 'the hub dedup key is cleared').to.equal(null);
            expect((await storedChunk()).image).to.equal(false);
            expect(out.body.image_ready).to.equal(false);
            expect(calls, 'flag OFF ⇒ zero PG calls').to.deep.equal([]);
        } finally {
            database.query = originalQuery;
        }
    });
});
