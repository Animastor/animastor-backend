// =====================================================
// Stage 141 — ready-chain / iu-progress idempotency
// =====================================================
// Stage 140 §4.3 identified `iu-progress INCR` (task-handler.cjs) as the only
// NON-idempotent side effect of the ready chain and required Stage 141 to
// either close the gap or document the confirmed limitation. This battery
// pins BOTH sides of the current behaviour — without changing any business
// semantics:
//
//   C1  a duplicate HTTP callback is deduplicated by the ROUTE key
//       (`animastor:result-processed:{job}:{build}`, SET NX EX 3600) → the
//       ready chain (and the INCR) runs exactly once;
//   C2  recovery (`resumePendingPublications`) never re-runs the ready chain:
//       it only finishes/verifies the rename, so an already-published fence
//       leaves the counter untouched;
//   C3  CONFIRMED LIMITATION: a replay that bypasses the route dedup key —
//       reconciliation Phase A / audio recovery calling `handleTaskResult`
//       directly (reconciliation-engine.js:1887, audio-recovery.cjs:215) —
//       DOES run the ready chain again for an already-published fence, so the
//       raw counter can exceed the number of confirmed IUs. The counter is a
//       progress DISPLAY source: the consumer clamps it with
//       `iuReadyFromCounters` (iu-progress-utils.cjs), and stage completion is
//       decided from the filesystem listing + PG (task-handler.cjs:248), never
//       from this counter. C3 asserts exactly that clamping.
//
// The Redis verdicts use the independent mirror of FENCE_COMMIT_SCRIPT
// (tests/mocks/redis-mock.js), like every other fencing test in this suite.

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const pub = require('../src/services/result-publication.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const jobSchema = require('../src/runtime/job-schema');
const { createMockRedis } = require('./mocks/redis-mock');
const { iuReadyFromCounters } = require('../src/routes/book/iu-progress-utils.cjs');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const artifactNaming = require('@animastor/generation').artifactNaming;

const BOOK = 'book-s141';
const CHAPTER = 'ch-s141';
const SCENE = 'sc-s141';
const BUILD = 'build-s141';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const IU = `${PREFIX}_iu01`;
const JOB = `${IU}:iu_image`;
const EXT = '.png';
const PROG_KEY = `animastor:iu-progress:${BOOK}:${CHAPTER}:${SCENE}:image`;

function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD,
        params: { '120': { inputs: { seed: 7 } } }, generationEpoch: epoch,
    });
}
const F1 = fenceFor(0);

const buf = (t) => Buffer.from(t, 'utf8');
const b64 = (t) => buf(t).toString('base64');

let tmpRoot;
const config = () => ({ OUTPUT_DIR: tmpRoot });
const canonicalPath = () => path.join(tmpRoot, BUILD, `${IU}${EXT}`);
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
    await dispatch.setDispatchMetadata(redis, BOOK, CHAPTER, SCENE, 'image', {
        dispatch_id: dispatchId, stage: 'image', started_at: Date.now(), worker: 'scheduler',
        retry_attempt: 0, status: 'dispatched',
    });
}

/** Production task handler with the iu_image ready-chain deps instrumented. */
function makeHandler(redis, calls) {
    return taskHandlerFactory(redis, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, {
        utils: { log: () => {} },
        cleanupService: {
            resolveAssetPath: (jobId, buildId) => ({
                type: 'iu_image', extension: 'png',
                fullPath: path.join(tmpRoot, buildId, `${String(jobId).replace(/:iu_image$/, '')}.png`),
            }),
        },
        audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {}, placeholderAudio: {}, bookDiff: {},
        orchestrator: { completeStage: async () => { calls.completeStage = (calls.completeStage || 0) + 1; } },
        saveIURegistry: async () => { calls.registry = (calls.registry || 0) + 1; },
        iuRepo: { getImageUnitsForScene: async () => [] },
        getChunk: async () => null,
        saveChunk: async () => { calls.saveChunk = (calls.saveChunk || 0) + 1; },
    });
}

/** The mock Redis has no pub/sub; progress-pubsub is best-effort anyway. */
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

async function progressCounter(redis) {
    const raw = await redis.get(PROG_KEY);
    return raw == null || raw === false ? 0 : parseInt(raw, 10);
}

function resultBody(overrides = {}) {
    return {
        job_id: JOB,
        build_id: BUILD,
        dispatch_id: 'd1',
        protocol_version: jobSchema.PROTOCOL_VERSION,
        result_base64: `data:image/png;base64,${b64('IU-BYTES-V1')}`,
        ...overrides,
    };
}

