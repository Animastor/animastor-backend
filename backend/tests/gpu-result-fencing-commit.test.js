// =====================================================
// Stage 131 — staged artifacts & fenced commit
// =====================================================
// Regression battery for the staged→commit→publish protocol:
// contract 126 §3 and the Stage 131 mandatory invariants (§2).
//
// The Redis verdicts run against the INDEPENDENT mock mirror of
// FENCE_COMMIT_SCRIPT (tests/mocks/redis-mock.js); the script itself is
// executed for real against an isolated redis:7 outside this suite (see the
// Stage 131 report §real-Redis) — no mock is claimed as proof of the Lua.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const pub = require('../src/services/result-publication.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

// ── fixtures ──────────────────────────────────────────────────────────────

const BOOK = 'book-s131';
const CHAPTER = 'ch-s131';
const SCENE = 'sc-s131';
const BUILD = 'build-s131';
const JOB = `${BOOK}_${CHAPTER}_${SCENE}_iu01:iu_image`;
const EXT = '.png';

function params() { return { '120': { inputs: { seed: 42, steps: 8 } } }; }

function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: epoch,
    });
}

const F1 = fenceFor(0);
const F2 = fenceFor(1);
const F3 = fenceFor(2);

let tmpRoot;
function config() { return { OUTPUT_DIR: tmpRoot }; }

const CANON_NAME = `${BOOK}_${CHAPTER}_${SCENE}_iu01.png`;
function canonicalPath() { return path.join(tmpRoot, BUILD, CANON_NAME); }

async function seedIntent(redis, { fence, epoch = 0, state = 'active', supersedes = null, history = [] }) {
    await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), JSON.stringify({
        fence, state, epoch: String(epoch), supersedes, updated_at: Date.now(), history,
    }), 'EX', qidem.IDEM_INTENT_TTL_S);
}

/** Seed the dispatch metadata so verifyDispatchIdentity accepts `dispatchId`. */
async function seedDispatchMeta(redis, dispatchId) {
    await redis.set(`animastor:dispatch-meta:${BOOK}:${CHAPTER}:${SCENE}:image`, JSON.stringify({
        dispatch_id: dispatchId, created_at: Date.now(),
    }), 'EX', 3600);
}

function buf(text) { return Buffer.from(text, 'utf8'); }

function stagedPathFor(fence) {
    return path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), fence, 'artifact' + EXT);
}

async function commit(redis, fence, text) {
    return pub.commitFencedResult(redis, config(), {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
        buildId: BUILD, fence, buffer: buf(text), extension: EXT, canonicalPath: canonicalPath(),
    });
}

