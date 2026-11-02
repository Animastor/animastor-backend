// =====================================================
// GPU E2E 2026-11-02 — fixes (reports/2026-11-02/gpu-e2e-installer-025-logs.md)
// =====================================================
//   P1-1  a padded chunk is trimmed BEFORE the fenced commit: the manifest
//         describes the final canonical file; the merge never rewrites a
//         committed chunk (canonical never changes outside a fence).
//   P1-2  canonical_content_mismatch without a staged copy → the fence is
//         marked unrecoverable (reason + time), one warn, no 60-second loop.
//   P1-3  every dispatch opens a NEW audio-orch epoch; the stall watchdog
//         compares dispatch_id — an old record (started_at −4600 s) + a new
//         dispatch never yields FAILED.
//   P2-4  cancel clears audio-orch records and dispatch receipts.
//   P2-5  failStage without dispatch_id → stale_state_ignored, no
//         audio-orch FAILED (no invariant violation).
//   P2-6  workers.last_seen in seconds; heartbeat → PG status/version.
// =====================================================

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const pub = require('../src/services/result-publication.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const artifactNaming = require('@animastor/generation').artifactNaming;

const PKG = path.resolve(__dirname, '../../packages/animastor-orchestration/src');
const dispatch = require(path.join(PKG, 'runtime/dispatch-engine'));

const BOOK = 'book-e2e1102';
const CHAPTER = 'ch-e2e';
const SCENE = 'sc-e2e';
const BUILD = 'build-e2e1102';
const SCENE_PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const CHUNK_ID = `${SCENE_PREFIX}_0001`;
const JOB = `${CHUNK_ID}:audio`;

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'audio', buildId: BUILD,
        params: { '120': { text: 'Глава' } }, generationEpoch: epoch,
    });
}
const F1 = fenceFor(0);
const F2 = fenceFor(1);

let tmpRoot;
function canonicalPath() { return path.join(tmpRoot, BUILD, `${CHUNK_ID}.mp3`); }

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

const PADDED = Buffer.from('PADDED-GPU-BYTES:Глава Глава');
const TRIMMED = Buffer.from('TRIMMED:Глава');

function makeHandler(redis, { chunkMeta = null, trim = null } = {}) {
    const calls = { trim: 0 };
    const deps = {
        utils: { log: () => {} },
        cleanupService: {
            resolveAssetPath: (jobId, buildId) => {
                const assetId = String(jobId).replace(/:audio$/, '');
                return { type: 'audio_chunk', extension: 'mp3', fullPath: path.join(tmpRoot, buildId, `${assetId}.mp3`) };
            },
        },
        audio: {
            trimPaddedAudioBuffer: async (buf, len) => {
                calls.trim++;
                calls.trimLen = len;
                return trim ? trim(buf, len) : { buffer: buf, trimmed: false };
            },
        },
        image: {}, video: {}, state: {}, book: {},
        activeScenes: {}, placeholderAudio: {}, bookDiff: {},
        orchestrator: { completeStage: async () => {} },
        saveIURegistry: async () => {},
        iuRepo: { getImageUnitsForScene: async () => [] },
        getChunk: async () => chunkMeta,
        saveChunk: async () => {},
    };
    return { handler: taskHandlerFactory(redis, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, deps), calls };
}

