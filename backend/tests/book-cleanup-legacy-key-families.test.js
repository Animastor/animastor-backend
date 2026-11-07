'use strict';
// ════════════════════════════════════════════════════════════════════
//  DELETE /book must not leak the legacy key families of a book
// ════════════════════════════════════════════════════════════════════
//  reports/2026-11-06/orch-v2-1d-release.md §18: after `DELETE /api/v1/book/<id>`
//  a book generated through the legacy path kept 35 Redis keys of 12
//  families — `artifact-manifest`, `assets`, `fence-journal`, `fence-publish`,
//  `intent`, `dispatch-intent`, `idempotency:ref`, `idempotency:stage-epoch`,
//  `job`, `result-processed`, `dispatch-completed`, `cancelled-workers` —
//  because cleanBookRedisKeys had no pattern for them (`artifact-manifest:*`
//  and `assets:*` are written WITHOUT a TTL, so they stayed forever).
//
//  The helper is pinned here. The key formats are the ones the WRITERS use:
//    storage/asset-registry.js          assets:{book}:{ch}:{sc}
//    helpers/queue-idempotency.cjs      artifact-manifest / fence-journal /
//                                       fence-publish / intent /
//                                       stage-epoch / ref — encodeKeyComponent
//    helpers/queue-idempotency.cjs      dispatch-intent:{enc(dispatch)}:{enc(job)}
//    runtime/dispatch-engine.js         dispatch-completed:{book}:{ch}:{sc}:{stage}
//    gpu-hub jobDedupKey               job:{dispatch_id}:{job_id}
//    generation-routes.cjs              result-processed:{job_id}:{build_id}
//    book/generation-routes.cjs         cancelled-workers:{book}
//
//  Invariants:
//   - only THIS book's keys are removed (a prefix-neighbour book and an
//     unrelated book keep every key);
//   - every MATCH pattern carries the book id — no global pattern;
//   - `idempotency:ref` is released TOGETHER with its claim + completion
//     marker (Stage 118 · B1) and only when the caller destroys the book
//     (`{ releaseClaims: true }`); the cache-clear caller keeps the refs
//     because it releases them AFTER the hub lane clear (Stage 116/118);
//   - the book id is glob-escaped in every MATCH pattern.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK = 'release1d_legacy_ctl_1793946560';
const OTHER = 'ba_1788172242081';
const PREFIXED = `${BOOK}9`;          // shares the id prefix, not the key space

const enc = (v) => encodeURIComponent(String(v));

// One logical task of `book` (job_id grammar: {book}_{ch}_{sc}_{iu}:{type}).
function jobIdOf(book) { return `${book}_ch-1_sc-1_iu1:iu_image`; }
function idemKeyOf(book) { return `sha256${book.length}x${String(book).length}`; }

/** Every family from §18 for one book, in the exact format of its writer. */
function familyKeys(book) {
    const jobId = jobIdOf(book);
    const eJob = enc(jobId);
    const eBook = enc(book);
    return {
        // durable (no TTL!) — the worst leftovers
        assets: `animastor:assets:${book}:ch-1:sc-1`,
        artifactManifest: `animastor:artifact-manifest:${eBook}:ch-1:sc-1:${eJob}`,
        // runtime/dispatch-engine.js (legacy publication families)
        fenceJournal: `animastor:fence-journal:${eBook}:ch-1:sc-1:${eJob}:${enc('0f1e2d3c')}`,
        fencePublish: `animastor:fence-publish:${eBook}:ch-1:sc-1:${eJob}`,
        fenceUnrecoverable: `animastor:fence-unrecoverable:${eBook}:ch-1:sc-1:${eJob}`,
        intent: `animastor:intent:${eBook}:ch-1:sc-1:${eJob}`,
        // the book is only INSIDE the percent-encoded job id
        dispatchIntent: `animastor:dispatch-intent:${enc('dsp-1')}:${eJob}`,
        idemRef: `animastor:idempotency:ref:${eBook}:ch-1:sc-1:${eJob}`,
        idemClaim: `animastor:idempotency:claim:${idemKeyOf(book)}`,
        idemDone: `animastor:idempotency:done:${idemKeyOf(book)}`,
        stageEpoch: `animastor:idempotency:stage-epoch:${eBook}:ch-1:sc-1:audio`,
        // hub enqueue dedup — dispatch_id comes FIRST
        hubJob: `animastor:job:${'dsp-1'}:${jobId}`,
        resultProcessed: `animastor:result-processed:${jobId}:build_1793946560`,
        dispatchCompleted: `animastor:dispatch-completed:${book}:ch-1:sc-1:audio:dsp-1`,
        cancelledWorkers: `animastor:cancelled-workers:${book}`,
    };
}

