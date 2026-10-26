// ======================================================
// Stage 143a (phase 1) — durable fence reservations (checkpoint B1)
// ======================================================
//
// Runs against an ISOLATED PostgreSQL (never production): point the suite
// at it with the standard PG_* env (PG_HOST/PG_PORT/PG_DB/PG_USER/
// PG_PASSWORD) — database.js reads them, this file reads none of them.
//
// Covered:
//   1. the ACTUAL computeIdemKey: same logical dispatch → same idem_key,
//      a user regeneration (epoch bump / params change) → a NEW idem_key;
//   2. reserve → re-reserve of the SAME idem_key keeps the original fence;
//   3. a new idem_key always gets a strictly GREATER fence;
//   4. concurrent reservations (same key → one fence; different keys →
//      distinct fences) — real PG concurrency, no mocks;
//   5. callback admission: identity match / mismatch / unknown key.
//
// SQL here is executed on the isolated instance only; nothing in this file
// touches production.

const { expect } = require('chai');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..', 'src', 'storage', 'postgres', 'repositories');
const database = require('../src/storage/postgres/database');
const schema = require('../src/storage/postgres/schema');
const pointerRepo = require(path.join(REPO_DIR, 'iu-image-pointer-repo'));
const qidem = require('../src/helpers/queue-idempotency.cjs');

const BOOK = 'b143afence';
const CH = 'ch-1';
const SC = 'sc-1';
const IU = 'iu-1';
const BUILD = 'build-143a';

let savedFlag;

function idemSpec(overrides = {}) {
    return Object.assign({
        workspaceId: 'ws-143a',
        jobId: `${BOOK}_${CH}_${SC}_${IU}:iu_image`,
        jobType: 'image',
        buildId: BUILD,
        params: { prompt: 'p', seed: 7 },
        generationEpoch: 1,
    }, overrides);
}

