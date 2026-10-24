// =====================================================
// Stage 135 — publication consistency (audit 134 B6)
// =====================================================
// The audit showed that `done`/manifest prove a COMMIT, never that the staged
// bytes reached the canonical path — and the canonical path is shared by every
// generation of the same task. These regressions pin the new publication state
// machine (`publishCommittedFence`) and the durable publication marker:
//
//   R1  rename failure → retry of the CURRENT fence publishes it (no false
//       success over the previous generation's file);
//   R2  crash between commit and rename (all three marker windows) → recovery
//       publishes the CURRENT fence and never deletes its staged bytes;
//   R3  a superseded fence can neither publish nor disturb the current one;
//   R4  a redelivery of an already published fence stays idempotent;
//   R5  marker/Redis failures are controlled failures — no false success and
//       no loss of the only committed copy;
//   R6  a rejected (receipt-less) callback gains no publication evidence at all.
//
// Redis verdicts use the independent mirror of FENCE_COMMIT_SCRIPT
// (tests/mocks/redis-mock.js); the real Lua + real Redis run lives in the
// Stage 135 harness (audit-135/), which executes the same scenarios.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const pub = require('../src/services/result-publication.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const artifactNaming = require('@animastor/generation').artifactNaming;

const BOOK = 'book-s135';
const CHAPTER = 'ch-s135';
const SCENE = 'sc-s135';
const BUILD = 'build-s135';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const JOB = `${PREFIX}_0001:audio`;
const EXT = '.mp3';

function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'audio', buildId: BUILD,
        params: { text: 'stage-135' }, generationEpoch: epoch,
    });
}
const F1 = fenceFor(0);
const F2 = fenceFor(1);

const buf = (t) => Buffer.from(t, 'utf8');
const b64 = (t) => buf(t).toString('base64');

let tmpRoot;
const config = () => ({ OUTPUT_DIR: tmpRoot });
const canonicalPath = () => path.join(tmpRoot, BUILD, `${PREFIX}_0001${EXT}`);
const stagedPathFor = (fence) => path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), fence, `artifact${EXT}`);
const readCanonical = () => (fs.existsSync(canonicalPath()) ? fs.readFileSync(canonicalPath(), 'utf8') : null);

async function seedIntent(redis, fence, epoch = 0) {
    await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), JSON.stringify({
        fence, state: 'active', epoch: String(epoch), supersedes: null, updated_at: Date.now(), history: [],
    }), 'EX', qidem.IDEM_INTENT_TTL_S);
}
async function seedReceipt(redis, dispatchId, fence) {
    await redis.set(qidem.dispatchReceiptKey(dispatchId, JOB), fence, 'EX', qidem.IDEM_RECEIPT_TTL_S);
}
async function seedDispatchMeta(redis, dispatchId) {
    await dispatch.setDispatchMetadata(redis, BOOK, CHAPTER, SCENE, 'audio', {
        dispatch_id: dispatchId, stage: 'audio', started_at: Date.now(), worker: 'scheduler',
        retry_attempt: 0, status: 'dispatched',
    });
}

function makeHandler(redis, calls = {}, deps = {}) {
    return taskHandlerFactory(redis, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, {
        utils: { log: () => {} },
        cleanupService: {
            resolveAssetPath: (jobId, buildId) => ({
                type: 'audio_chunk', extension: 'mp3',
                fullPath: path.join(tmpRoot, buildId, `${String(jobId).replace(/:audio$/, '')}.mp3`),
            }),
        },
        audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {}, placeholderAudio: {}, bookDiff: {},
        orchestrator: { completeStage: async () => {} },
        saveIURegistry: async () => {},
        iuRepo: { getImageUnitsForScene: async () => [] },
        getChunk: async () => null,
        saveChunk: async () => { calls.saveChunk = (calls.saveChunk || 0) + 1; },
        ...deps,
    });
}

async function publish(redis, fence, text) {
    return pub.commitFencedResult(redis, config(), {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
        fence, buffer: buf(text), extension: EXT, canonicalPath: canonicalPath(),
    });
}

/** Stage + durable commit WITHOUT the publication (a crash before the rename). */
async function commitOnly(redis, fence, text) {
    const staged = pub.stageResult(config(), {
        buildId: BUILD, jobId: JOB, fence, buffer: buf(text), extension: EXT,
    });
    const manifest = pub.buildCommitManifest({
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
        buildDir: path.join(tmpRoot, BUILD), fence,
        stagedPath: staged.stagedPath, canonicalPath: canonicalPath(), bytes: staged.bytes,
    });
    const verdict = await qidem.fenceCommitResult(redis, {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence, manifest,
    });
    expect(verdict.status).to.equal('committed');
}

