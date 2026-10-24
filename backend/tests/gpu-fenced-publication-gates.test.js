// =====================================================
// Stage 133 — fenced publication gates (audit 132 B1–B5)
// =====================================================
// Regression battery for the five blockers of the independent Stage 132
// audit. Every case reproduces the ORIGINAL audit scenario and asserts the
// post-fix, fail-closed behaviour:
//
//   B1 — a callback without an immutable receipt must not reach the legacy
//        direct-write path (no canonical file, no chunk/ready metadata);
//   B2 — the mutable job→fence ref is NOT a fence resolver: a stale callback
//        whose ref points at the CURRENT fence is rejected, it never commits
//        stale bytes under the live generation;
//   B5 — a Redis read error is not "no receipt": the gate fails closed as a
//        retryable failure and writes nothing;
//   B3 — the debug audio recovery (`recoverAudioForScene`) checks dispatch
//        identity + fence BEFORE any file/metadata write;
//   B4 — a done marker of a superseded fence can neither re-publish its staged
//        bytes nor be replayed by `resumePendingPublications`.
//
// The Redis verdicts run against the independent mirror of
// FENCE_COMMIT_SCRIPT (tests/mocks/redis-mock.js); the script itself is
// executed for real against an isolated redis:7 by the Stage 133 harness
// (audit-133/) — no mock is claimed as proof of the Lua.

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const pub = require('../src/services/result-publication.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const audioRecoveryFactory = require('../src/services/audio-recovery.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const artifactNaming = require('@animastor/generation').artifactNaming;

const BOOK = 'book-s133';
const CHAPTER = 'ch-s133';
const SCENE = 'sc-s133';
const BUILD = 'build-s133';
const JOB = `${artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE)}_0001:audio`;
const AUDIO_EXT = '.mp3';

function params() { return { '120': { text: 'hello' } }; }
function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'audio', buildId: BUILD, params: params(), generationEpoch: epoch,
    });
}
const F1 = fenceFor(0);
const F2 = fenceFor(1);

function buf(text) { return Buffer.from(text, 'utf8'); }
function b64(text) { return buf(text).toString('base64'); }

let tmpRoot;
function config() { return { OUTPUT_DIR: tmpRoot }; }

function sceneName() { return artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE); }
// The audio_chunk canonical artifact of `{prefix}_0001:audio` is `{prefix}_0001.mp3`
// (cleanup-service.resolveAssetPath) — the same path the legacy recovery wrote
// directly, which is exactly why an ungated recovery published stale bytes.
function canonicalPath() { return path.join(tmpRoot, BUILD, `${sceneName()}_0001${AUDIO_EXT}`); }
function stagedPathFor(fence) {
    return path.join(tmpRoot, BUILD, '.staging', encodeURIComponent(JOB), fence, 'artifact' + AUDIO_EXT);
}

