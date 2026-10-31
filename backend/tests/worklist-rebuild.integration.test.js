// ======================================================
// Option E — asset-state rebuild integration test (real PG + real FS)
// ======================================================
// Cathedral Recon #4 design proof → implementation, REVISED for command-only
// generation (2026-10-31, animastor-docs architecture/COMMAND_ONLY_GENERATION.md).
// After a total Redis loss the startup reconcileCycle phase C8:
//   - materializes per-asset Redis FACTS from PG + FS (NOT trusting Redis):
//     READY for a proven file, DIRTY (stale marker) for READY-without-file
//     and for an outdated/flagged artifact;
//   - creates NO work: never writes PENDING, never SADDs the active index
//     (formerly it re-queued interrupted generation — a start without a
//     command);
//   - skips cancelled (tombstoned) books fail-closed;
//   - leaves disabled layers, GENERATING/PENDING and PLACEHOLDER untouched.
// The scheduler dispatches only stages of an active task-registry task
// (verified via shouldScheduleAssets).

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');
// NOTE: these are `let` and re-required inside before() AFTER purgeMockedModules().
// Earlier test files (happy-path.test.js replaces the config module in
// require.cache with a stub; scope-slide.test.js deletes it entirely) leave
// require.cache in a state where the module instances captured at top-level
// load time are NOT the instances Phase C7's lazy requires will get at call
// time. Re-requiring here binds the test to the SAME instances the real
// rebuildWorkList uses, so config.BOOKS_DIR/OUTPUT_DIR mutations are visible.
let config = require('../src/config/runtime-config');
let postgres = require('../src/storage/postgres');
let reconciliation = require('../node_modules/@animastor/orchestration/src/runtime/reconciliation-engine');
let runtimeScheduler = require('../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler');
let state = require('../src/state');
let generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');

// ── require.cache purge (runs in before(), see below) ──
// reconciliation-engine.test.js (alphabetically earlier: 'r' < 'w') replaces
// these modules in require.cache with mocks in mockDeps() (per-test beforeEach)
// and never restores them. Mocha loads ALL test files BEFORE running any tests,
// so a top-level purge would be a no-op — the mocks are installed only when the
// other suite actually runs. Purging in our before() hook (which executes AFTER
// that suite finished) makes the real modules load again for Phase C7's lazy
// requires, so storage.postgres.query and state are the real ones.
// ⚠️ ORDER-DEPENDENT ISOLATION WORKAROUND — read before adding test files.
// This file sorts alphabetically LAST among today's tests ('w' > 'v'). The purge
// below is safe ONLY because no test file loads after this one. If a new file is
// added that sorts later, deleting src/config/runtime-config.js here would change
// what that later file loads. The durable fix is in happy-path.test.js and
// scope-slide.test.js (restore require.cache[runtime-config] after stubbing) —
// revisit this workaround if the test corpus grows past 'w'.
//
// Why the purge exists: happy-path.test.js (alphabetically earlier) temporarily
// replaces require.cache for src/config/runtime-config with a stub; any module
// first required inside that window captures the STUB as its module-scope
// `config` const — and restoring the cache entry does NOT undo that captured
// reference. book/scene-window then read a stale BOOKS_DIR/OUTPUT_DIR forever.
// scope-slide.test.js additionally DELETES runtime-config from the cache, so the
// module instances captured at this file's top-level load time are not the ones
// Phase C7's lazy requires get at call time. Purging + re-binding here makes the
// test use the SAME instances rebuildWorkList uses, so config mutations apply.
const MOCKED_PATHS = [
    'src/state/index.js',
    'src/storage/index.js',
    'src/image/index.js',
    'src/services/audio-orchestrator.js',
    'src/orchestration/orchestrator.js',
    'src/state/event-journal.js',
    'src/runtime/reconciliation-engine.js',
    'src/runtime/runtime-scheduler.js',
    'src/book/index.js',
    'src/runtime/scene-window.js',
    'src/services/layer-config.js',
    'src/services/placeholder-audio.js',
    'src/config/runtime-config.js',
];
function purgeMockedModules() {
    for (const rel of MOCKED_PATHS) {
        try {
            delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
        } catch (_) { /* not in cache */ }
    }
}