describe('Stage 131: staged artifacts & fenced commit', () => {
    let redis;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's131-'));
        redis = createMockRedis();
    });
    afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

    // ── 1. successful publication of the CURRENT fence ────────────────────
    it('publishes the current fence: staged → committed → canonical, manifest + done written', async () => {
        await seedIntent(redis, { fence: F1 });
        await redis.set(qidem.idemClaimKey(F1), 'pending', 'NX', 'EX', 1000);
        await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F1, 'EX', 1000);

        const out = await commit(redis, F1, 'v1');

        expect(out.status).to.equal('committed');
        expect(out.published).to.equal(true);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
        // staged file was MOVED (not copied) into the canonical path
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false);
        // durable manifest + commit journal + done marker
        const manifest = await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB);
        expect(manifest.published_fence).to.equal(F1);
        expect(manifest.canonical_path).to.equal(CANON_NAME);
        expect(await qidem.isTaskDone(redis, F1)).to.equal(true);
        // claim of exactly this fence released; ref TTL extended to the done TTL
        expect(await redis.get(qidem.idemClaimKey(F1))).to.equal(null);
        expect(await redis.ttl(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB))).to.equal(qidem.IDEM_REF_DONE_TTL_S);
    });

    // ── 2. repeat of the same fence ───────────────────────────────────────
    it('a repeat of the SAME fence is duplicate_same_fence and never flaps the canonical file', async () => {
        await seedIntent(redis, { fence: F1 });
        await commit(redis, F1, 'v1');

        const again = await commit(redis, F1, 'v2-bytes-of-a-redelivery');
        expect(again.status).to.equal('duplicate_same_fence');
        // the already-published file is NOT overwritten by the redelivery
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    it('a repeat of the same fence completes a crashed rename (staged still present)', async () => {
        await seedIntent(redis, { fence: F1 });
        // stage + commit manually, then "crash" before the rename
        pub.stageResult(config(), { buildId: BUILD, jobId: JOB, fence: F1, buffer: buf('v1'), extension: EXT });
        const manifest = pub.buildCommitManifest({
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
            buildDir: path.join(tmpRoot, BUILD), fence: F1,
            stagedPath: stagedPathFor(F1), canonicalPath: canonicalPath(), bytes: buf('v1').length,
        });
        const verdict = await qidem.fenceCommitResult(redis, {
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence: F1, manifest,
        });
        expect(verdict.status).to.equal('committed');
        expect(fs.existsSync(canonicalPath())).to.equal(false);

        // Stage 137: the redelivery must carry the COMMITTED bytes — a
        // content proof gates the rename (a different payload under the same
        // fence is refused instead of silently replacing the artifact).
        const out = await commit(redis, F1, 'v1');
        expect(out.status).to.equal('duplicate_same_fence');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    // ── 3. supersede between staging and commit ───────────────────────────
    it('supersede between staging and commit: the staged bytes are discarded, nothing published', async () => {
        await seedIntent(redis, { fence: F1 });
        pub.stageResult(config(), { buildId: BUILD, jobId: JOB, fence: F1, buffer: buf('stale-v1'), extension: EXT });

        // regeneration moves the intent to F2 while F1 is staged
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });

        const out = await commit(redis, F1, 'stale-v1');
        expect(out.status).to.equal('stale_intent');
        expect(fs.existsSync(canonicalPath())).to.equal(false);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false);   // own staged removed
        expect(await qidem.isTaskDone(redis, F1)).to.equal(false);  // no marker
        expect(await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(null);
    });

    // ── 4. F1 → F2 → late F1 ──────────────────────────────────────────────
    it('F1 → F2 → late F1: the late result cannot publish and cannot delete F2 state', async () => {
        // F1 is the intent, but its result never arrived — the user regenerates.
        await seedIntent(redis, { fence: F1 });

        // supersede to F2 (the same way a re-dispatch does)
        const ensure = await qidem.ensureIntentAndReceipt(redis, {
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, dispatchId: 'd2', fence: F2, epoch: 1,
        });
        expect(ensure.status).to.equal('created');

        const out2 = await commit(redis, F2, 'v2');
        expect(out2.status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');

        // a LATE result of F1 arrives now
        pub.stageResult(config(), { buildId: BUILD, jobId: JOB, fence: F1, buffer: buf('late-v1'), extension: EXT });
        const late = await commit(redis, F1, 'late-v1');
        expect(late.status).to.equal('stale_intent');
        // the current publication (F2) is intact: file, marker, manifest
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
        expect(await qidem.isTaskDone(redis, F2)).to.equal(true);
        expect((await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).published_fence).to.equal(F2);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false); // own staged removed
        expect(fs.existsSync(stagedPathFor(F2))).to.equal(false);
    });

    // ── 5. two concurrent results for one task ────────────────────────────
    it('two concurrent results of one fence: exactly one committed, one duplicate', async () => {
        await seedIntent(redis, { fence: F1 });
        const [a, b] = await Promise.all([commit(redis, F1, 'v1'), commit(redis, F1, 'v1')]);
        const verdicts = [a.status, b.status].sort();
        expect(verdicts).to.deep.equal(['committed', 'duplicate_same_fence']);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
        expect(await qidem.isTaskDone(redis, F1)).to.equal(true);
    });

    it('two DIFFERENT fences racing: the stale one can never win', async () => {
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });
        const [a, b] = await Promise.all([commit(redis, F1, 'v1'), commit(redis, F2, 'v2')]);
        expect(a.status).to.equal('stale_intent');
        expect(b.status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
    });

    // ── 6. crash / timeout after staging, before the commit ───────────────
    it('crash after staging, before commit: a later resume does NOT publish (no done marker)', async () => {
        await seedIntent(redis, { fence: F1 });
        pub.stageResult(config(), { buildId: BUILD, jobId: JOB, fence: F1, buffer: buf('v1'), extension: EXT });

        const rec = await pub.resumePendingPublications(redis, config());
        expect(rec.resumed).to.equal(0);
        expect(fs.existsSync(canonicalPath())).to.equal(false);   // never auto-committed

        // a retry of the SAME fence completes the publication normally
        const out = await commit(redis, F1, 'v1');
        expect(out.status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    // ── 7. crash between the commit and the rename (restart recovery) ─────
    it('restart between commit and rename: resume replays the rename from the durable manifest', async () => {
        await seedIntent(redis, { fence: F1 });
        await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F1, 'EX', 1000);
        // stage + commit, "crash" before the rename (exactly the window)
        pub.stageResult(config(), { buildId: BUILD, jobId: JOB, fence: F1, buffer: buf('v1'), extension: EXT });
        await commitManifestOnly(redis, F1);
        expect(fs.existsSync(canonicalPath())).to.equal(false);

        // a fresh process resumes purely from Redis state + the staged file
        const rec = await pub.resumePendingPublications(redis, config());
        expect(rec.resumed).to.equal(1);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
        // idempotent: a second pass changes nothing
        const rec2 = await pub.resumePendingPublications(redis, config());
        expect(rec2.resumed).to.equal(0);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    it('resume removes only the staged leftover of an already-published fence', async () => {
        await seedIntent(redis, { fence: F1 });
        await commit(redis, F1, 'v1');
        // a stray staged file appears under the committed fence dir
        fs.writeFileSync(stagedPathFor(F1), 'stray');
        const rec = await pub.resumePendingPublications(redis, config());
        expect(rec.cleaned).to.equal(1);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    // ── 8. failure BEFORE the Redis CAS (fs-level) ────────────────────────
    it('a pre-commit fs failure never touches Redis or the canonical path', async () => {
        await seedIntent(redis, { fence: F1 });
        let threw = null;
        try {
            await pub.commitFencedResult(redis, config(), {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
                buildId: BUILD, fence: F1, buffer: Buffer.alloc(0), extension: EXT, canonicalPath: canonicalPath(),
            });
        } catch (err) { threw = err; }
        expect(threw && threw.code).to.equal('empty_result');
        expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
        expect(await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(null);
        expect(fs.existsSync(canonicalPath())).to.equal(false);
    });

    it('path traversal in buildId/jobId/fence is refused (invalid_stage_path)', async () => {
        await seedIntent(redis, { fence: F1 });
        for (const badBuild of ['..', '../evil', 'a/b', 'a\\b', '']) {
            let threw = null;
            try {
                await pub.commitFencedResult(redis, config(), {
                    bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
                    buildId: badBuild, fence: F1, buffer: buf('x'), extension: EXT, canonicalPath: canonicalPath(),
                });
            } catch (err) { threw = err; }
            expect(threw && threw.code, `buildId=${badBuild}`).to.equal('invalid_stage_path');
        }
        // a non-hex fence can never name a staging dir
        expect(pub.fenceDirFor(config(), { buildId: BUILD, jobId: JOB, fence: '../etc' })).to.equal(null);
        expect(pub.fenceDirFor(config(), { buildId: BUILD, jobId: JOB, fence: F1.toUpperCase() + 'ZZ' })).to.equal(null);
        expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
        expect(fs.existsSync(canonicalPath())).to.equal(false);
    });

    it('staging paths of distinct jobs can never collide, and stay inside the build dir', () => {
        const a = pub.fenceDirFor(config(), { buildId: BUILD, jobId: 'a:b', fence: F1 });
        const b = pub.fenceDirFor(config(), { buildId: BUILD, jobId: 'a%3Ab', fence: F1 });
        expect(a).to.not.equal(b);
        const root = pub.stagingRootFor(config(), BUILD);
        for (const dir of [a, b]) {
            expect(path.relative(root, dir).startsWith('..')).to.equal(false);
        }
        // a literal '..' segment in the encoded job id is REFUSED outright —
        // it can never name a directory outside the staging root
        expect(pub.fenceDirFor(config(), { buildId: BUILD, jobId: '..', fence: F1 })).to.equal(null);
        expect(pub.fenceDirFor(config(), { buildId: BUILD, jobId: '../..', fence: F1 })).to.equal(null);
    });

    // ── 9. failure AFTER the Redis CAS (rename) ───────────────────────────
    it('a rename failure after the commit is NOT a success: staged kept, no metadata', async () => {
        await seedIntent(redis, { fence: F1 });
        // occupy the canonical path with a DIRECTORY containing a file, so the
        // staged→canonical rename fails (EISDIR/ENOTEMPTY) AFTER the commit
        const canon = canonicalPath();
        fs.mkdirSync(canon, { recursive: true });
        fs.writeFileSync(path.join(canon, 'occupied'), 'x');

        let threw = null;
        try {
            await commit(redis, F1, 'v1');
        } catch (err) { threw = err; }
        expect(threw && threw.code).to.equal('publish_failed');
        // the commit IS durable in Redis, but nothing was published and the
        // metadata chain must not have run
        expect(await qidem.isTaskDone(redis, F1)).to.equal(true);
        // the staged bytes are kept so a resume can complete the rename
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(true);
        expect(fs.readFileSync(path.join(canon, 'occupied'), 'utf8')).to.equal('x');

        // operator/retry clears the obstacle → the replay publishes
        fs.rmSync(canon, { recursive: true, force: true });
        const rec = await pub.resumePendingPublications(redis, config());
        expect(rec.resumed).to.equal(1);
        expect(fs.readFileSync(canon, 'utf8')).to.equal('v1');
    });

    // ── 10. verdicts: stale / missing / corrupt / unavailable ─────────────
    it('intent_missing: no intent record → no publish, staged discarded', async () => {
        const out = await commit(redis, F1, 'v1');
        expect(out.status).to.equal('intent_missing');
        expect(fs.existsSync(canonicalPath())).to.equal(false);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false);
    });

    it('intent_corrupt: unparseable intent → no publish, staged discarded', async () => {
        await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), '{not json', 'EX', 1000);
        const out = await commit(redis, F1, 'v1');
        expect(out.status).to.equal('intent_corrupt');
        expect(fs.existsSync(canonicalPath())).to.equal(false);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(false);
    });

    it('a non-active intent (cancelled) blocks publication of its own fence', async () => {
        await seedIntent(redis, { fence: F1, state: 'cancelled' });
        const out = await commit(redis, F1, 'v1');
        expect(out.status).to.equal('stale_intent');
        expect(fs.existsSync(canonicalPath())).to.equal(false);
    });

    it('Redis unavailable at the commit → NOT a success, staged + claim kept', async () => {
        await seedIntent(redis, { fence: F1 });
        await redis.set(qidem.idemClaimKey(F1), 'pending', 'NX', 'EX', 1000);
        const down = { ...redis, eval: async () => { throw new Error('Connection is closed.'); } };
        const out = await pub.commitFencedResult(down, config(), {
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
            buildId: BUILD, fence: F1, buffer: buf('v1'), extension: EXT, canonicalPath: canonicalPath(),
        });
        expect(out.status).to.equal('unavailable');
        expect(fs.existsSync(canonicalPath())).to.equal(false);
        expect(fs.existsSync(stagedPathFor(F1))).to.equal(true);  // staged kept for a retry
        expect(await redis.get(qidem.idemClaimKey(F1))).to.equal('pending'); // claim kept
        expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
        // the retry succeeds and publishes
        const retry = await commit(redis, F1, 'v1');
        expect(retry.status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
    });

    it('a client without EVAL fails closed (unavailable) — no weaker read-check-write', async () => {
        const noEval = {};
        for (const k of Object.keys(redis)) {
            if (k === 'eval') continue;
            noEval[k] = typeof redis[k] === 'function' ? redis[k].bind(redis) : redis[k];
        }
        const out = await qidem.fenceCommitResult(noEval, {
            bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence: F1, manifest: {},
        });
        expect(out.status).to.equal('unavailable');
    });

    // ── 11. a foreign fence cannot reuse another fence's commit ───────────
    it('duplicate_same_fence is per-fence: another fence commits its own result', async () => {
        await seedIntent(redis, { fence: F1 });
        expect((await commit(redis, F1, 'v1')).status).to.equal('committed');
        // F2 becomes current; its FIRST commit must be `committed`, not a duplicate
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });
        expect((await commit(redis, F2, 'v2')).status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
    });

    // ── 12. canonical-path reuse across generations ───────────────────────
    it('canonical reuse: a supersede overwrites via rename, a stale redelivery cannot', async () => {
        await seedIntent(redis, { fence: F1 });
        await commit(redis, F1, 'v1');
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });
        await commit(redis, F2, 'v2');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
        // late redelivery of the already-committed F1 does NOT regress the file.
        // Stage 133 (audit 132 · B4): the intent check runs BEFORE the done
        // marker, so a superseded fence is `stale_intent` — its done marker no
        // longer answers `duplicate_same_fence` (which would authorize a rename).
        const late = await commit(redis, F1, 'late-v1');
        expect(late.status).to.equal('stale_intent');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
    });

    // ── 13. legacy files are preserved ────────────────────────────────────
    it('legacy canonical files are never moved or removed by staging/GC', async () => {
        fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
        fs.writeFileSync(canonicalPath(), 'legacy-bytes');
        // an uncommitted, stale fence dir of the SAME job appears in staging
        const staleDir = path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), F3);
        fs.mkdirSync(staleDir, { recursive: true });
        fs.writeFileSync(path.join(staleDir, 'artifact.png'), 'garbage');
        const old = Date.now() - (25 * 3600 * 1000);
        fs.utimesSync(staleDir, new Date(old), new Date(old));

        await seedIntent(redis, { fence: F1 }); // F1 is current; F3 is not committed
        const gc = await pub.collectStaleStaging(config(), redis, { now: Date.now() });
        expect(gc.removed).to.equal(1);
        expect(fs.existsSync(staleDir)).to.equal(false);
        // the legacy file is byte-identical
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('legacy-bytes');
    });

    it('GC never removes a young fence dir, a committed fence, or the current fence', async () => {
        // young (in-flight) fence dir
        const youngDir = path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), F3);
        fs.mkdirSync(youngDir, { recursive: true });
        fs.writeFileSync(path.join(youngDir, 'artifact.png'), 'in-flight');
        await seedIntent(redis, { fence: F1 });
        const gc1 = await pub.collectStaleStaging(config(), redis);
        expect(gc1.removed).to.equal(0);
        expect(fs.existsSync(youngDir)).to.equal(true);

        // age it out — still kept because F1... (F3 is neither current nor committed)
        const old = Date.now() - (25 * 3600 * 1000);
        fs.utimesSync(youngDir, new Date(old), new Date(old));
        const gc2 = await pub.collectStaleStaging(config(), redis);
        expect(gc2.removed).to.equal(1);

        // the CURRENT fence dir is never removed, however old
        const curDir = path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), F1);
        fs.mkdirSync(curDir, { recursive: true });
        fs.writeFileSync(path.join(curDir, 'artifact.png'), 'current');
        fs.utimesSync(curDir, new Date(old), new Date(old));
        const gc3 = await pub.collectStaleStaging(config(), redis);
        expect(gc3.removed).to.equal(0);
        expect(fs.existsSync(curDir)).to.equal(true);

        // a COMMITTED fence dir is never removed either
        await commit(redis, F1, 'v1');
        fs.mkdirSync(path.join(curDir), { recursive: true });
        fs.writeFileSync(path.join(curDir, 'artifact.png'), 'committed-leftover');
        fs.utimesSync(curDir, new Date(old), new Date(old));
        const gc4 = await pub.collectStaleStaging(config(), redis);
        expect(gc4.removed).to.equal(0);
    });

    it('GC aborts (removes nothing) when Redis errors — an outage must not look like "uncommitted"', async () => {
        const staleDir = path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), F3);
        fs.mkdirSync(staleDir, { recursive: true });
        fs.writeFileSync(path.join(staleDir, 'artifact.png'), 'garbage');
        const old = Date.now() - (25 * 3600 * 1000);
        fs.utimesSync(staleDir, new Date(old), new Date(old));

        const broken = { get: async () => { throw new Error('Connection is closed.'); } };
        const gc = await pub.collectStaleStaging(config(), broken);
        expect(fs.existsSync(staleDir)).to.equal(true);   // nothing deleted
        expect(gc.removed).to.equal(0);
    });

    // ── 14. the job→fence ref race (audit 130 · observation 2) ────────────
    it('a transiently overwritten ref (rejected stale sender) does not block the current commit', async () => {
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });
        // a rejected stale sender blind-SETs its own fence into the ref…
        await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F1, 'EX', 1000);
        // …and the current fence's result arrives while the ref disagrees
        const out = await commit(redis, F2, 'v2');
        expect(out.status).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
    });

    // ── 15. no false "ready": metadata only after a confirmed commit ──────
    it('a stale result never updates ready/complete metadata (handler-level)', async () => {
        // Exercise the handler branch that decides "publish + metadata".
        const calls = { completeStage: 0, saveIURegistry: 0 };
        const taskHandler = makeHandler(redis, calls);
        await seedDispatchMeta(redis, 'd1');
        await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1, history: [[F1, 0]] });

        let threw = null;
        try {
            await taskHandler.handleTaskResult(JOB, buf('stale-v1').toString('base64'), BUILD, 'd1', { fence: F1 });
        } catch (err) { threw = err; }
        expect(threw && threw.code).to.equal('stale_intent');
        expect(calls.completeStage).to.equal(0);
        expect(calls.saveIURegistry).to.equal(0);
        expect(fs.existsSync(canonicalPath())).to.equal(false);   // no canonical write
    });

    it('a committed result updates metadata only AFTER the commit (handler-level)', async () => {
        const calls = { completeStage: 0, saveIURegistry: 0 };
        const taskHandler = makeHandler(redis, calls);
        await seedDispatchMeta(redis, 'd1');
        await seedIntent(redis, { fence: F1 });
        await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F1, 'EX', 1000);

        const out = await taskHandler.handleTaskResult(JOB, buf('v1').toString('base64'), BUILD, 'd1', { fence: F1 });
        expect(out.fenced).to.equal(true);
        expect(out.commit).to.equal('committed');
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
        expect(calls.saveIURegistry).to.equal(1);   // ran only after the commit
        expect(calls.completeStage).to.equal(1);
    });

    it('kill-switch GPU_FENCING_MODE=off keeps the byte-for-byte legacy direct write', async () => {
        const calls = { completeStage: 0, saveIURegistry: 0 };
        const taskHandler = makeHandler(redis, calls, 'off');
        await seedDispatchMeta(redis, 'd1');
        // NO intent seeded and mode off: direct write, no staging, no commit
        const out = await taskHandler.handleTaskResult(JOB, buf('legacy').toString('base64'), BUILD, 'd1', { fence: F1 });
        expect(out.fenced).to.equal(false);
        expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('legacy');
        expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
    });
});