async function marker(redis) {
    const read = await qidem.readFencePublication(redis, {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
    });
    return read.status === 'ok' ? read.marker : null;
}

/** A filesystem that refuses the staged → canonical rename only. */
function failingPublishFs() {
    const impl = Object.assign(Object.create(null), fs);
    impl.renameSync = (from, to) => {
        if (!String(to).includes('.staging')) throw new Error('EACCES: simulated publish failure');
        return fs.renameSync(from, to);
    };
    return impl;
}

/** A Redis proxy whose writes of the publication marker fail. */
function redisWithFailingMarkerSet(base) {
    return new Proxy(base, {
        get(target, prop) {
            if (prop === 'set') {
                return async (key, ...rest) => {
                    if (String(key).startsWith(qidem.IDEM_PUBLISH_PREFIX)) throw new Error('OOM command not allowed');
                    return target.set(key, ...rest);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** A Redis proxy whose reads of the publication marker fail. */
function redisWithFailingMarkerGet(base) {
    return new Proxy(base, {
        get(target, prop) {
            if (prop === 'get') {
                return async (key) => {
                    if (String(key).startsWith(qidem.IDEM_PUBLISH_PREFIX)) throw new Error('LOADING Redis is loading the dataset');
                    return target.get(key);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

describe('Stage 135 — publication consistency (audit 134 B6)', () => {
    let redis;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's135-'));
        redis = createMockRedis();
    });
    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // ── R1 — rename failure, then retry of the CURRENT fence ──────────────
    describe('R1: publish_failed then retry publishes the current fence', () => {
        it('a retry over the previous generation\'s file replaces canonical and only then marks ready', async () => {
            await seedIntent(redis, F1, 0);
            expect((await publish(redis, F1, 'F1-BYTES')).status).to.equal('committed');
            expect(readCanonical()).to.equal('F1-BYTES');

            // regeneration: F2 is committed, but the rename fails in-process
            await seedIntent(redis, F2, 1);
            await seedReceipt(redis, 'd2', F2);
            await seedDispatchMeta(redis, 'd2');
            let threw = null;
            try {
                await pub.commitFencedResult(redis, config(), {
                    bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
                    fence: F2, buffer: buf('F2-BYTES'), extension: EXT, canonicalPath: canonicalPath(),
                }, { fs: failingPublishFs() });
            } catch (err) { threw = err; }
            expect(threw && threw.code).to.equal('publish_failed');
            // no false success: canonical still holds F1, the F2 bytes are staged
            expect(readCanonical()).to.equal('F1-BYTES');
            expect(fs.existsSync(stagedPathFor(F2))).to.equal(true);
            expect((await marker(redis)).stage).to.equal('renaming');

            // the hub retries the SAME fence through the production handler
            const calls = {};
            const handler = makeHandler(redis, calls);
            const retry = await handler.handleTaskResult(JOB, b64('F2-BYTES'), BUILD, 'd2');

            expect(retry.fenced).to.equal(true);
            expect(retry.commit).to.equal('duplicate_same_fence');
            expect(readCanonical(), 'canonical now holds the CURRENT fence').to.equal('F2-BYTES');
            expect(fs.existsSync(stagedPathFor(F2))).to.equal(false);
            const manifest = await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(manifest.published_fence).to.equal(F2);
            expect(await qidem.isTaskDone(redis, F2)).to.equal(true);
            expect((await marker(redis))).to.deep.include({ fence: F2, stage: 'published' });
            expect(calls.saveChunk, 'ready metadata only after the verified publication').to.be.at.least(1);
        });

        it('a rename failure never marks the publication as complete', async () => {
            await seedIntent(redis, F1, 0);
            let threw = null;
            try {
                await pub.commitFencedResult(redis, config(), {
                    bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
                    fence: F1, buffer: buf('v1'), extension: EXT, canonicalPath: canonicalPath(),
                }, { fs: failingPublishFs() });
            } catch (err) { threw = err; }
            expect(threw && threw.code).to.equal('publish_failed');
            expect(readCanonical()).to.equal(null);
            expect((await marker(redis)), 'a failed rename is not a publication').to.deep.include({ stage: 'renaming' });
        });
    });

    // ── R2 — crash windows between commit and rename ──────────────────────
    describe('R2: recovery publishes the current fence (every crash window)', () => {
        it('window 1 — crash right after the commit, before the marker: resume publishes F2', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            await seedIntent(redis, F2, 1);
            await commitOnly(redis, F2, 'F2-BYTES');
            expect(readCanonical()).to.equal('F1-BYTES');
            expect(fs.existsSync(stagedPathFor(F2)), 'the only copy of F2 must survive').to.equal(true);

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.resumed).to.equal(1);
            expect(rec.cleaned).to.equal(0);
            expect(readCanonical()).to.equal('F2-BYTES');
            expect(fs.existsSync(stagedPathFor(F2))).to.equal(false);
            expect((await marker(redis))).to.deep.include({ fence: F2, stage: 'published' });
            const again = await pub.resumePendingPublications(redis, config());
            expect(again.resumed).to.equal(0);
            expect(readCanonical()).to.equal('F2-BYTES');
        });

        it('window 2 — crash after the "renaming" marker, before the rename: resume completes it', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            await seedIntent(redis, F2, 1);
            await commitOnly(redis, F2, 'F2-BYTES');
            await qidem.markFencePublication(redis, {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence: F2, stage: 'renaming',
            });

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.resumed).to.equal(1);
            expect(readCanonical()).to.equal('F2-BYTES');
            expect((await marker(redis)).stage).to.equal('published');
        });

        it('window 3 — crash after the rename, before the "published" marker: resume verifies, deletes nothing', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            await seedIntent(redis, F2, 1);
            await commitOnly(redis, F2, 'F2-BYTES');
            await qidem.markFencePublication(redis, {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence: F2, stage: 'renaming',
            });
            fs.renameSync(stagedPathFor(F2), canonicalPath());        // the rename landed, the marker did not
            expect(readCanonical()).to.equal('F2-BYTES');

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.resumed).to.equal(1);
            expect(readCanonical()).to.equal('F2-BYTES');
            expect((await marker(redis))).to.deep.include({ fence: F2, stage: 'published' });
        });

        it('a committed fence with neither staged nor canonical bytes is never reported as published', async () => {
            await seedIntent(redis, F1, 0);
            await commitOnly(redis, F1, 'v1');
            fs.rmSync(stagedPathFor(F1), { force: true });

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.resumed).to.equal(0);
            expect(rec.orphans).to.equal(1);
            expect(readCanonical()).to.equal(null);
        });
    });

    // ── R3 — a superseded fence can never publish ─────────────────────────
    describe('R3: a superseded fence cannot publish or disturb the current one', () => {
        it('late F1 after F2 became current: no canonical write, F2 state intact', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            await seedIntent(redis, F2, 1);
            pub.stageResult(config(), {
                buildId: BUILD, jobId: JOB, fence: F2, buffer: buf('F2-STAGED'), extension: EXT,
            });

            // a replay of F1 arrives with its staged bytes and a live receipt
            await seedReceipt(redis, 'd1', F1);
            const late = await pub.commitFencedResult(redis, config(), {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
                fence: F1, buffer: buf('LATE-F1'), extension: EXT, canonicalPath: canonicalPath(),
            });

            expect(late.status).to.equal('stale_intent');
            expect(readCanonical()).to.equal('F1-BYTES');
            expect(fs.existsSync(stagedPathFor(F2)), 'the current fence\'s staged bytes survive').to.equal(true);
            expect(fs.existsSync(stagedPathFor(F1)), 'only the stale fence\'s own staging is discarded').to.equal(false);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(true);          // from its own earlier commit
            expect(await qidem.isTaskDone(redis, F2)).to.equal(false);

            // and the current fence still publishes afterwards
            await seedReceipt(redis, 'd2', F2);
            const ok = await publish(redis, F2, 'F2-BYTES');
            expect(ok.status).to.equal('committed');
            expect(readCanonical()).to.equal('F2-BYTES');
        });

        it('resume never replays a superseded manifest (B4 unchanged)', async () => {
            await seedIntent(redis, F1, 0);
            await commitOnly(redis, F1, 'v1');
            await seedIntent(redis, F2, 1);

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.resumed).to.equal(0);
            expect(rec.superseded).to.equal(1);
            expect(readCanonical()).to.equal(null);
        });
    });

    // ── R4 — redelivery of an already published fence ─────────────────────
    describe('R4: a published fence stays idempotent', () => {
        it('a redelivery does not flap the canonical file and does not re-stage', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');

            const again = await publish(redis, F1, 'F1-REDELIVERY-DIFFERENT-BYTES');

            expect(again.status).to.equal('duplicate_same_fence');
            expect(again.published).to.equal(false);
            expect(again.publication).to.equal('already_published');
            expect(readCanonical()).to.equal('F1-BYTES');
            expect(fs.existsSync(stagedPathFor(F1)), 'the redelivery staged bytes are cleaned up').to.equal(false);
            expect((await marker(redis))).to.deep.include({ fence: F1, stage: 'published' });
        });

        it('a stray staged leftover of a published fence is cleaned by resume only', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            fs.writeFileSync(stagedPathFor(F1), 'stray');

            const rec = await pub.resumePendingPublications(redis, config());

            expect(rec.cleaned).to.equal(1);
            expect(rec.resumed).to.equal(0);
            expect(readCanonical()).to.equal('F1-BYTES');
        });
    });

    // ── R5 — marker / Redis failures are controlled ───────────────────────
    describe('R5: marker and Redis failures fail closed and recover', () => {
        it('a marker write failure before the rename aborts the publication, staged bytes survive', async () => {
            await seedIntent(redis, F1, 0);
            const flaky = redisWithFailingMarkerSet(redis);
            let threw = null;
            try {
                await pub.commitFencedResult(flaky, config(), {
                    bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
                    fence: F1, buffer: buf('v1'), extension: EXT, canonicalPath: canonicalPath(),
                });
            } catch (err) { threw = err; }

            expect(threw && threw.code).to.equal('publish_failed');
            expect(readCanonical(), 'no blind rename without a durable marker').to.equal(null);
            expect(fs.existsSync(stagedPathFor(F1)), 'the committed bytes are kept').to.equal(true);

            // the next recovery pass (healthy Redis) publishes it
            const rec = await pub.resumePendingPublications(redis, config());
            expect(rec.resumed).to.equal(1);
            expect(readCanonical()).to.equal('v1');
        });

        it('a marker read failure during recovery writes and deletes nothing', async () => {
            await seedIntent(redis, F1, 0);
            await commitOnly(redis, F1, 'v1');
            const flaky = redisWithFailingMarkerGet(redis);

            const rec = await pub.resumePendingPublications(flaky, config());

            expect(rec.resumed).to.equal(0);
            expect(rec.errors).to.equal(1);
            expect(readCanonical()).to.equal(null);
            expect(fs.existsSync(stagedPathFor(F1)), 'the only copy survives a Redis outage').to.equal(true);

            const healthy = await pub.resumePendingPublications(redis, config());
            expect(healthy.resumed).to.equal(1);
            expect(readCanonical()).to.equal('v1');
        });

        it('a deleted canonical file of the current fence is republished from a redelivery', async () => {
            await seedIntent(redis, F1, 0);
            await publish(redis, F1, 'F1-BYTES');
            fs.rmSync(canonicalPath());

            const again = await publish(redis, F1, 'F1-BYTES');

            expect(again.published).to.equal(true);
            expect(readCanonical()).to.equal('F1-BYTES');
        });
    });

    // ── R6 — a rejected callback gains no publication evidence ────────────
    describe('R6: rejected callbacks never touch the publication state', () => {
        it('no receipt → receipt_missing, no marker, no canonical, no metadata', async () => {
            await seedIntent(redis, F2, 1);
            await seedDispatchMeta(redis, 'd1');
            const calls = {};
            const handler = makeHandler(redis, calls);

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('STALE'), BUILD, 'd1'); } catch (err) { threw = err; }

            expect(threw && threw.code).to.equal('receipt_missing');
            expect(readCanonical()).to.equal(null);
            expect(await marker(redis), 'a rejected callback cannot create publication evidence').to.equal(null);
            expect(calls.saveChunk || 0).to.equal(0);
            expect(await qidem.isTaskDone(redis, F2)).to.equal(false);
        });

        it('a superseded receipt → stale_intent, no marker, no canonical', async () => {
            await seedIntent(redis, F2, 1);
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const handler = makeHandler(redis, {});

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('STALE'), BUILD, 'd1'); } catch (err) { threw = err; }

            expect(threw && threw.code).to.equal('stale_intent');
            expect(readCanonical()).to.equal(null);
            expect(await marker(redis)).to.equal(null);
        });
    });

    // ── normal path ───────────────────────────────────────────────────────
    describe('normal fenced callback', () => {
        it('committed → canonical, manifest, done and the publication marker agree', async () => {
            await seedIntent(redis, F1, 0);
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const calls = {};
            const handler = makeHandler(redis, calls);

            const res = await handler.handleTaskResult(JOB, b64('v1'), BUILD, 'd1');

            expect(res.fenced).to.equal(true);
            expect(res.commit).to.equal('committed');
            expect(readCanonical()).to.equal('v1');
            expect((await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).published_fence).to.equal(F1);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(true);
            expect(await marker(redis)).to.deep.include({ fence: F1, stage: 'published' });
            expect(calls.saveChunk || 0).to.be.at.least(1);
        });
    });
});