const CHAPTER = 'ch-000001';
const SCENE = 'sc-000001';

const TEST_BOOKS = ['wl-half', 'wl-valid', 'wl-cancelled', 'wl-disabled', 'wl-stale', 'wl-gen', 'wl-c0', 'wl-units', 'wl-failed', 'wl-pending', 'wl-toc'];

async function insertScene(bookId, chapterId = CHAPTER, sceneId = SCENE, contentVersion = 1, audioCfgVersion = 1, dirtyUnitIds = null, isDirty = false) {
    await postgres.query(
        `INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, is_dirty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING`,
        [bookId, chapterId, sceneId, contentVersion, audioCfgVersion, dirtyUnitIds || [], isDirty]
    );
}

async function insertAsset(bookId, assetType, { status = 'ready', buildId = 'b1', contentVersion = 1, audioCfgVersion = 1 } = {}) {
    await postgres.query(
        `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status, path, build_id,
                                   scene_content_version, scene_audio_config_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET status = EXCLUDED.status`,
        [bookId, CHAPTER, SCENE, assetType, status, `/tmp/x/${bookId}_${CHAPTER}_${SCENE}.${assetType === 'image' ? 'png' : assetType === 'video' ? 'mp4' : 'mp3'}`, buildId,
         contentVersion, audioCfgVersion]
    );
}