// ── helpers ───────────────────────────────────────────────────────────────

/** Commit to Redis (manifest + done) WITHOUT the fs rename — the crash window. */
async function commitManifestOnly(redis, fence) {
    const manifest = pub.buildCommitManifest({
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
        buildDir: path.join(tmpRoot, BUILD), fence,
        stagedPath: stagedPathFor(fence), canonicalPath: canonicalPath(), bytes: 2,
    });
    const verdict = await qidem.fenceCommitResult(redis, {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence, manifest,
    });
    expect(verdict.status).to.equal('committed');
}

/**
 * A handler double with the SAME decision branch as task-handler's fenced
 * path: resolve fence → stage → commit → publish → metadata. The metadata
 * callbacks are spies so "no false ready" is directly assertable.
 */
function makeHandler(redis, calls, mode = 'observe') {
    const config = { OUTPUT_DIR: tmpRoot, resultFencingMode: () => mode };
    const deps = {
        log: () => {},
        resolveAssetPath: (jobId, buildId) => ({
            type: 'iu_image', extension: 'png', fullPath: path.join(tmpRoot, buildId, CANON_NAME),
        }),
    };
    const taskHandlerFactory = require('../src/services/task-handler.cjs');
    const t = taskHandlerFactory(redis, config, {
        utils: deps,
        cleanupService: deps,
        audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {},
        placeholderAudio: {}, bookDiff: {},
        orchestrator: {
            completeStage: async () => { calls.completeStage++; },
        },
        saveIURegistry: async () => { calls.saveIURegistry++; },
        iuRepo: { getImageUnitsForScene: async () => [{ id: 'iu01' }] },
        getChunk: async () => ({}),
        saveChunk: async () => {},
    });
    return t;
}

