// ======================================================
// Orphaned completion marker — M-c INTEGRATION regression
// (audit 119 · gpu-dispatch independent audit, finding M-c)
// ======================================================
//
// Proven defect (audit 119 · M-c, proof-p10 CONTROL leg):
//   A completion marker (`animastor:idempotency:done:*`) can survive WITHOUT
//   its artifact (the build dir / PG rows were wiped by a path that did not
//   release the marker). The artifact probe then misses, the task reaches the
//   SEND path, `guardEnqueue` answers `already_completed` — and the dispatch
//   engine defers the task 900 s, retries, gets the same verdict forever.
//   The scene stays in the active index for good: no job is ever sent, no
//   error is ever terminal.
//
// Fix under test (Stage 120 · M-c, `iu-processor.processSingleIU`):
//   `already_completed` on the SEND path is only reachable when the artifact
//   was probed ABSENT (a present artifact short-circuits to the cache-hit
//   branch and never dispatches) — the marker is therefore an ORPHAN. The
//   processor frees it (`releaseTaskDone`) and retries the send ONCE, so the
//   task regenerates on this attempt instead of looping. The retry re-claims
//   the same logical task, so a subsequent dispatch still observes the normal
//   bounded `duplicate_pending` deferral — never an `already_completed` loop.
//
// This is the REAL transport path: processSingleIU → comfyuiProvider.generate
// → DispatchTransport port (generation-test-bindings) → gpu-dispatcher.
// sendUnified → qidem.guardEnqueue → hub POST (stubbed global.fetch). No
// provider.generate stub: the suppression verdict comes from the real
// guardEnqueue against the real idempotency keys.
//
// Scenario (three dispatches of the SAME logical task):
//   #1  sent — the job "runs" and the result callback settles it
//       (settleCompletedTask: done marker + ref extension + claim release);
//       then the artifact is wiped and the completion callback clears the
//       in-flight marker → ORPHANED done marker, no artifact.
//   #2  the artifact probe misses → the send is suppressed `already_completed`
//       → M-c releases the orphan and retries → the job is REGENERATED
//       (exactly one extra POST), the old marker is gone, the same logical
//       task is re-claimed.
//   #3  a further dispatch is a NORMAL duplicate_pending deferral (bounded,
//       retryable) — NOT already_completed: no eternal loop, no extra POST.