async function cleanup() {
    await database.query(`DELETE FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
    await database.query(`DELETE FROM iu_image_pointers WHERE book_id = $1`, [BOOK]);
}

describe('stage143a B1 — durable dispatch fence (isolated PG)', function () {
    this.timeout(30000);

    before(async () => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        process.env.IU_IMAGE_VERSIONED = '1';
        for (const stmt of schema.IU_IMAGE_VERSIONED_SQL) await database.query(stmt);
        await cleanup();
    });

    after(async () => {
        await cleanup();
        if (savedFlag === undefined) delete process.env.IU_IMAGE_VERSIONED;
        else process.env.IU_IMAGE_VERSIONED = savedFlag;
        await database.closePool();
    });

    // ── 1 — the actual computeIdemKey ────────────────────────────────────
    it('computeIdemKey: same logical dispatch → same key; regeneration → NEW key', () => {
        const first = qidem.computeIdemKey(idemSpec());
        const redelivery = qidem.computeIdemKey(idemSpec());
        expect(redelivery, 'same dispatch must recompute the identical idem_key').to.equal(first);
        expect(first).to.match(/^[0-9a-f]{64}$/, 'idem_key is the sha256 hex receipt (a token, not a numeric fence)');

        // A user regeneration bumps the stage epoch (iu-processor:
        // bumpStageEpoch + resetJobEpoch) → new epoch → new identity.
        const regenerated = qidem.computeIdemKey(idemSpec({ generationEpoch: 2 }));
        expect(regenerated, 'regeneration must produce a NEW idem_key').to.not.equal(first);

        // A regeneration through changed params (prompt/seed) is also new.
        const reparametrised = qidem.computeIdemKey(idemSpec({ params: { prompt: 'p', seed: 8 } }));
        expect(reparametrised).to.not.equal(first);

        // A different resource never collides.
        const otherIU = qidem.computeIdemKey(idemSpec({ jobId: `${BOOK}_${CH}_${SC}_iu-2:iu_image` }));
        expect(otherIU).to.not.equal(first);
    });

    // ── 2 — re-dispatch keeps idem_key AND fence ─────────────────────────
    it('re-dispatch of the same intent reuses the original fence (idem_key + fence preserved)', async () => {
        const idemKey = qidem.computeIdemKey(idemSpec());
        const first = await pointerRepo.reserveDispatchFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        expect(first.status).to.equal('created');
        expect(Number.isInteger(first.fence)).to.equal(true);

        // Same logical dispatch delivered again (new dispatch_id, same spec).
        const again = await pointerRepo.reserveDispatchFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        expect(again.status).to.equal('reused');
        expect(again.fence).to.equal(first.fence);

        const rows = await database.query(
            `SELECT count(*)::int AS n FROM iu_image_fence_reservations WHERE idem_key = $1`, [idemKey]);
        expect(rows.rows[0].n, 'one row per idem_key — the atomic binding').to.equal(1);
    });

    // ── 3 — regeneration ⇒ strictly greater fence ────────────────────────
    it('a new intent (regeneration) always reserves a STRICTLY GREATER fence', async () => {
        const keyOld = qidem.computeIdemKey(idemSpec({ generationEpoch: 10 }));
        const keyNew = qidem.computeIdemKey(idemSpec({ generationEpoch: 11 }));
        expect(keyNew).to.not.equal(keyOld);

        const oldRes = await pointerRepo.reserveDispatchFence({
            idemKey: keyOld, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        const newRes = await pointerRepo.reserveDispatchFence({
            idemKey: keyNew, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        expect(newRes.fence, 'regeneration must supersede with a higher fence').to.be.above(oldRes.fence);
    });

    // ── 4 — concurrency ──────────────────────────────────────────────────
    it('10 concurrent reserves of ONE idem_key converge on a single fence', async () => {
        const idemKey = qidem.computeIdemKey(idemSpec({ generationEpoch: 21 }));
        const results = await Promise.all(Array.from({ length: 10 }, () =>
            pointerRepo.reserveDispatchFence({
                idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
            })));
        const fences = new Set(results.map((r) => r.fence));
        expect(fences.size, 'all concurrent re-deliveries share the reserved fence').to.equal(1);

        const rows = await database.query(
            `SELECT count(*)::int AS n FROM iu_image_fence_reservations WHERE idem_key = $1`, [idemKey]);
        expect(rows.rows[0].n).to.equal(1);
    });

    it('10 concurrent reserves of DIFFERENT idem_keys get distinct fences', async () => {
        const keys = Array.from({ length: 10 }, (_, i) =>
            qidem.computeIdemKey(idemSpec({ generationEpoch: 100 + i })));
        const results = await Promise.all(keys.map((idemKey) =>
            pointerRepo.reserveDispatchFence({
                idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
            })));
        const fences = results.map((r) => r.fence);
        expect(new Set(fences).size, 'sequence values are never shared').to.equal(10);
        expect(fences.every((f) => Number.isInteger(f) && f > 0)).to.equal(true);

        // Ordering property used by publication: distinct intents of one
        // resource are totally ordered — a later reserve is never smaller
        // than an earlier one (no reuse, no wrap-around).
        const stored = await database.query(
            `SELECT fence FROM iu_image_fence_reservations WHERE book_id = $1`, [BOOK]);
        const all = stored.rows.map((r) => Number(r.fence));
        expect(new Set(all).size).to.equal(all.length);
    });

    // ── 5 — callback admission (hex receipt → integer fence) ─────────────
    it('resolveCallbackFence: identity match / mismatch / unknown key', async () => {
        const idemKey = qidem.computeIdemKey(idemSpec({ generationEpoch: 31 }));
        const reserved = await pointerRepo.reserveDispatchFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });

        const ok = await pointerRepo.resolveCallbackFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        expect(ok.ok).to.equal(true);
        expect(ok.fence).to.equal(reserved.fence);

        const wrongBuild = await pointerRepo.resolveCallbackFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: 'build-other',
        });
        expect(wrongBuild.ok).to.equal(false);
        expect(wrongBuild.reason).to.equal('reservation_mismatch');

        const wrongIU = await pointerRepo.resolveCallbackFence({
            idemKey, bookId: BOOK, chapterId: CH, sceneId: SC, iuId: 'iu-999', buildId: BUILD,
        });
        expect(wrongIU.ok).to.equal(false);
        expect(wrongIU.reason).to.equal('reservation_mismatch');

        const unknown = await pointerRepo.resolveCallbackFence({
            idemKey: 'f'.repeat(64), bookId: BOOK, chapterId: CH, sceneId: SC, iuId: IU, buildId: BUILD,
        });
        expect(unknown.ok).to.equal(false);
        expect(unknown.reason).to.equal('reservation_missing');
    });

    // ── 6 — dispatcher wiring: reservation happens BEFORE the hub POST ───
    it('gpu-dispatcher reserves the fence before the hub POST and rolls back on failure', () => {
        const src = require('fs').readFileSync(
            path.resolve(__dirname, '..', 'src', 'runtime', 'gpu-dispatcher.js'), 'utf8');
        const reserveIdx = src.indexOf('reserveDispatchFence');
        const postIdx = src.indexOf('await fetch(');
        expect(reserveIdx, 'dispatcher must call reserveDispatchFence').to.be.above(0);
        expect(postIdx, 'dispatcher must POST to the hub').to.be.above(0);
        expect(reserveIdx, 'reservation must be issued BEFORE the hub POST').to.be.below(postIdx);
        expect(src.slice(reserveIdx, postIdx + 200)).to.match(/rollbackOwnEnqueue/);
        expect(src.slice(src.indexOf('parsed.kind === \'iu_image\'') - 400, reserveIdx))
            .to.match(/versionedEnabled\(\)/);
    });
});
