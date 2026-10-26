// ======================================================
// Stage 143a (phase 1) — pointer publication + path safety (checkpoint B2/B3/B5)
// ======================================================
//
// Isolated PostgreSQL + isolated Redis (never production): point the suite
// with PG_* (database.js) and REDIS_HOST/REDIS_PORT.
//
// Covered:
//   1. first publication, idempotent REPLAY of the same fence, REJECT of a
//      stale fence (the "repeated callback" / "late callback" cases);
//   2. concurrent publishers of one resource — PG orders them, the pointer
//      ends on the GREATEST fence whatever the interleaving;
//   3. path safety: stored paths are relative to OUTPUT_DIR, traversal /
//      absolute / symlink escapes are rejected, valid paths resolve;
//   4. Redis intent admission: active intent passes, a cancelled/superseded
//      intent does not (Redis = admit/cancel/supersede only — it never
//      orders publications).

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Redis = require('ioredis');

const database = require('../src/storage/postgres/database');
const schema = require('../src/storage/postgres/schema');
const pointerRepo = require('../src/storage/postgres/repositories/iu-image-pointer-repo');
const qidem = require('../src/helpers/queue-idempotency.cjs');

const BOOK = 'b143aptr';
const CH = 'ch-1';
const SC = 'sc-1';
const IU = 'iu-1';
const BUILD = 'build-143a';
const RES = { bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD };

let savedFlag;
let outputDir;