async function postResult(base, body) {
    const res = await fetch(`${base}/gpu/task/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

/** Mount the production /gpu/task/result route around a REAL task handler. */
async function mountRoute(redis, handler) {
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
            resultFencingMode: () => 'observe',
        },
        utils: { log: () => {} },
        orchestrator: { failStage: async () => ({ failed: true }) },
        taskHandler: handler,
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

describe('Stage 141 — ready-chain / iu-progress idempotency', () => {
    let redis;
    let calls;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's141-'));
        redis = withPublish(createMockRedis());
        calls = {};
    });
    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('C1: a duplicate HTTP callback is deduplicated — the ready chain and the INCR run once', async () => {
        await seedIntent(redis, F1);
        await seedReceipt(redis, 'd1', F1);
        await seedDispatchMeta(redis, 'd1');
        const handler = makeHandler(redis, calls);
        const { base, close } = await mountRoute(redis, handler);
        try {
            const first = await postResult(base, resultBody());
            expect(first.status).to.equal(200);
            expect(first.body).to.deep.equal({ ok: true });

            const second = await postResult(base, resultBody());
            expect(second.status).to.equal(200);
            expect(second.body, 'the route dedup key answers without touching the handler').to.deep.equal({ ok: true, deduped: true });
        } finally {
            await close();
        }

        expect(calls.registry, 'ready chain ran exactly once').to.equal(1);
        expect(await progressCounter(redis), 'iu-progress incremented exactly once').to.equal(1);
        expect(readCanonical(), 'canonical holds the delivered bytes').to.equal('IU-BYTES-V1');
    });

    it('C2: recovery of a published fence never re-runs the ready chain (counter untouched)', async () => {
        await seedIntent(redis, F1);
        await seedReceipt(redis, 'd1', F1);
        await seedDispatchMeta(redis, 'd1');
        const handler = makeHandler(redis, calls);
        await handler.handleTaskResult(JOB, b64('IU-BYTES-V1'), BUILD, 'd1', { fence: F1 });
        expect(await progressCounter(redis)).to.equal(1);

        // The manifest + done marker + published marker are all durable now, so
        // resumePendingPublications scans this fence on every reconciler pass.
        const rec1 = await pub.resumePendingPublications(redis, config());
        const rec2 = await pub.resumePendingPublications(redis, config());
        expect(rec1.errors + rec2.errors, 'recovery runs cleanly').to.equal(0);
        expect(rec1.resumed + rec2.resumed, 'a published fence is not re-published').to.equal(0);

        expect(await progressCounter(redis), 'recovery never re-runs the ready chain').to.equal(1);
        expect(calls.registry, 'recovery never re-runs the ready chain').to.equal(1);
        expect(readCanonical()).to.equal('IU-BYTES-V1');
    });

    it('C3: a replay that bypasses the route dedup re-runs the chain — counter overcounts, consumer clamps (documented limitation)', async () => {
        await seedIntent(redis, F1);
        await seedReceipt(redis, 'd1', F1);
        await seedDispatchMeta(redis, 'd1');
        const handler = makeHandler(redis, calls);

        const first = await handler.handleTaskResult(JOB, b64('IU-BYTES-V1'), BUILD, 'd1', { fence: F1 });
        expect(first.commit).to.equal('committed');
        expect(await progressCounter(redis)).to.equal(1);

        // Same job, same fence, no route dedup key — exactly what
        // reconciliation Phase A / audio recovery do when a stale
        // `animastor:result:*` key is replayed (reconciliation-engine.js:1887,
        // audio-recovery.cjs:215): the fence resolves from the receipt, the
        // commit answers duplicate_same_fence, publication stays idempotent.
        const replay = await handler.handleTaskResult(JOB, b64('IU-BYTES-V1'), BUILD, 'd1');
        expect(replay.commit).to.equal('duplicate_same_fence');
        expect(replay.publication, 'publication itself never flaps').to.equal('already_published');
        expect(readCanonical(), 'canonical bytes unchanged by the replay').to.equal('IU-BYTES-V1');

        // ── CONFIRMED LIMITATION (Stage 140 §4.3) ────────────────────────
        expect(await progressCounter(redis), 'raw counter overcounts on a replay').to.equal(2);
        // …but the counter only feeds progress DISPLAY: every consumer clamps
        // it with iuReadyFromCounters, so readiness can never exceed `total`.
        expect(iuReadyFromCounters(1, 0, 2)).to.equal(1);
        expect(iuReadyFromCounters(4, 0, 7)).to.equal(4);
        // Stage completion is decided from the filesystem listing + PG, never
        // from this counter (task-handler.cjs:239–253), so a replay cannot
        // complete a stage early either.
    });
});