async function seedIntent(redis, { fence, epoch = 0, state = 'active', supersedes = null }) {
    await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), JSON.stringify({
        fence, state, epoch: String(epoch), supersedes, updated_at: Date.now(), history: [],
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

/** Stage the bytes and commit them WITHOUT the publish (a crash window). */
async function commitOnly(redis, fence, text) {
    const staged = pub.stageResult(config(), {
        buildId: BUILD, jobId: JOB, fence, buffer: buf(text), extension: AUDIO_EXT,
    });
    const manifest = pub.buildCommitManifest({
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, buildId: BUILD,
        buildDir: path.join(tmpRoot, BUILD), fence,
        stagedPath: staged.stagedPath, canonicalPath: canonicalPath(), bytes: staged.bytes,
    });
    const verdict = await qidem.fenceCommitResult(redis, {
        bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, fence, manifest,
    });
    expect(verdict.status, 'commit-only helper commits the fence').to.equal('committed');
    expect(fs.existsSync(canonicalPath()), 'the crash window leaves no canonical file').to.equal(false);
    return manifest;
}

/** A Redis proxy whose GET of `needle` keys throws (a transient outage). */
function redisWithFailingGet(base, needle) {
    return new Proxy(base, {
        get(target, prop) {
            if (prop === 'get') {
                return async (key) => {
                    if (String(key).includes(needle)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
                    return target.get(key);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function makeHandler(redis, opts = {}) {
    const calls = opts.calls || {};
    const mode = opts.mode || 'observe';
    const handlerConfig = {
        OUTPUT_DIR: tmpRoot,
        resultFencingMode: () => mode,
    };
    const deps = {
        utils: { log: () => {} },
        cleanupService: {
            resolveAssetPath: (jobId, buildId) => {
                const assetId = String(jobId).replace(/:audio$/, '');
                return { type: 'audio_chunk', extension: 'mp3', fullPath: path.join(tmpRoot, buildId, `${assetId}.mp3`) };
            },
        },
        audio: {}, image: {}, video: {}, state: {}, book: {},
        activeScenes: {}, placeholderAudio: {}, bookDiff: {},
        orchestrator: { completeStage: async () => { calls.completeStage = (calls.completeStage || 0) + 1; } },
        saveIURegistry: async () => {},
        iuRepo: { getImageUnitsForScene: async () => [] },
        getChunk: async () => null,
        saveChunk: async () => { calls.saveChunk = (calls.saveChunk || 0) + 1; },
    };
    return { handler: taskHandlerFactory(redis, handlerConfig, deps), calls };
}

function makeRecovery(redis, opts = {}) {
    const calls = opts.calls || { handler: [] };
    return audioRecoveryFactory(redis, config(), {
        audio: { isSceneAudioReady: async () => false },
        image: {}, state: {}, book: {}, orchestrator: {},
        taskHandler: {
            handleTaskResult: async (...args) => {
                calls.handler.push(args);
                if (opts.handlerError) throw opts.handlerError;
                return { fenced: true, fence: args[4] && args[4].fence, commit: 'committed' };
            },
        },
        getChunk: async () => null,
        saveChunk: async () => { calls.saveChunk = (calls.saveChunk || 0) + 1; },
        utils: { log: () => {} },
    });
}

async function postResult(base, body) {
    const res = await fetch(`${base}/gpu/task/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

function resultBody(overrides = {}) {
    return {
        job_id: JOB,
        build_id: BUILD,
        dispatch_id: 'd1',
        protocol_version: 2,
        result_base64: `data:audio/mp3;base64,${b64('FRESH')}`,
        ...overrides,
    };
}

describe('Stage 133 — fenced publication gates (audit 132)', () => {
    let redis;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's133-'));
        redis = createMockRedis();
    });
    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // ── B1 / B2 — handler gate: receipt only, no ref fallback ─────────────
    describe('B1/B2: a callback without an immutable receipt never writes', () => {
        it('stale callback without receipt, ref pointing at the CURRENT fence → receipt_missing, nothing written', async () => {
            // F2 is the live generation; the stale d1 callback has no receipt at
            // all, while the mutable ref points at F2 (the audit 132 · T1/T2 setup).
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F2, 'EX', 1000);
            await seedDispatchMeta(redis, 'd1');
            const { handler, calls } = makeHandler(redis);

            let threw = null;
            try {
                await handler.handleTaskResult(JOB, b64('STALE-F1'), BUILD, 'd1');
            } catch (err) { threw = err; }

            expect(threw, 'the handler rejects instead of using the legacy path').to.be.instanceOf(Error);
            expect(threw.code).to.equal('receipt_missing');
            expect(fs.existsSync(canonicalPath()), 'no canonical write').to.equal(false);
            expect(calls.saveChunk || 0, 'no chunk/ready metadata').to.equal(0);
            expect(await qidem.isTaskDone(redis, F2), 'no done marker of the live fence').to.equal(false);
            expect(await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB), 'no manifest').to.equal(null);
        });

        it('an expired/absent receipt is NOT a reason to fall back to a direct write', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedDispatchMeta(redis, 'd1');   // receipt never written / TTL expired
            const { handler } = makeHandler(redis);

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('STALE'), BUILD, 'd1'); } catch (err) { threw = err; }
            expect(threw && threw.code).to.equal('receipt_missing');
            expect(fs.existsSync(canonicalPath())).to.equal(false);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
        });
    });

    // ── B5 — Redis read errors fail closed ───────────────────────────────
    describe('B5: a Redis read error is retryable and writes nothing', () => {
        it('receipt GET failure → fence_lookup_unavailable, no canonical/metadata write', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const flaky = redisWithFailingGet(redis, 'dispatch-intent');
            const { handler, calls } = makeHandler(flaky);

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('v1'), BUILD, 'd1'); } catch (err) { threw = err; }

            expect(threw && threw.code).to.equal('fence_lookup_unavailable');
            expect(qidem.FENCE_COMMIT_REJECTED.has('fence_lookup_unavailable'), 'retryable, not terminal').to.equal(false);
            expect(fs.existsSync(canonicalPath())).to.equal(false);
            expect(calls.saveChunk || 0).to.equal(0);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
        });

        it('route answers 503 retryable (never the legacy write) on a receipt read error', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const flaky = redisWithFailingGet(redis, 'dispatch-intent');
            const calls = [];
            const { base, close } = await mountRoute(flaky, {
                taskHandler: { handleTaskResult: async () => { calls.push('handler'); return { fenced: true }; } },
            });
            try {
                const out = await postResult(base, resultBody());
                expect(out.status).to.equal(503);
                expect(out.body).to.have.property('retryable', true);
                expect(calls.length, 'the handler was never called').to.equal(0);
                expect(fs.existsSync(canonicalPath())).to.equal(false);
            } finally { await close(); }
        });
    });

    // ── route gate: current callback works, ref is never a resolver ───────
    describe('route: receipt-only fence resolution', () => {
        it('a current callback with a receipt publishes through the fenced path', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const seen = [];
            const { base, close } = await mountRoute(redis, {
                taskHandler: {
                    handleTaskResult: async (jobId, data, buildId, dispatchId, opts) => {
                        seen.push({ jobId, buildId, dispatchId, fence: opts && opts.fence });
                        return { fenced: true, fence: opts && opts.fence, commit: 'committed' };
                    },
                },
            });
            try {
                const out = await postResult(base, resultBody());
                expect(out.status).to.equal(200);
                expect(out.body).to.deep.equal({ ok: true });
                expect(seen.length).to.equal(1);
                expect(seen[0].fence, 'the fence comes from the immutable receipt').to.equal(F1);
            } finally { await close(); }
        });

        it('a stale callback whose ref points at the current fence is rejected, the ref is ignored (B2)', async () => {
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await redis.set(qidem.idemRefKey(BOOK, CHAPTER, SCENE, JOB), F2, 'EX', 1000);
            await seedDispatchMeta(redis, 'd1');            // NO receipt for d1
            let handlerCalls = 0;
            const { base, close } = await mountRoute(redis, {
                taskHandler: { handleTaskResult: async () => { handlerCalls++; return { fenced: true }; } },
            });
            try {
                const out = await postResult(base, resultBody({ result_base64: `data:audio/mp3;base64,${b64('STALE-F1')}` }));
                expect(out.status).to.equal(200);
                expect(out.body).to.deep.equal({ ok: true, rejected: true, reason: 'receipt_missing' });
                expect(handlerCalls, 'nothing reached the write path').to.equal(0);
                expect(fs.existsSync(canonicalPath())).to.equal(false);
                expect(await qidem.isTaskDone(redis, F2)).to.equal(false);
            } finally { await close(); }
        });

        it('a corrupt receipt value is rejected as receipt_corrupt (no staging, no write)', async () => {
            await seedIntent(redis, { fence: F1 });
            await redis.set(qidem.dispatchReceiptKey('d1', JOB), 'not-a-fence', 'EX', 1000);
            await seedDispatchMeta(redis, 'd1');
            const { handler } = makeHandler(redis);

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('v1'), BUILD, 'd1'); } catch (err) { threw = err; }
            expect(threw && threw.code).to.equal('receipt_corrupt');
            expect(fs.existsSync(canonicalPath())).to.equal(false);
        });

        it('the explicit GPU_FENCING_MODE=off kill-switch still writes directly (documented override)', async () => {
            // The kill-switch is the ONLY legacy writer left and requires an
            // explicit operator action; every automatic mode rejects above.
            await seedIntent(redis, { fence: F1 });
            await seedDispatchMeta(redis, 'd1');
            const { handler } = makeHandler(redis, { mode: 'off' });

            const out = await handler.handleTaskResult(JOB, b64('KILL-SWITCH'), BUILD, 'd1');
            expect(out.fenced).to.equal(false);
            expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('KILL-SWITCH');
            expect(await qidem.isTaskDone(redis, F1), 'the kill-switch never writes fenced state').to.equal(false);
        });
    });

    // ── successful fenced publication (the control) ───────────────────────
    describe('control: the current fenced callback still publishes', () => {
        it('receipt + current intent → canonical bytes, manifest and done marker', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const { handler, calls } = makeHandler(redis);

            const out = await handler.handleTaskResult(JOB, b64('v1'), BUILD, 'd1');
            expect(out.fenced, 'reported as fenced (the route skips legacy settlement)').to.equal(true);
            expect(out.commit).to.equal('committed');
            expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
            expect(calls.saveChunk || 0, 'chunk metadata written after the commit').to.be.at.least(1);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(true);
            expect((await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).published_fence).to.equal(F1);
        });

        it('receipt of a superseded fence → stale_intent, nothing written', async () => {
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await seedReceipt(redis, 'd1', F1);           // the stale dispatch HAS a receipt
            await seedDispatchMeta(redis, 'd1');
            const { handler, calls } = makeHandler(redis);

            let threw = null;
            try { await handler.handleTaskResult(JOB, b64('STALE-F1'), BUILD, 'd1'); } catch (err) { threw = err; }
            expect(threw && threw.code).to.equal('stale_intent');
            expect(fs.existsSync(canonicalPath())).to.equal(false);
            expect(calls.saveChunk || 0).to.equal(0);
            expect(await qidem.isTaskDone(redis, F1)).to.equal(false);
            expect(fs.existsSync(stagedPathFor(F1)), 'own staged bytes discarded').to.equal(false);
        });
    });

    // ── B3 — debug audio recovery is gated before any write ───────────────
    describe('B3: recoverAudioForScene gates before writing', () => {
        function seedResultKey(payload) {
            return redis.set(
                `animastor:result:${BUILD}:${BOOK}:${CHAPTER}:${SCENE}:audio`,
                JSON.stringify(payload), 'EX', 3600,
            );
        }

        it('missing dispatch identity → missing_dispatch_id, file and metadata untouched', async () => {
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await seedResultKey({ job_id: JOB, result_base64: b64('STALE-RECOVERY'), build_id: BUILD });
            const calls = { handler: [] };
            const recovery = makeRecovery(redis, { calls });

            const out = await recovery.recoverAudioForScene(BOOK, CHAPTER, SCENE, BUILD);
            expect(out.recovered).to.equal(false);
            expect(out.reason).to.equal('missing_dispatch_id');
            expect(fs.existsSync(canonicalPath()), 'no scene audio written').to.equal(false);
            expect(calls.saveChunk || 0, 'no ready metadata').to.equal(0);
            expect(calls.handler.length, 'the handler was never invoked').to.equal(0);
            // the unprovable replay key is preserved for an operator
            expect(await redis.get(`animastor:result:${BUILD}:${BOOK}:${CHAPTER}:${SCENE}:audio`)).to.not.equal(null);
        });

        it('absent receipt → receipt_missing, nothing written', async () => {
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await seedDispatchMeta(redis, 'd1');           // no receipt
            await seedResultKey({ job_id: JOB, result_base64: b64('STALE'), build_id: BUILD, dispatch_id: 'd1' });
            const calls = { handler: [] };
            const recovery = makeRecovery(redis, { calls });

            const out = await recovery.recoverAudioForScene(BOOK, CHAPTER, SCENE, BUILD);
            expect(out.recovered).to.equal(false);
            expect(out.reason).to.equal('receipt_missing');
            expect(fs.existsSync(canonicalPath())).to.equal(false);
            expect(calls.saveChunk || 0).to.equal(0);
            expect(calls.handler.length).to.equal(0);
        });

        it('a gated recovery delegates to the production handler with the receipt fence', async () => {
            await seedIntent(redis, { fence: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            await seedResultKey({ job_id: JOB, result_base64: b64('FRESH'), build_id: BUILD, dispatch_id: 'd1' });
            const calls = { handler: [] };
            const recovery = makeRecovery(redis, { calls });

            const out = await recovery.recoverAudioForScene(BOOK, CHAPTER, SCENE, BUILD);
            expect(out.recovered).to.equal(true);
            expect(out.reason).to.equal('success');
            expect(calls.handler.length).to.equal(1);
            expect(calls.handler[0][3], 'dispatch identity is forwarded').to.equal('d1');
            expect(calls.handler[0][4].fence, 'the receipt fence is forwarded').to.equal(F1);
            // success drops the replay key
            expect(await redis.get(`animastor:result:${BUILD}:${BOOK}:${CHAPTER}:${SCENE}:audio`)).to.equal(null);
        });

        it('a handler fence reject leaves the file/metadata untouched', async () => {
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            await seedResultKey({ job_id: JOB, result_base64: b64('STALE'), build_id: BUILD, dispatch_id: 'd1' });
            const calls = { handler: [] };
            const err = new Error('Rejected task result: stale_intent');
            err.code = 'stale_intent';
            const recovery = makeRecovery(redis, { calls, handlerError: err });

            const out = await recovery.recoverAudioForScene(BOOK, CHAPTER, SCENE, BUILD);
            expect(out.recovered).to.equal(false);
            expect(out.reason).to.equal('stale_intent');
            expect(fs.existsSync(canonicalPath())).to.equal(false);
            expect(calls.saveChunk || 0).to.equal(0);
        });
    });

    // ── B4 — old done marker × crash window ───────────────────────────────
    describe('B4: a superseded fence cannot be re-published', () => {
        it('commit F1 → crash before rename → supersede F2 → retry F1 does NOT publish', async () => {
            await seedIntent(redis, { fence: F1 });
            await commitOnly(redis, F1, 'v1');                 // done:F1 durable, canonical absent
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });

            const out = await pub.commitFencedResult(redis, config(), {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
                buildId: BUILD, fence: F1, buffer: buf('late-v1'), extension: AUDIO_EXT,
                canonicalPath: canonicalPath(),
            });
            expect(out.status, 'the done marker does not outrank the intent').to.equal('stale_intent');
            expect(out.published).to.equal(false);
            expect(fs.existsSync(canonicalPath()), 'no stale bytes in the canonical path').to.equal(false);
            expect(fs.existsSync(stagedPathFor(F1)), 'own staged bytes discarded').to.equal(false);
        });

        it('resume skips a committed manifest whose fence is superseded', async () => {
            await seedIntent(redis, { fence: F1 });
            await commitOnly(redis, F1, 'v1');
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });

            const rec = await pub.resumePendingPublications(redis, config());
            expect(rec.resumed).to.equal(0);
            expect(rec.superseded).to.equal(1);
            expect(fs.existsSync(canonicalPath())).to.equal(false);
        });

        it('crash windows of BOTH fences: resume publishes the CURRENT fence only, then all three agree', async () => {
            await seedIntent(redis, { fence: F1 });
            await commitOnly(redis, F1, 'v1');                 // F1 committed, rename lost
            await seedIntent(redis, { fence: F2, epoch: 1, supersedes: F1 });
            await commitOnly(redis, F2, 'v2');                 // F2 committed, rename lost
            expect(fs.existsSync(stagedPathFor(F1))).to.equal(true);
            expect(fs.existsSync(stagedPathFor(F2))).to.equal(true);

            // a late replay of F1 first: nothing may be published
            const late = await pub.commitFencedResult(redis, config(), {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB,
                buildId: BUILD, fence: F1, buffer: buf('late-v1'), extension: AUDIO_EXT,
                canonicalPath: canonicalPath(),
            });
            expect(late.status).to.equal('stale_intent');
            expect(fs.existsSync(canonicalPath())).to.equal(false);

            const rec = await pub.resumePendingPublications(redis, config());
            expect(rec.resumed).to.equal(1);
            // canonical artifact, manifest and fence agree on F2
            expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v2');
            expect((await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).published_fence).to.equal(F2);
            expect(await qidem.isTaskDone(redis, F2)).to.equal(true);
            expect(fs.existsSync(stagedPathFor(F2)), 'the current fence was moved, not deleted').to.equal(false);
            // the late F1 replay was a terminal reject: only ITS OWN staged
            // bytes were discarded (path-scoped), the current fence survived
            expect(fs.existsSync(stagedPathFor(F1)), 'own staged bytes discarded by the terminal reject').to.equal(false);
        });

        it('a genuinely current crash window is still recovered (no regression)', async () => {
            await seedIntent(redis, { fence: F1 });
            await commitOnly(redis, F1, 'v1');
            const first = await pub.resumePendingPublications(redis, config());
            expect(first.resumed).to.equal(1);
            expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
            const second = await pub.resumePendingPublications(redis, config());
            expect(second.resumed).to.equal(0);
            expect(fs.readFileSync(canonicalPath(), 'utf8')).to.equal('v1');
        });
    });
});

// ── the production callback route, mounted with PG-free stubs ─────────────
//
// The fence gate lives in the route (B1/B2/B5): these tests mount the REAL
// route (routes/generation-routes.cjs) and post a real callback body. Only the
// PostgreSQL workspace re-verify/claim helpers are stubbed — they are not part
// of the publication decision.
async function mountRoute(redis, overrides = {}) {
    const bookRepo = require('../src/storage/postgres/repositories/book-repo');
    const taskRepo = require('../src/storage/postgres/repositories/task-repo');
    const original = { getWorkspaceId: bookRepo.getWorkspaceId, recordTaskClaim: taskRepo.recordTaskClaim };
    bookRepo.getWorkspaceId = async () => null;
    taskRepo.recordTaskClaim = async () => {};

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    require('../src/routes/generation-routes.cjs')(app, redis, {
        config: {
            OUTPUT_DIR: tmpRoot,
            GPU_HUB_API_KEY: null,
            resultFencingMode: () => (overrides.mode || 'observe'),
        },
        utils: { log: () => {} },
        orchestrator: { failStage: async () => ({ failed: true }) },
        taskHandler: overrides.taskHandler || { handleTaskResult: async () => ({ fenced: true }) },
        book: { loadBook: () => null },
        queueIdempotency: qidem,
    });

    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            bookRepo.getWorkspaceId = original.getWorkspaceId;
            taskRepo.recordTaskClaim = original.recordTaskClaim;
        },
    };
}
