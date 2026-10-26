// =====================================================
// Stage 143a FIX (part A) — atomic + verifiable publication
// =====================================================
//
// A1: the Phase 1 writer used `copyFileSync(..., COPYFILE_EXCL)` and treated
//     EEXIST as "our own bytes". A crash in the middle of that copy left a
//     TRUNCATED file at the immutable path forever, and the next delivery
//     happily moved the pointer onto it. The fix writes an fsync'd temp file
//     and publishes it with `link(2)` (atomic, no overwrite), then verifies
//     size + SHA-256 against the callback bytes BOTH on EEXIST (replay) and
//     right before the pointer UPDATE.
//
// A2: with the flag OFF the pointer is INERT — a reader returns null with
//     ZERO PG calls and serves the legacy canonical file, even when rows of
//     an earlier ON period are still present.
//
// Isolated PostgreSQL + isolated Redis only (never production):
//   PG_HOST/PG_PORT/PG_DB/PG_USER/PG_PASSWORD → stage143a-pg (55432)
//   REDIS_HOST/REDIS_PORT                     → stage143a-redis (56379)

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const database = require('../src/storage/postgres/database');
const schema = require('../src/storage/postgres/schema');
const pointerRepo = require('../src/storage/postgres/repositories/iu-image-pointer-repo');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const jobSchema = require('../src/runtime/job-schema');
const registry = require('../src/image/registry');
const { createMockRedis } = require('./mocks/redis-mock');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const artifactNaming = require('@animastor/generation').artifactNaming;

const BOOK = 'b143afix';
const CHAPTER = 'ch-1';
const SCENE = 'sc-1';
const BUILD = 'build-143a-fix';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const IU_SEG = 'iu01';                     // parsed.iuId (last job-id segment)
const ASSET_ID = `${PREFIX}_${IU_SEG}`;    // versioned path component
const JOB = `${ASSET_ID}:iu_image`;

const BYTES_V1 = 'IU-BYTES-V1';
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

const RESERVATION = {
    bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, iuId: IU_SEG, buildId: BUILD,
};
const POINTER_RES = Object.assign({}, RESERVATION);

function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD,
        params: { '120': { inputs: { seed: 7 } } }, generationEpoch: epoch,
    });
}
const FENCE = fenceFor(0);

let tmpRoot;
let savedFlag;

const finalPathFor = (fenceInt) =>
    pointerRepo.resolveOutputPath(tmpRoot, pointerRepo.versionedRelPath(BUILD, ASSET_ID, fenceInt));
const tempPathFor = (fenceInt) =>
    pointerRepo.resolveOutputPath(tmpRoot, pointerRepo.stagingRelPath(BUILD, ASSET_ID, fenceInt));