function seedBook(redis, book) {
    const keys = familyKeys(book);
    for (const [family, key] of Object.entries(keys)) {
        if (family === 'cancelledWorkers') redis.sadd(key, 'vbook');
        else if (family === 'idemRef') redis.set(key, idemKeyOf(book));
        else if (family === 'idemClaim') redis.set(key, 'pending');
        else if (family === 'idemDone') redis.set(key, 'done:dsp-1');
        else redis.set(key, '1');
    }
    return keys;
}

describe('cleanBookRedisKeys — legacy key families (orch v2 1d §18)', () => {
    let redis;
    let helpers;

    beforeEach(() => {
        redis = createMockRedis();
        helpers = require('../src/helpers/redis-helpers.cjs')(redis, {});
    });

    it("book deletion leaves 0 keys for this book and every family of the other books", async () => {
        const mine = seedBook(redis, BOOK);
        const other = seedBook(redis, OTHER);
        const prefixed = seedBook(redis, PREFIXED);

        const res = await helpers.cleanBookRedisKeys(redis, BOOK, { releaseClaims: true });

        for (const [family, key] of Object.entries(mine)) {
            if (family === 'cancelledWorkers') {
                expect(await redis.smembers(key), 'cancelled-workers set').to.deep.equal([]);
            } else {
                expect(await redis.exists(key), `${family} must be gone: ${key}`).to.equal(0);
            }
        }
        // ref release is paired: the completion marker cannot be orphaned
        expect(res.markers_released, 'completion marker released').to.equal(1);
        expect(res.claims_released, 'claim released').to.equal(1);

        // another book keeps EVERY key, including the ones keyed by job_id only
        for (const seeded of [other, prefixed]) {
            for (const [family, key] of Object.entries(seeded)) {
                if (family === 'cancelledWorkers') {
                    expect(await redis.smembers(key), `${family} of another book`).to.deep.equal(['vbook']);
                } else {
                    expect(await redis.exists(key), `${family} of another book must stay: ${key}`).to.equal(1);
                }
            }
        }
    });

    it('cache clear (default) keeps the ownership refs and their markers', async () => {
        // The cache-clear route releases claims only AFTER the hub lane clear
        // (Stage 116/118 ordering); a raw release here would free a claim while
        // a lane entry can still be dispatched. Everything else is still purged.
        const mine = seedBook(redis, BOOK);

        await helpers.cleanBookRedisKeys(redis, BOOK);

        expect(await redis.exists(mine.idemRef)).to.equal(1);
        expect(await redis.exists(mine.idemClaim)).to.equal(1);
        expect(await redis.exists(mine.idemDone)).to.equal(1);
        expect(await redis.exists(mine.artifactManifest)).to.equal(0);
        expect(await redis.exists(mine.assets)).to.equal(0);
        expect(await redis.exists(mine.stageEpoch)).to.equal(0);
    });

    it('no MATCH pattern is global — each one carries the book id', async () => {
        const patterns = [];
        const originalScan = redis.scan;
        redis.scan = async (cursor, ...args) => {
            const i = args.indexOf('MATCH');
            if (i !== -1) patterns.push(args[i + 1]);
            return originalScan.call(redis, cursor, ...args);
        };

        await helpers.cleanBookRedisKeys(redis, BOOK);

        expect(patterns.length).to.be.greaterThan(20);
        expect(patterns.filter((p) => !p.includes(BOOK)), 'every pattern is scoped to the book')
            .to.deep.equal([]);
    });

    it('the new families are glob-escaped and anchored to the book segment', async () => {
        const patterns = [];
        const originalScan = redis.scan;
        redis.scan = async (cursor, ...args) => {
            const i = args.indexOf('MATCH');
            if (i !== -1) patterns.push(args[i + 1]);
            return originalScan.call(redis, cursor, ...args);
        };

        await helpers.cleanBookRedisKeys(redis, 'a*b?[c]');

        expect(patterns).to.include('animastor:job:*:a\\*b\\?\\[c\\]_*');
        expect(patterns).to.include('animastor:assets:a\\*b\\?\\[c\\]:*');
        expect(patterns).to.include('animastor:cancelled-workers:a\\*b\\?\\[c\\]');
        expect(patterns).to.include('animastor:result-processed:a\\*b\\?\\[c\\]_*');
        // encodeURIComponent leaves '*' literal — it must be escaped as well
        expect(patterns).to.include('animastor:artifact-manifest:a\\*b%3F%5Bc%5D:*');
    });
});