describe('Option E — asset-state rebuild through real reconcileCycle (real PG + FS)', function () {
    this.timeout(30000);

    let tmpBooks;
    let tmpOut;
    let savedBooksDir;
    let savedOutDir;
    let redis;

    before(async () => {
        purgeMockedModules(); // must run AFTER the mocking test-suite finished
        // Re-bind every module the test uses to the fresh instances that Phase C7
        // will lazily require — see the top-of-file comment.
        config = require('../src/config/runtime-config');
        postgres = require('../src/storage/postgres');
        reconciliation = require('../node_modules/@animastor/orchestration/src/runtime/reconciliation-engine');
        runtimeScheduler = require('../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler');
        state = require('../src/state');
        generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');
        // Re-bind the booksRoot port to THIS (post-purge) config instance so
        // book-domain path getters follow config.BOOKS_DIR mutations below.
        // (books-root.js itself is not purged — its binding would otherwise
        // still close over the pre-purge config instance.)
        require('@animastor/vbook-runtime/books-root').configureBooksRoot(() => config.BOOKS_DIR);
        // S-5: re-bind production seams after the purge — rebuildWorkList
        // resolves the FSM writers through the seam registry, and the previous
        // suite may have left stub wiring behind.
        require('./helpers/wire-seams').wireProductionSeams();
        await postgres.initialize();
    });

    beforeEach(() => {
        tmpBooks = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-wl-books-'));
        tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-wl-out-'));
        savedBooksDir = config.BOOKS_DIR;
        savedOutDir = config.OUTPUT_DIR;
        config.BOOKS_DIR = tmpBooks;
        config.OUTPUT_DIR = tmpOut;
        redis = createMockRedis();
    });

    afterEach(async () => {
        for (const bookId of TEST_BOOKS) {
            await postgres.query('DELETE FROM generation_cancellations WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM scenes WHERE book_id = $1', [bookId]);
        }
        config.BOOKS_DIR = savedBooksDir;
        config.OUTPUT_DIR = savedOutDir;
        fs.rmSync(tmpBooks, { recursive: true, force: true });
        fs.rmSync(tmpOut, { recursive: true, force: true });
    });

    function writeBook(bookId, buildId = 'b1') {
        const bookDir = path.join(tmpBooks, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, build_id: buildId }));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            structure: { chapters_order: [`${CHAPTER}.json`] },
        }));
        fs.writeFileSync(path.join(bookDir, 'chapters', `${CHAPTER}.json`), JSON.stringify({
            chapter_id: CHAPTER,
            scenes: [{ scene_id: SCENE, type: 'narration' }],
        }));
        return bookDir;
    }

    function writeArtifact(bookId, kind) {
        const buildDir = path.join(tmpOut, 'b1');
        fs.mkdirSync(buildDir, { recursive: true });
        const files = {
            audio: `${bookId}_${CHAPTER}_${SCENE}.mp3`,
            image: `${bookId}_${CHAPTER}_${SCENE}_iu-000001.png`,
            video: `${bookId}_${CHAPTER}_${SCENE}.mp4`,
        };
        fs.writeFileSync(path.join(buildDir, files[kind]), 'x');
    }

    async function assetStates(bookId) {
        return state.getAssetStates(redis, bookId, CHAPTER, SCENE);
    }

    const activeScenes = async () => redis.smembers('animastor:active-scenes');

    it('half-generated scene: audio fact restored READY, missing image/video stay NEW, nothing queued', async () => {
        writeBook('wl-half');
        writeArtifact('wl-half', 'audio');
        await insertScene('wl-half');
        await insertAsset('wl-half', 'audio', { status: 'ready' }); // real audio (PG ready)

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.phases).to.include('asset_state_rebuild:1');
        expect(await activeScenes()).to.deep.equal([]); // command-only: no work

        const states = await assetStates('wl-half');
        expect(states.audio).to.equal('ready'); // valid on disk — fact restored
        expect(states.image).to.equal('new');   // missing — NOT queued
        expect(states.video).to.equal('new');
    });

    it('C8 is idempotent — a second startup cycle changes nothing', async () => {
        writeBook('wl-half');
        writeArtifact('wl-half', 'audio');
        await insertScene('wl-half');
        await insertAsset('wl-half', 'audio', { status: 'ready' });

        await reconciliation.reconcileCycle(redis, {}, { startup: true });
        const states1 = await assetStates('wl-half');

        const result2 = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result2.ok).to.be.true;
        expect(result2.phases.some(p => p.startsWith('asset_state_rebuild:'))).to.equal(false);
        expect(await activeScenes()).to.deep.equal([]);
        expect(await assetStates('wl-half')).to.deep.equal(states1);
    });

    it('fully-valid scene: facts restored READY, nothing queued', async () => {
        writeBook('wl-valid');
        writeArtifact('wl-valid', 'audio');
        writeArtifact('wl-valid', 'image');
        writeArtifact('wl-valid', 'video');
        await insertScene('wl-valid');
        await insertAsset('wl-valid', 'audio');
        await insertAsset('wl-valid', 'image');
        await insertAsset('wl-valid', 'video');

        await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(await activeScenes()).to.deep.equal([]);
        const states = await assetStates('wl-valid');
        expect([states.audio, states.image, states.video]).to.deep.equal(['ready', 'ready', 'ready']);
    });

    it('cancelled (tombstoned) book is skipped fail-closed — untouched', async () => {
        writeBook('wl-cancelled');
        await insertScene('wl-cancelled');
        await generationCancelRepo.setCancelled('wl-cancelled', { reason: 'user_cancelled' });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.phases.some(p => p.startsWith('asset_state_rebuild:'))).to.equal(false);
        expect(await activeScenes()).to.deep.equal([]);
        expect((await assetStates('wl-cancelled')).audio).to.equal('new');
    });

    it('disabled layer untouched; without a command the scheduler dispatches nothing; with an audio command — audio only', async () => {
        writeBook('wl-disabled'); // no artifacts at all
        await insertScene('wl-disabled');
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));

        await reconciliation.reconcileCycle(redis, {}, { startup: true });

        const states = await assetStates('wl-disabled');
        expect([states.audio, states.image, states.video]).to.deep.equal(['new', 'new', 'new']);
        expect(await activeScenes()).to.deep.equal([]);

        let plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.deep.equal([]); // no command → no work

        await require('../src/services/generation-progress').createTasks(redis, 'wl-disabled', ['audio', 'image'],
            { scope: 'current_scene', chapterId: CHAPTER, sceneId: SCENE }, [{ chapter_id: CHAPTER, scene_id: SCENE }]);
        plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.deep.equal(['audio']); // image task exists but the layer is OFF
    });

    it('version-stale artifact is marked stale (DIRTY), not queued', async () => {
        writeBook('wl-stale');
        writeArtifact('wl-stale', 'audio'); // file exists, but PG says content_version bumped
        await insertScene('wl-stale', CHAPTER, SCENE, 2, 1);
        await insertAsset('wl-stale', 'audio', { status: 'ready', contentVersion: 1 });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.phases).to.include('asset_state_rebuild:1');
        expect((await assetStates('wl-stale')).audio).to.equal('dirty');
        expect(await activeScenes()).to.deep.equal([]);
    });

    // ── Audit gap 1: safe state materialization ────────────────────────────
    it('GENERATING stage is NEVER touched by the rebuild', async () => {
        writeBook('wl-gen');
        writeArtifact('wl-gen', 'audio');
        await insertScene('wl-gen');
        await insertAsset('wl-gen', 'audio', { status: 'ready' });
        await redis.hset('animastor:asset-state:wl-gen:ch-000001:sc-000001', 'image', 'generating');
        await redis.set('animastor:dispatch-lease:wl-gen:ch-000001:sc-000001:image', 'tok-live', 'EX', 3600);
        await redis.set('animastor:dispatch-meta:wl-gen:ch-000001:sc-000001:image',
            JSON.stringify({ dispatch_id: 'wl-gen-live', stage: 'image', lease_token: 'tok-live' }));

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-gen');
        expect(states.image).to.equal('generating');
        expect(states.audio).to.equal('ready');
        expect(states.video).to.equal('new'); // missing — NOT queued
        expect(await activeScenes()).to.deep.equal([]);
    });

    it('C0 over-mark (READY with no file) becomes a stale marker READY→DIRTY, not queued', async () => {
        writeBook('wl-c0');
        writeArtifact('wl-c0', 'audio');
        await insertScene('wl-c0');
        await insertAsset('wl-c0', 'audio', { status: 'ready' });
        await redis.hset('animastor:asset-state:wl-c0:ch-000001:sc-000001',
            { audio: 'ready', image: 'ready', video: 'ready' });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        const states = await assetStates('wl-c0');
        expect(states.image).to.equal('dirty');
        expect(states.video).to.equal('dirty');
        expect(states.audio).to.equal('ready');
        expect(await activeScenes()).to.deep.equal([]);
    });

    it('TOCTOU: concurrent tick dispatching image between guard-read and write is NEVER overwritten (fresh-state check)', async () => {
        writeBook('wl-toc');
        writeArtifact('wl-toc', 'audio');
        await insertScene('wl-toc');
        await insertAsset('wl-toc', 'audio', { status: 'ready' });
        await redis.hset('animastor:asset-state:wl-toc:ch-000001:sc-000001',
            { audio: 'ready', image: 'ready', video: 'ready' });

        const origGet = state.getAssetStates;
        let guardRead = false;
        state.getAssetStates = async (...args) => {
            const [r, bookId, chapterId, sceneId] = args;
            const res = await origGet.apply(state, args);
            if (bookId === 'wl-toc') {
                if (!guardRead) {
                    guardRead = true;
                } else {
                    await redis.hset(`animastor:asset-state:${bookId}:${chapterId}:${sceneId}`, 'image', 'generating');
                    return { ...res, image: 'generating' };
                }
            }
            return res;
        };

        try {
            const touched = await reconciliation.rebuildWorkList(redis);
            expect(touched).to.equal(1);
            const states = await origGet.apply(state, [redis, 'wl-toc', CHAPTER, SCENE]);
            expect(states.image).to.equal('generating'); // the in-flight owner won
            expect(states.video).to.equal('dirty');      // stale marker only
            expect(states.audio).to.equal('ready');
            expect(await activeScenes()).to.deep.equal([]);
        } finally {
            state.getAssetStates = origGet;
        }
    });

    it('PLACEHOLDER audio with NO real file stays PLACEHOLDER (placeholder scenes are not queued)', async () => {
        writeBook('wl-c0');
        await insertScene('wl-c0');
        await redis.hset('animastor:asset-state:wl-c0:ch-000001:sc-000001', 'audio', 'placeholder');

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect((await assetStates('wl-c0')).audio).to.equal('placeholder');
        expect(await activeScenes()).to.deep.equal([]);
    });

    // ── Audit gap 2: dirty markers become stale markers (not work) ─────────
    it('dirty_unit_ids marks the existing image stale (DIRTY) despite a valid-looking file', async () => {
        writeBook('wl-units');
        writeArtifact('wl-units', 'image');
        await insertScene('wl-units', CHAPTER, SCENE, 1, 1, ['iu-000001']);
        await insertAsset('wl-units', 'image', { status: 'ready', contentVersion: 1 });

        await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect((await assetStates('wl-units')).image).to.equal('dirty');
        expect(await activeScenes()).to.deep.equal([]);
    });

    it('scene_assets status=failed + leftover file → stale marker, not READY, not queued', async () => {
        writeBook('wl-failed');
        writeArtifact('wl-failed', 'video');
        await insertScene('wl-failed');
        await insertAsset('wl-failed', 'video', { status: 'failed' });

        await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect((await assetStates('wl-failed')).video).to.equal('dirty');
        expect(await activeScenes()).to.deep.equal([]);
    });

    it('scene_assets status=pending + leftover file → stale marker, not READY, not queued', async () => {
        writeBook('wl-pending');
        writeArtifact('wl-pending', 'image');
        await insertScene('wl-pending');
        await insertAsset('wl-pending', 'image', { status: 'pending' });

        await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect((await assetStates('wl-pending')).image).to.equal('dirty');
        expect(await activeScenes()).to.deep.equal([]);
    });

    // ── Audit gap 3: disabled-layer semantics via REAL shouldScheduleAssets ──
    it('absent Redis state for a disabled layer is never dispatched, even under a command', async () => {
        writeBook('wl-disabled');
        await insertScene('wl-disabled');
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));
        await require('../src/services/generation-progress').createTasks(redis, 'wl-disabled', ['audio', 'image'],
            { scope: 'current_scene', chapterId: CHAPTER, sceneId: SCENE }, [{ chapter_id: CHAPTER, scene_id: SCENE }]);
        const plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.not.include('image');
        expect(plan.stages).to.include('audio');
    });

    it('disabled layer with PENDING state is NOT dispatched (isInFlight override removed)', async () => {
        writeBook('wl-disabled');
        await insertScene('wl-disabled');
        await redis.set('animastor:layer-config:wl-disabled', JSON.stringify({
            audio_enabled: true, image_enabled: false, video_enabled: true,
        }));
        await require('../src/services/generation-progress').createTasks(redis, 'wl-disabled', ['image'],
            { scope: 'current_scene', chapterId: CHAPTER, sceneId: SCENE }, [{ chapter_id: CHAPTER, scene_id: SCENE }]);
        await redis.hset('animastor:asset-state:wl-disabled:ch-000001:sc-000001', 'image', 'pending');

        const plan = await runtimeScheduler.shouldScheduleAssets(redis, 'wl-disabled', CHAPTER, SCENE);
        expect(plan.stages).to.not.include('image'); // incident 2026-10-30: the override is gone

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });
        expect(result.ok).to.be.true;
    });
});