async function cleanupPg() {
    await database.query(`DELETE FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
    await database.query(`DELETE FROM iu_image_pointers WHERE book_id = $1`, [BOOK]);
}

async function seedIntent(redis, fence, epoch = 0) {
    await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), JSON.stringify({
        fence, state: 'active', epoch: String(epoch), supersedes: null,
        updated_at: Date.now(), history: [],
    }), 'EX', qidem.IDEM_INTENT_TTL_S);
}
async function seedReceipt(redis, dispatchId, fence) {
    await redis.set(qidem.dispatchReceiptKey(dispatchId, JOB), fence, 'EX', qidem.IDEM_RECEIPT_TTL_S);
}
async function seedDispatchMeta(redis, dispatchId) {
    await dispatch.setDispatchMetadata(redis, BOOK, CHAPTER, SCENE, 'image', {
        dispatch_id: dispatchId, stage: 'image', started_at: Date.now(),
        worker: 'scheduler', retry_attempt: 0, status: 'dispatched',
    });
}

/** Production task handler with the iu_image ready-chain deps stubbed. */
function makeHandler(redis) {
    return taskHandlerFactory(redis, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, {
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

function withPublish(redis) {
    if (typeof redis.publish === 'function') return redis;
    return new Proxy(redis, {
        get(target, prop) {
            if (prop === 'publish') return async () => 0;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** A fresh delivery: reservation (as the dispatcher does) + intent + receipt + lease. */
async function primeDelivery(redis, fence = FENCE) {
    const reserve = await pointerRepo.reserveDispatchFence(Object.assign({ idemKey: fence }, RESERVATION));
    expect(reserve.status, 'a reservation must exist for the callback admission').to.be.oneOf(['created', 'reused']);
    await seedIntent(redis, fence);
    await seedReceipt(redis, 'd1', fence);
    await seedDispatchMeta(redis, 'd1');
}

async function deliver(handler, payload = BYTES_V1, fence = FENCE) {
    return handler.handleTaskResult(JOB, b64(payload), BUILD, 'd1', { fence });
}

/** The integer fence bound to FENCE by the durable reservation. */
async function reservedFence() {
    const res = await database.query(
        `SELECT fence FROM iu_image_fence_reservations WHERE idem_key = $1`, [FENCE]);
    return Number(res.rows[0].fence);
}

async function caught(fn) {
    try { await fn(); return null; } catch (err) { return err; }
}

describe('stage143a fix A1 — atomic, verifiable versioned publication (isolated PG)', function () {
    this.timeout(40000);

    let redis;

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        process.env.IU_IMAGE_VERSIONED = '1';
        for (const stmt of schema.IU_IMAGE_VERSIONED_SQL) await database.query(stmt);
        await cleanupPg();
    });

    after(async () => {
        await cleanupPg();
        if (savedFlag === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlag;
        await database.closePool();
    });

    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-fix-'));
        redis = withPublish(createMockRedis());
        await cleanupPg();
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // ── 1 — truncated file already on the immutable path ────────────────
    it('a truncated file at the final path + re-delivery → version_conflict, pointer NOT moved, file kept', async () => {
        await primeDelivery(redis);
        const fenceInt = await reservedFence();

        const finalRes = finalPathFor(fenceInt);
        expect(finalRes.ok).to.equal(true);
        fs.mkdirSync(path.dirname(finalRes.path), { recursive: true });
        // What the old copyFileSync writer could leave behind: a partial write.
        const truncated = BYTES_V1.slice(0, 4);
        fs.writeFileSync(finalRes.path, truncated);

        const handler = makeHandler(redis);
        const err = await caught(() => deliver(handler));
        expect(err, 'the delivery must be rejected').to.not.equal(null);
        expect(err.code).to.equal('version_conflict');

        // existing bytes untouched, pointer never created, temp removed
        expect(fs.readFileSync(finalRes.path, 'utf8'), 'the immutable file is never overwritten').to.equal(truncated);
        expect(await pointerRepo.getIuImagePointer(POINTER_RES), 'the pointer must not move onto bad bytes').to.equal(null);
        const tempRes = tempPathFor(fenceInt);
        expect(fs.existsSync(tempRes.path), 'this writer\'s temp file is always removed').to.equal(false);
    });

    // ── 2 — byte-identical replay ───────────────────────────────────────
    it('the SAME bytes already at the final path → idempotent success, pointer published, temp removed', async () => {
        await primeDelivery(redis);
        const fenceInt = await reservedFence();

        const finalRes = finalPathFor(fenceInt);
        fs.mkdirSync(path.dirname(finalRes.path), { recursive: true });
        fs.writeFileSync(finalRes.path, BYTES_V1);
        const inodeBefore = fs.statSync(finalRes.path).ino;

        const handler = makeHandler(redis);
        const out = await deliver(handler);
        expect(out.versioned).to.equal(true);
        expect(out.published).to.equal(true);

        expect(fs.readFileSync(finalRes.path, 'utf8')).to.equal(BYTES_V1);
        expect(fs.statSync(finalRes.path).ino, 'a replay never rewrites the file').to.equal(inodeBefore);

        const row = await pointerRepo.getIuImagePointer(POINTER_RES);
        expect(row, 'the pointer is published on an idempotent replay').to.not.equal(null);
        expect(row.publishFence).to.equal(fenceInt);
        expect(row.path).to.equal(pointerRepo.versionedRelPath(BUILD, ASSET_ID, fenceInt));

        const tempRes = tempPathFor(fenceInt);
        expect(fs.existsSync(tempRes.path)).to.equal(false);
    });

    // ── 3 — first publication (the happy path) ──────────────────────────
    it('a first publication links the complete file, verifies it and only then moves the pointer', async () => {
        await primeDelivery(redis);
        const handler = makeHandler(redis);

        const out = await deliver(handler);
        expect(out.versioned).to.equal(true);
        expect(out.published).to.equal(true);

        const row = await pointerRepo.getIuImagePointer(POINTER_RES);
        expect(row).to.not.equal(null);
        const resolved = pointerRepo.resolveOutputPath(tmpRoot, row.path);
        expect(resolved.ok).to.equal(true);
        expect(fs.readFileSync(resolved.path, 'utf8')).to.equal(BYTES_V1);

        const tempRes = tempPathFor(row.publishFence);
        expect(fs.existsSync(tempRes.path), 'temp removed on success').to.equal(false);
        // staging/ and .versions/ live under the same build directory
        expect(fs.existsSync(path.dirname(resolved.path))).to.equal(true);
    });

    // ── 4 — crash between the file write and the pointer UPDATE ─────────
    it('a failure between the file write and the pointer UPDATE leaves: complete file, PG untouched, no temp — and a retry converges', async () => {
        await primeDelivery(redis);
        const handler = makeHandler(redis);
        const fenceInt = await reservedFence();

        // Simulate the crash: the bytes are durable, the pointer UPDATE never
        // happens (PG refuses / process dies right there).
        const originalPublish = pointerRepo.publishIuImagePointer;
        pointerRepo.publishIuImagePointer = async () => { throw new Error('simulated PG outage'); };
        let err;
        try {
            err = await caught(() => deliver(handler));
        } finally {
            pointerRepo.publishIuImagePointer = originalPublish;
        }
        expect(err, 'the publication must fail').to.not.equal(null);
        expect(err.code).to.equal('publish_failed');

        // ── final state after the "crash" ──
        const finalRes = finalPathFor(fenceInt);
        expect(fs.existsSync(finalRes.path), 'the immutable file made it to disk').to.equal(true);
        expect(fs.readFileSync(finalRes.path, 'utf8'), '…complete, never truncated').to.equal(BYTES_V1);
        expect(await pointerRepo.getIuImagePointer(POINTER_RES), 'PG untouched: the pointer did not move').to.equal(null);
        expect(fs.existsSync(tempPathFor(fenceInt).path), 'the temp file is gone even on the failure path').to.equal(false);

        // ── retry of the same callback converges (idempotent replay) ──
        const retry = await deliver(handler);
        expect(retry.published).to.equal(true);
        const row = await pointerRepo.getIuImagePointer(POINTER_RES);
        expect(row.publishFence).to.equal(fenceInt);
        expect(fs.readFileSync(finalRes.path, 'utf8')).to.equal(BYTES_V1);
        expect(fs.existsSync(tempPathFor(fenceInt).path)).to.equal(false);
    });

    // ── 5 — temp cleanup on a terminal pointer reject ───────────────────
    it('a stale fence (pointer already ahead) rejects AFTER the file stage and still removes the temp file', async () => {
        await primeDelivery(redis);
        const fenceInt = await reservedFence();

        // A NEWER generation already won the pointer.
        const ahead = fenceInt + 100;
        const pub = await pointerRepo.publishIuImagePointer(Object.assign({}, POINTER_RES, {
            relPath: pointerRepo.versionedRelPath(BUILD, ASSET_ID, ahead),
            fence: ahead,
        }));
        expect(pub.published).to.equal(true);

        const handler = makeHandler(redis);
        const err = await caught(() => deliver(handler));
        expect(err, 'the stale publication must be rejected').to.not.equal(null);
        expect(err.code).to.equal('stale_intent');

        expect((await pointerRepo.getIuImagePointer(POINTER_RES)).publishFence, 'the winner stays').to.equal(ahead);
        expect(fs.existsSync(tempPathFor(fenceInt).path), 'temp removed on the reject path').to.equal(false);
        // The immutable file of THIS fence exists (age-based GC owns it) — it
        // is never deleted and never overwrites the winner's file.
        expect(fs.existsSync(finalPathFor(fenceInt).path)).to.equal(true);
    });

    // ── 6 (A2) — flag OFF after a publication: the pointer is inert ─────
    it('A2: flag OFF after a publication → reader serves the legacy file, zero PG calls, pointer rows untouched', async () => {
        await primeDelivery(redis);
        const handler = makeHandler(redis);
        await deliver(handler);
        const published = await pointerRepo.getIuImagePointer(POINTER_RES);
        expect(published, 'flag ON published a pointer').to.not.equal(null);

        // A legacy writer later updates the canonical file (flag was OFF).
        const legacyPath = path.join(tmpRoot, BUILD, `${ASSET_ID}.png`);
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, 'LEGACY-NEWER-BYTES');

        const saved = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        const originalQuery = database.query;
        const calls = [];
        database.query = (...args) => { calls.push(String(args[0])); return originalQuery.apply(database, args); };
        try {
            expect(pointerRepo.versionedEnabled()).to.equal(false);

            // reader: pointer is inert, legacy wins, NOT ONE PG call
            expect(await registry.resolveIuImagePath(tmpRoot, BUILD, BOOK, CHAPTER, SCENE, IU_SEG))
                .to.equal(null);
            expect(await registry.resolveVersionedSceneProof(tmpRoot, BUILD, BOOK, CHAPTER, SCENE))
                .to.equal(null);
            expect(calls, 'flag OFF ⇒ zero PG calls from the readers').to.deep.equal([]);

            const probe = registry.probeIUImage(ASSET_ID, BUILD, tmpRoot);
            expect(probe.image, 'legacy probe still decides').to.equal(true);
            expect(probe.path).to.equal(legacyPath);
            expect(registry.resolveCanonicalSceneImage(tmpRoot, BUILD, BOOK, CHAPTER, SCENE))
                .to.equal(`${ASSET_ID}.png`);
        } finally {
            database.query = originalQuery;
            if (saved === undefined) delete process.env.IU_IMAGE_VERSIONED;
            else process.env.IU_IMAGE_VERSIONED = saved;
        }

        const still = await pointerRepo.getIuImagePointer(POINTER_RES);
        expect(still, 'inert ≠ deleted: the row survives until an operator drops it (see B7 rule)').to.not.equal(null);
        expect(still.publishFence).to.equal(published.publishFence);
        expect(fs.readFileSync(legacyPath, 'utf8')).to.equal('LEGACY-NEWER-BYTES');
    });

    // ── 7 — source contract of the fixed writer ─────────────────────────
    it('the writer publishes via link() + verifies size/SHA-256 (source contract)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'task-handler.cjs'), 'utf8');
        expect(src, 'no unverified exclusive copy anymore').to.not.match(/copyFileSync\([^)]*COPYFILE_EXCL/);
        expect(src).to.match(/fs\.linkSync\(absTemp\.path, absFinal\.path\)/);
        expect(src).to.match(/fs\.fsyncSync\(tmpFd\)/);
        expect(src).to.match(/fsyncDir\(path\.dirname\(absFinal\.path\)\)/);
        expect(src, 'both the EEXIST branch and the pre-pointer check verify bytes')
            .to.match(/verifyVersionedBytes\(absFinal\.path, buffer, shaExpected\)/);
        expect((src.match(/verifyVersionedBytes\(absFinal\.path, buffer, shaExpected\)/g) || []).length)
            .to.be.at.least(2);
        expect(src, 'the temp file is removed on every path').to.match(/finally \{\s*\n\s*\/\/ 5 — THIS writer's temp file/);
    });
});