const { expect } = require('chai');
const path = require('path');
const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
const iuProcessor = require('../src/image/iu-processor');
const gpuDispatcher = require('../src/runtime/gpu-dispatcher');
const qidem = require('../src/helpers/queue-idempotency.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

const RUN_TOKEN = `${Date.now().toString(36)}-${process.pid}`;
const B = `mcorphan_book_${RUN_TOKEN}`, C = 'ch-1', S = 'sc-1', BUILD = `build-mcorphan-${RUN_TOKEN}`;

const unit = { id: 'iu-1', text: 'Unit text 1' };
const sceneData = { payload: { units: [unit] }, chapter: {} };
const loadedBook = {
    manifest: { book_id: B, build_id: BUILD },
    chapters: [{ chapter_id: C, scenes: [{ scene_id: S, units: [unit] }] }],
};

// Same grammar as production: iuAssetId = {book}_{chapter}_{scene}_{unit}
const IMAGE_IU_ID = `${B}_${C}_${S}_${unit.id}`;
const JOB_ID = `${IMAGE_IU_ID}:iu_image`;
const markerKey = `animastor:iu-in-flight:${IMAGE_IU_ID}`;

describe('orphaned completion marker — M-c integration (audit 119 · already_completed loop)', function () {
    this.timeout(20000);

    let redis;
    let posts;
    const originalFetch = global.fetch;

    before(() => {
        wfLoader.configure({
            workflowsDir: path.join(__dirname, '../ai/workflows'),
            connectorsDir: path.join(__dirname, '../ai/connectors'),
        });
        wfLoader.loadWorkflows();
    });

    beforeEach(async () => {
        redis = createMockRedis();
        posts = [];
        global.fetch = async (url, opts) => {
            posts.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        };
        gpuDispatcher.setRedis(redis);
        gpuDispatcher.clearRoutingCaches();
        // The executor gate requires a live, type-compatible worker in the
        // lane — written exactly as the GPU Hub writes it.
        await redis.set(`animastor:worker:heartbeat:image:w1`, JSON.stringify({
            type: 'image', worker_id: 'w1', ts: Date.now(), workspace_id: null, mode: 'system',
        }), 'EX', 30);
    });

    afterEach(() => {
        global.fetch = originalFetch;
        gpuDispatcher.setRedis(null);
    });

    function processIU(dispatchId) {
        return iuProcessor.processSingleIU(
            redis, unit, 0, sceneData, loadedBook, BUILD, B, C, S, 0, 'full text', new Set(), dispatchId
        );
    }

    it('releases the orphaned marker, regenerates the task once, and never loops on already_completed', async () => {
        // ── dispatch #1 — the task really runs and settles ────────────────
        const r1 = await processIU('dispatch-c1');
        expect(r1.sent).to.equal(true);
        expect(posts).to.have.length(1);
        expect(posts[0].body.job_id).to.equal(JOB_ID);
        expect(posts[0].body.dispatch_id).to.equal('dispatch-c1');

        // The identity is recovered through the ownership ref — the same way
        // the production result callback resolves a delivered result.
        const idemKey = await qidem.readTaskRef(redis, B, C, S, JOB_ID);
        expect(idemKey).to.be.a('string');

        // The result callback settles the ACCEPTED result: done marker +
        // extended ref + released claim (production settlement sequence).
        const settle = await qidem.settleCompletedTask(redis, {
            bookId: B, chapterId: C, sceneId: S, jobId: JOB_ID, idemKey,
        });
        expect(settle.settled).to.equal(true);
        expect(settle.markerWritten).to.equal(true);
        expect(await redis.get(qidem.idemDoneKey(idemKey))).to.equal('1');
        expect(await redis.get(qidem.idemClaimKey(idemKey))).to.equal(null);

        // The wipe: the artifact is gone (the unique build dir does not exist
        // on disk → the probe misses) and the completion callback cleared the
        // in-flight marker. The done marker SURVIVES — the orphan.
        await redis.del(markerKey);
        expect(await qidem.isTaskDone(redis, idemKey)).to.equal(true);

        // ── dispatch #2 — orphan detected, released, regenerated ONCE ─────
        const r2 = await processIU('dispatch-c2');
        expect(r2.sent).to.equal(true);                       // regenerated — not deferred forever
        expect(r2.reason).to.equal(undefined);                // no suppression verdict survived
        expect(posts).to.have.length(2);                      // exactly ONE extra POST (the M-c retry)
        expect(posts[1].body.dispatch_id).to.equal('dispatch-c2');

        // The orphaned marker is gone; the RETRY re-claimed the SAME logical
        // task (fresh pending claim, 24 h backstop), and the regenerated job
        // is owned by the new dispatch.
        expect(await redis.get(qidem.idemDoneKey(idemKey))).to.equal(null);
        expect(await redis.get(qidem.idemClaimKey(idemKey))).to.equal('pending');
        expect(await redis.ttl(qidem.idemClaimKey(idemKey))).to.equal(qidem.IDEM_CLAIM_TTL_S);
        expect(await redis.get(markerKey)).to.equal('dispatch-c2');

        // ── dispatch #3 — normal bounded deferral, NOT already_completed ──
        const r3 = await processIU('dispatch-c3');
        expect(r3.sent).to.equal(false);
        expect(r3.reason).to.equal('duplicate_pending');      // bounded, retryable capacity deferral
        expect(r3.retryable).to.equal(true);
        expect(posts).to.have.length(2);                      // no new POST
        // The claim of the running retry is untouched — the scene leaves the
        // active index via the normal completion callback, never via a loop.
        expect(await redis.get(qidem.idemClaimKey(idemKey))).to.equal('pending');
    });
});