// ── recovery-hook wiring (runtime-loop) ───────────────────────────────────

describe('Stage 131 recovery hook (runtime-loop wiring)', () => {
    const loopSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'runtime-loop.js'), 'utf8');

    it('executeReconcileCycle runs the staged-artifact recovery unconditionally, before the orchestration cycle', () => {
        const cycleIdx = loopSrc.indexOf('async function executeReconcileCycle');
        expect(cycleIdx, 'executeReconcileCycle exists').to.be.at.least(0);
        const body = loopSrc.slice(cycleIdx);
        expect(body.indexOf('resumePendingPublications'), 'recovery replay is wired into the cycle').to.be.at.least(0);
        expect(body.indexOf('collectStaleStaging'), 'staging GC is wired into the cycle (contract 126 §5.5)').to.be.at.least(0);
        // The hook must sit BEFORE the orchestration cycle call and must not
        // be gated by the fencing kill-switch (recovery is not a mode).
        expect(body.indexOf('resumePendingPublications')).to.be.lessThan(body.indexOf('reconcileCycle(redis'),
            'recovery runs before the orchestration cycle');
        expect(body.slice(0, body.indexOf('resumePendingPublications'))).to.not.match(/resultFencingMode|GPU_FENCING_MODE/,
            'recovery is unconditional (never behind the kill-switch)');
    });

    it('the recovery block is fail-closed (its own try/catch, cycle continues)', () => {
        const body = loopSrc.slice(loopSrc.indexOf('async function executeReconcileCycle'));
        const hook = body.slice(body.indexOf('// Stage 131 — staged-artifact recovery'), body.indexOf('Starting periodic reconciliation cycle'));
        expect(hook.includes('try {') && hook.includes('} catch'), 'hook wrapped in its own try/catch').to.equal(true);
    });
});