describe('GPU E2E 2026-11-02 fixes', () => {
    let redis;
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e1102-'));
        redis = createMockRedis();
    });
    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // ── P1-1 ─────────────────────────────────────────────────────────────
    describe('P1-1: padded chunk is trimmed before the fenced commit', () => {
        it('padded=true → manifest sha256/bytes == canonical sha256/bytes (the trimmed bytes)', async () => {
            await seedIntent(redis, F1);
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const { handler, calls } = makeHandler(redis, {
                chunkMeta: { padded_text: true, original_text_length: 5 },
                trim: () => ({ buffer: TRIMMED, trimmed: true }),
            });

            const out = await handler.handleTaskResult(JOB, PADDED.toString('base64'), BUILD, 'd1');
            expect(out.commit).to.equal('committed');
            expect(calls.trim).to.equal(1);
            expect(calls.trimLen).to.equal(5);

            const manifest = await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB);
            const canonical = fs.readFileSync(canonicalPath());
            expect(manifest.published_fence).to.equal(F1);
            expect(manifest.sha256, 'manifest sha == canonical sha').to.equal(sha(canonical));
            expect(manifest.bytes).to.equal(canonical.length);
            expect(canonical.equals(TRIMMED), 'canonical holds the trimmed bytes').to.equal(true);
            expect(manifest.sha256).to.not.equal(sha(PADDED));

            // The resume loop sees a consistent publication — no mismatch.
            const rec = await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
            expect(rec.errors).to.equal(0);
            expect(rec.unrecoverable).to.equal(0);
        });

        it('padded=false → no trim, the GPU bytes are committed as-is', async () => {
            await seedIntent(redis, F1);
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const { handler, calls } = makeHandler(redis, { chunkMeta: { padded_text: false } });
            await handler.handleTaskResult(JOB, PADDED.toString('base64'), BUILD, 'd1');
            expect(calls.trim).to.equal(0);
            const manifest = await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(manifest.sha256).to.equal(sha(PADDED));
            expect(sha(fs.readFileSync(canonicalPath()))).to.equal(sha(PADDED));
        });

        it('the merge no longer rewrites a committed (padded) chunk', async () => {
            const audioOrch = require('../src/services/audio-orchestrator');
            fs.mkdirSync(path.join(tmpRoot, BUILD), { recursive: true });
            fs.writeFileSync(canonicalPath(), Buffer.concat([TRIMMED, Buffer.alloc(200, 1)]));
            const before = sha(fs.readFileSync(canonicalPath()));
            await audioOrch.setState(redis, BOOK, CHAPTER, SCENE, {
                phase: 'WAITING_CHUNKS', expected_count: 1, chunks_received: 0,
                started_at: Date.now(), build_id: BUILD, dispatch_id: 'd1',
            });
            let trimCalls = 0;
            const config = require('../src/config/runtime-config');
            const prevOut = config.OUTPUT_DIR;
            config.OUTPUT_DIR = tmpRoot;
            try {
                await audioOrch.completeChunk(redis, BOOK, CHAPTER, SCENE, '0001', BUILD, {
                    audio: {
                        trimPaddedSceneAudio: async () => { trimCalls++; },
                        mergeSceneAudioChunks: async () => true,
                    },
                    getChunk: async () => ({ padded_text: true, original_text_length: 5 }),
                    dispatchId: 'd1',
                });
            } finally {
                config.OUTPUT_DIR = prevOut;
            }
            expect(trimCalls, 'merge must not trim committed chunks').to.equal(0);
            expect(sha(fs.readFileSync(canonicalPath()))).to.equal(before);
            expect((await audioOrch.getState(redis, BOOK, CHAPTER, SCENE)).phase).to.equal('DONE');
        });

        it('trimPaddedAudioBuffer never throws and returns the original bytes on failure', async () => {
            const generation = require('../src/audio/generation');
            const junk = Buffer.from('not an mp3 at all');
            const res = await generation.trimPaddedAudioBuffer(junk, 5);
            expect(Buffer.isBuffer(res.buffer)).to.equal(true);
            expect(res.buffer.equals(junk)).to.equal(true);
            expect(res.trimmed).to.equal(false);
        });
    });

    // ── P1-2 ─────────────────────────────────────────────────────────────
    describe('P1-2: canonical_content_mismatch without a staged copy is terminal', () => {
        async function publishedThenRewritten() {
            await seedIntent(redis, F1);
            await seedReceipt(redis, 'd1', F1);
            await seedDispatchMeta(redis, 'd1');
            const { handler } = makeHandler(redis);
            await handler.handleTaskResult(JOB, PADDED.toString('base64'), BUILD, 'd1');
            // The pre-fix trim: canonical rewritten after the commit.
            fs.writeFileSync(canonicalPath(), TRIMMED);
        }

        it('first cycle marks the fence unrecoverable (reason + time, one warn); later cycles skip silently', async () => {
            await publishedThenRewritten();
            const warns = [];
            const origWarn = console.warn;
            console.warn = (...a) => { warns.push(a.join(' ')); };
            let r1; let r2; let r3;
            try {
                r1 = await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
                r2 = await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
                r3 = await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
            } finally {
                console.warn = origWarn;
            }
            expect(r1).to.include({ markedUnrecoverable: 1, unrecoverable: 1, errors: 0 });
            expect(r2).to.include({ markedUnrecoverable: 0, unrecoverable: 1, errors: 0 });
            expect(r3).to.include({ markedUnrecoverable: 0, unrecoverable: 1, errors: 0 });
            const pubWarns = warns.filter(w => w.includes('[RESULT-PUBLICATION]'));
            expect(pubWarns, 'exactly one warning over three cycles').to.have.length(1);
            expect(pubWarns[0]).to.include('unrecoverable');

            const rec = await qidem.readFenceUnrecoverable(redis, { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB });
            expect(rec.status).to.equal('ok');
            expect(rec.record.fence).to.equal(F1);
            expect(rec.record.reason).to.equal('canonical_content_mismatch');
            expect(rec.record.at).to.be.a('number').and.to.be.greaterThan(0);
            // Nothing was deleted: canonical and manifest stay as evidence.
            expect(fs.readFileSync(canonicalPath()).equals(TRIMMED)).to.equal(true);
            expect((await qidem.readArtifactManifest(redis, BOOK, CHAPTER, SCENE, JOB)).published_fence).to.equal(F1);
        });

        it('a NEW fence of the same task is not skipped, and its publication clears the record', async () => {
            await publishedThenRewritten();
            await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
            // A new command: new fence F2 becomes the active intent.
            await seedIntent(redis, F2, 1);
            await seedReceipt(redis, 'd2', F2);
            await seedDispatchMeta(redis, 'd2');
            const { handler } = makeHandler(redis);
            const out = await handler.handleTaskResult(JOB, Buffer.from('NEW-RUN').toString('base64'), BUILD, 'd2');
            expect(out.commit).to.equal('committed');
            const rec = await qidem.readFenceUnrecoverable(redis, { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB });
            expect(rec.status).to.equal('absent');
            const r = await pub.resumePendingPublications(redis, { OUTPUT_DIR: tmpRoot });
            expect(r).to.include({ unrecoverable: 0, errors: 0 });
        });
    });

    // ── P1-3 / P2-5 ──────────────────────────────────────────────────────
    describe('P1-3: a new dispatch opens a new audio-orch epoch', () => {
        const audioOrch = () => require('../src/services/audio-orchestrator');

        it('old record (started_at −4600 s, FAILED, fail_reason) + new dispatch → fresh epoch, watchdog: no FAILED', async () => {
            const now = Date.now();
            await audioOrch().setState(redis, BOOK, CHAPTER, SCENE, {
                phase: 'FAILED', expected_count: 2, chunks_received: 0,
                started_at: now - 4600 * 1000, build_id: BUILD,
                fail_reason: 'No prompt_id', failed_at: now - 4500 * 1000,
            });
            // The dispatch path (scene-orchestrator.executeAudioDispatch):
            // FAILED → GENERATING → WAITING_CHUNKS(epoch).
            expect((await audioOrch().setGenerating(redis, BOOK, CHAPTER, SCENE)).success).to.equal(true);
            const r = await audioOrch().setWaitingChunks(redis, BOOK, CHAPTER, SCENE, {
                dispatchId: 'dispatch-new', expectedCount: 2, buildId: BUILD,
            });
            expect(r.success).to.equal(true);
            await seedDispatchMeta(redis, 'dispatch-new');

            const st = await audioOrch().getState(redis, BOOK, CHAPTER, SCENE);
            expect(st.phase).to.equal('WAITING_CHUNKS');
            expect(st.dispatch_id).to.equal('dispatch-new');
            expect(st.expected_count).to.equal(2);
            expect(st.started_at).to.be.at.least(now);
            expect(st).to.not.have.property('fail_reason');
            expect(st).to.not.have.property('failed_at');
            expect(st).to.not.have.property('last_chunk_at');

            const engine = require(path.join(PKG, 'runtime/reconciliation-engine'));
            let failStageCalls = 0;
            const n = await engine.checkStalledAudioScenes(redis, { orchestrator: { failStage: async () => { failStageCalls++; } } });
            expect(n).to.equal(0);
            expect(failStageCalls).to.equal(0);
            expect((await audioOrch().getState(redis, BOOK, CHAPTER, SCENE)).phase).to.equal('WAITING_CHUNKS');
        });

        it('without an epoch the legacy setWaitingChunks keeps the old behaviour', async () => {
            await audioOrch().initPlaceholderReady(redis, BOOK, CHAPTER, SCENE, BUILD, 1);
            await audioOrch().setGenerating(redis, BOOK, CHAPTER, SCENE);
            const r = await audioOrch().setWaitingChunks(redis, BOOK, CHAPTER, SCENE);
            expect(r.success).to.equal(true);
            expect(r.state).to.not.have.property('dispatch_id');
        });

        it('a genuinely stalled record of the LIVE dispatch is still failed', async () => {
            await audioOrch().setState(redis, BOOK, CHAPTER, SCENE, {
                phase: 'WAITING_CHUNKS', expected_count: 1, chunks_received: 0,
                started_at: Date.now() - 31 * 60 * 1000, build_id: BUILD, dispatch_id: 'dispatch-live',
            });
            await seedDispatchMeta(redis, 'dispatch-live');
            const engine = require(path.join(PKG, 'runtime/reconciliation-engine'));
            const seen = [];
            const n = await engine.checkStalledAudioScenes(redis, {
                orchestrator: { failStage: async (...a) => { seen.push(a[7]); } },
            });
            expect(n).to.equal(1);
            expect(seen[0]).to.deep.equal({ dispatchId: 'dispatch-live' });
            expect((await audioOrch().getState(redis, BOOK, CHAPTER, SCENE)).phase).to.equal('FAILED');
        });
    });

    describe('P2-5: failStage without dispatch_id is stale_state_ignored', () => {
        it('failWaitingScene on a record without dispatch_id writes nothing and does not call failStage', async () => {
            const audioOrch = require('../src/services/audio-orchestrator');
            await audioOrch.setState(redis, BOOK, CHAPTER, SCENE, {
                phase: 'WAITING_CHUNKS', expected_count: 2, started_at: Date.now() - 4619000, build_id: BUILD,
            });
            let called = 0;
            const r = await audioOrch.failWaitingScene(redis, BOOK, CHAPTER, SCENE, BUILD, 'chunk_stall_timeout:4619s', {
                orchestrator: { failStage: async () => { called++; } },
            });
            expect(r).to.include({ failed: false, reason: 'stale_state_ignored' });
            expect(called).to.equal(0);
            expect((await audioOrch.getState(redis, BOOK, CHAPTER, SCENE)).phase).to.equal('WAITING_CHUNKS');
        });

        it('orchestrator.failStage without dispatchId → stale_state_ignored, no asset/audio-orch write', async () => {
            const orchestrator = require(path.join(PKG, 'orchestration/orchestrator'));
            const audioOrch = require('../src/services/audio-orchestrator');
            await audioOrch.setState(redis, BOOK, CHAPTER, SCENE, {
                phase: 'WAITING_CHUNKS', expected_count: 1, started_at: Date.now(), build_id: BUILD,
            });
            const res = await orchestrator.failStage(redis, BOOK, CHAPTER, SCENE, 'audio', BUILD, 'x');
            expect(res).to.deep.equal({ failed: false, reason: 'stale_state_ignored' });
            expect((await audioOrch.getState(redis, BOOK, CHAPTER, SCENE)).phase).to.equal('WAITING_CHUNKS');
        });
    });

    // ── P2-4 ─────────────────────────────────────────────────────────────
    describe('P2-4: cancel clears audio-orch and dispatch receipts', () => {
        const { clearCancelledSceneState } = require('../src/services/cancel-scene-state.cjs');

        it('book-wide: non-DONE orch records and the book receipts go, DONE records and other books stay', async () => {
            const audioOrch = require('../src/services/audio-orchestrator');
            await audioOrch.setState(redis, BOOK, CHAPTER, SCENE, { phase: 'FAILED', started_at: 1, build_id: BUILD });
            await audioOrch.setState(redis, BOOK, CHAPTER, 'sc-done', { phase: 'DONE', started_at: 1, build_id: BUILD });
            await audioOrch.setState(redis, 'other-book', CHAPTER, SCENE, { phase: 'FAILED', started_at: 1, build_id: BUILD });
            await redis.set(`animastor:video-orch:${BOOK}:${CHAPTER}:${SCENE}`, JSON.stringify({ phase: 'WAITING_CHUNKS' }));
            for (let i = 0; i < 6; i++) await seedReceipt(redis, `dispatch-1793617${i}`, F1);
            const otherJob = `${artifactNaming.scenePrefix('other-book', CHAPTER, SCENE)}_0001:audio`;
            await redis.set(qidem.dispatchReceiptKey('dispatch-x', otherJob), F2);

            const out = await clearCancelledSceneState(redis, BOOK, { stages: null, scenes: null });
            expect(out).to.include({ orchDeleted: 2, receiptsDeleted: 6, errors: 0 });
            expect(await audioOrch.getState(redis, BOOK, CHAPTER, SCENE)).to.equal(null);
            expect((await audioOrch.getState(redis, BOOK, CHAPTER, 'sc-done')).phase).to.equal('DONE');
            expect((await audioOrch.getState(redis, 'other-book', CHAPTER, SCENE)).phase).to.equal('FAILED');
            expect(await redis.get(qidem.dispatchReceiptKey('dispatch-x', otherJob))).to.equal(F2);
        });

        it('scene + stage scoped (cancel-worker / layer-config): other scenes and stages untouched', async () => {
            const audioOrch = require('../src/services/audio-orchestrator');
            await audioOrch.setState(redis, BOOK, CHAPTER, SCENE, { phase: 'WAITING_CHUNKS', started_at: 1 });
            await audioOrch.setState(redis, BOOK, CHAPTER, 'sc-other', { phase: 'WAITING_CHUNKS', started_at: 1 });
            await redis.set(`animastor:video-orch:${BOOK}:${CHAPTER}:${SCENE}`, JSON.stringify({ phase: 'WAITING_CHUNKS' }));
            await seedReceipt(redis, 'd1', F1);
            const out = await clearCancelledSceneState(redis, BOOK, {
                stages: ['audio'], scenes: [{ chapter_id: CHAPTER, scene_id: SCENE }],
            });
            expect(out).to.include({ orchDeleted: 1, receiptsDeleted: 1 });
            expect(await audioOrch.getState(redis, BOOK, CHAPTER, 'sc-other')).to.not.equal(null);
            expect(await redis.get(`animastor:video-orch:${BOOK}:${CHAPTER}:${SCENE}`)).to.not.equal(null);
        });

        it('stage-cancellation re-exports the routine for the composition root', () => {
            const sc = require('../src/services/stage-cancellation.cjs');
            expect(sc.clearCancelledSceneState).to.equal(clearCancelledSceneState);
        });
    });

    // ── P2-6 ─────────────────────────────────────────────────────────────
    describe('P2-6: workers.last_seen seconds + heartbeat liveness', () => {
        const workerRepo = require('../src/storage/postgres/repositories/worker-repo');

        it('lastSeenMs converts seconds to ms and passes a legacy ms value through', () => {
            expect(workerRepo.lastSeenMs({ last_seen: 1793622717 })).to.equal(1793622717000);
            expect(workerRepo.lastSeenMs({ last_seen: '1793622717' })).to.equal(1793622717000);
            expect(workerRepo.lastSeenMs({ last_seen: 1793622717060 })).to.equal(1793622717060);
            expect(workerRepo.lastSeenMs({ last_seen: null })).to.equal(null);
        });

        it('syncWorkerLiveness collects live heartbeats (latest ts, version) for the repo', async () => {
            const { syncWorkerLiveness } = require('../src/services/worker-liveness-sync.cjs');
            const config = require('../src/config/runtime-config');
            const id = 'f7dcbda1-31d1-419d-af73-37048352bc88';
            await redis.set(config.WORKER_HEARTBEAT_KEY('audio', id), JSON.stringify({ ts: 1793623416449, version: '2.2.1' }));
            let got = null;
            const res = await syncWorkerLiveness(redis, {
                workerRepo: { syncLivenessFromHeartbeats: async (live) => { got = live; return { online: 1, offline: 0 }; } },
            });
            expect(res).to.include({ ok: true, live: 1, online: 1, offline: 0 });
            expect(got).to.deep.equal([{ workerId: id, tsMs: 1793623416449, version: '2.2.1' }]);
        });

        it('syncWorkerLiveness never throws (repo error → ok:false)', async () => {
            const { syncWorkerLiveness } = require('../src/services/worker-liveness-sync.cjs');
            const res = await syncWorkerLiveness(redis, {
                workerRepo: { syncLivenessFromHeartbeats: async () => { throw new Error('pg down'); } },
            });
            expect(res).to.deep.equal({ ok: false, error: 'pg down' });
        });
    });
});