async function cleanup() {
    await database.query(`DELETE FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
    await database.query(`DELETE FROM iu_image_pointers WHERE book_id = $1`, [BOOK]);
}

describe('stage143a B2/B3 — versioned pointer publication + path safety (isolated PG)', function () {
    this.timeout(30000);

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        process.env.IU_IMAGE_VERSIONED = '1';
        for (const stmt of schema.IU_IMAGE_VERSIONED_SQL) await database.query(stmt);
        await cleanup();
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-output-'));
    });

    after(async () => {
        await cleanup();
        if (savedFlag === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlag;
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}
        await database.closePool();
    });

    // ── 1 — first publish / replay / stale ───────────────────────────────
    it('first publication inserts the pointer (relative path + integer fence)', async () => {
        const rel = pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 7);
        expect(rel).to.equal(`${BUILD}/.versions/${BOOK}_${CH}_${SC}_${IU}/7.png`);

        const pub = await pointerRepo.publishIuImagePointer(Object.assign({}, RES, { relPath: rel, fence: 7 }));
        expect(pub.published).to.equal(true);
        expect(pub.fence).to.equal(7);

        const row = await pointerRepo.getIuImagePointer(RES);
        expect(row.path).to.equal(rel);
        expect(row.publishFence).to.equal(7);
        expect(path.isAbsolute(row.path), 'stored paths stay relative to OUTPUT_DIR').to.equal(false);
    });

    it('re-delivery of the SAME fence (repeat callback) is an idempotent success', async () => {
        const rel = pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 7);
        const replay = await pointerRepo.publishIuImagePointer(Object.assign({}, RES, { relPath: rel, fence: 7 }));
        expect(replay.published, 'same fence ⇒ same reservation ⇒ same deterministic path').to.equal(true);
        expect(replay.fence).to.equal(7);

        const row = await pointerRepo.getIuImagePointer(RES);
        expect(row.publishFence, 'a replay must not advance the version').to.equal(7);
        expect(row.path).to.equal(rel);
    });

    it('a NEWER fence advances the pointer (regeneration supersedes)', async () => {
        const rel = pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 8);
        const pub = await pointerRepo.publishIuImagePointer(Object.assign({}, RES, { relPath: rel, fence: 8 }));
        expect(pub.published).to.equal(true);
        expect(pub.fence).to.equal(8);
        expect((await pointerRepo.getIuImagePointer(RES)).path).to.equal(rel);
    });

    it('a STALE fence (late callback of an older generation) is rejected, pointer untouched', async () => {
        const stale = pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 7);
        const pub = await pointerRepo.publishIuImagePointer(Object.assign({}, RES, { relPath: stale, fence: 7 }));
        expect(pub.published).to.equal(false);
        expect(pub.reason).to.equal('stale_fence');
        expect(pub.current, 'the winning fence is reported to the caller').to.equal(8);

        const row = await pointerRepo.getIuImagePointer(RES);
        expect(row.publishFence).to.equal(8);
        expect(row.path).to.equal(pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 8));
    });

    it('publishing is disabled (no PG call) while the flag is OFF', async () => {
        const saved = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        try {
            const calls = [];
            const original = database.query;
            database.query = (...args) => { calls.push(args[0]); return original.apply(database, args); };
            try {
                const res = await pointerRepo.publishIuImagePointer(
                    Object.assign({}, RES, { relPath: 'x/y.png', fence: 99 }));
                expect(res.published).to.equal(false);
                expect(res.reason).to.equal('versioned_disabled');
                expect(calls.length, 'flag OFF ⇒ zero PG calls').to.equal(0);
            } finally {
                database.query = original;
            }
        } finally {
            process.env.IU_IMAGE_VERSIONED = saved;
        }
    });

    // ── 2 — concurrent publishers ────────────────────────────────────────
    it('concurrent publishers of one resource converge on the GREATEST fence', async () => {
        const fences = [11, 12, 13, 14, 15];
        const relOf = (f) => pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, f);
        // Run the race a few times — any interleaving must leave max(fences).
        for (let round = 0; round < 3; round++) {
            const results = await Promise.all(fences.map((f) =>
                pointerRepo.publishIuImagePointer(Object.assign({}, RES, { relPath: relOf(f), fence: f }))));
            expect(results.filter((r) => r.published).length).to.be.at.least(1);
            const row = await pointerRepo.getIuImagePointer(RES);
            expect(row.publishFence, `round ${round}: the pointer must hold the greatest fence`).to.equal(15);
            expect(row.path).to.equal(relOf(15));
        }
    });

    // ── 3 — path safety ──────────────────────────────────────────────────
    it('resolveOutputPath accepts a valid relative path inside OUTPUT_DIR', () => {
        const rel = pointerRepo.versionedRelPath(BUILD, `${BOOK}_${CH}_${SC}_${IU}`, 3);
        const resolved = pointerRepo.resolveOutputPath(outputDir, rel);
        expect(resolved.ok).to.equal(true);
        expect(resolved.path.startsWith(path.resolve(outputDir) + path.sep)).to.equal(true);
        expect(path.isAbsolute(resolved.path)).to.equal(true);
    });

    it('resolveOutputPath rejects traversal, absolute paths and NUL bytes', () => {
        const bad = [
            '../secret.png',
            `${BUILD}/../../secret.png`,
            'a/b/../../../etc/passwd',
            '/etc/passwd',
            'C:\\windows\\system32\\x.png',
            '..',
            'x\0.png',
            '',
            null,
            undefined,
            42,
        ];
        for (const value of bad) {
            const res = pointerRepo.resolveOutputPath(outputDir, value);
            expect(res.ok, `must reject ${JSON.stringify(value)}`).to.equal(false);
            expect(res.reason).to.be.a('string');
        }
    });

    it('resolveOutputPath rejects a symlink that escapes OUTPUT_DIR', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'evil.png'), 'png');
            const link = path.join(outputDir, 'linkdir');
            try { fs.symlinkSync(outside, link, 'dir'); } catch (_) { return; } // no symlink rights → skip
            const res = pointerRepo.resolveOutputPath(outputDir, 'linkdir/evil.png');
            expect(res.ok).to.equal(false);
            expect(res.reason).to.equal('symlink_escape');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('versioned/staging path builders refuse hostile components', () => {
        expect(pointerRepo.versionedRelPath('../evil', 'a', 1)).to.equal(null);
        expect(pointerRepo.versionedRelPath(BUILD, '../a', 1)).to.equal(null);
        expect(pointerRepo.versionedRelPath(BUILD, 'a/b', 1)).to.equal(null);
        expect(pointerRepo.versionedRelPath(BUILD, 'a', 0)).to.equal(null);
        expect(pointerRepo.versionedRelPath(BUILD, 'a', 1.5)).to.equal(null);
        expect(pointerRepo.stagingRelPath(BUILD, '..', 1)).to.equal(null);
        expect(pointerRepo.stagingRelPath(BUILD, 'a', 1)).to.equal(`${BUILD}/.staging/a/1.tmp`);
    });

    it('a pointer row with a traversal path is never served (resolver refuses it)', async () => {
        const hostile = { bookId: BOOK, chapterId: CH, sceneId: SC, iuId: 'iu-hostile', buildId: BUILD };
        await database.query(
            `INSERT INTO iu_image_pointers (book_id, chapter_id, scene_id, iu_id, build_id, path, publish_fence)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (book_id, chapter_id, scene_id, iu_id, build_id)
             DO UPDATE SET path = EXCLUDED.path, publish_fence = EXCLUDED.publish_fence`,
            [hostile.bookId, hostile.chapterId, hostile.sceneId, hostile.iuId, hostile.buildId, '../escape.png', 5]);
        try {
            const row = await pointerRepo.getIuImagePointer(hostile);
            expect(row.path).to.equal('../escape.png'); // stored as-is…
            const resolved = pointerRepo.resolveOutputPath(outputDir, row.path);
            expect(resolved.ok, '…but never resolvable outside OUTPUT_DIR').to.equal(false);
            expect(resolved.reason).to.equal('traversal');
        } finally {
            await database.query(
                `DELETE FROM iu_image_pointers WHERE book_id = $1 AND iu_id = $2`, [BOOK, 'iu-hostile']);
        }
    });
});

describe('stage143a B6 — Redis intent admission (isolated Redis)', function () {
    this.timeout(30000);

    const JOB = `${BOOK}_${CH}_${SC}_${IU}:iu_image`;
    let redis;
    let savedFlag;
    // Unique per run: the dispatch receipt is immutable with a 48h TTL, so a
    // fixed id would collide with a previous run's leftover receipt.
    let dispatchId;

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        process.env.IU_IMAGE_VERSIONED = '1';
        dispatchId = `dispatch-143a-${Date.now()}`;
        redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT || 6379),
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            connectTimeout: 4000,
        });
        await redis.connect();
        const keys = await redis.keys(`animastor:intent:${BOOK}:*`);
        if (keys.length) await redis.del(...keys);
    });

    after(async () => {
        try {
            const keys = await redis.keys(`animastor:intent:${BOOK}:*`);
            if (keys.length) await redis.del(...keys);
            const receipts = await redis.keys(`animastor:dispatch-intent:${dispatchId}:*`);
            if (receipts.length) await redis.del(...receipts);
            redis.disconnect();
        } catch (_) {}
        if (savedFlag === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlag;
    });

    it('an active intent passes readIntentStrict; a cancelled/superseded one does not', async () => {
        const fence = 'a'.repeat(64);
        const verdict = await qidem.ensureIntentAndReceipt(redis, {
            bookId: BOOK, chapterId: CH, sceneId: SC,
            jobId: JOB, dispatchId,
            fence, epoch: 1,
        });
        expect(['created', 'reused']).to.include(verdict.status);

        const active = await qidem.readIntentStrict(redis, { bookId: BOOK, chapterId: CH, sceneId: SC, jobId: JOB });
        expect(active.status).to.equal('ok');
        expect(active.state).to.equal('active');
        expect(String(active.fence).toLowerCase()).to.equal(fence);

        // Cancel/supersede is a REDIS-side admission question — the callback
        // admission (task-handler) rejects anything that is not active.
        const intentKeys = await redis.keys(`animastor:intent:${BOOK}:*`);
        const intentKey = intentKeys[0];
        expect(intentKey, 'intent record written by ensureIntentAndReceipt').to.be.a('string');
        const raw = JSON.parse(await redis.get(intentKey));
        raw.state = 'cancelled';
        await redis.set(intentKey, JSON.stringify(raw));

        const cancelled = await qidem.readIntentStrict(redis, { bookId: BOOK, chapterId: CH, sceneId: SC, jobId: JOB });
        expect(cancelled.status).to.equal('ok');
        expect(cancelled.state, 'a cancelled intent must not admit a publication').to.not.equal('active');
    });

    it('a receipt without an intent record fails closed (no silent admission)', async () => {
        const missing = await qidem.readIntentStrict(redis, {
            bookId: BOOK, chapterId: CH, sceneId: SC, jobId: `${JOB}-absent`,
        });
        expect(missing.status).to.equal('absent');
    });
});
