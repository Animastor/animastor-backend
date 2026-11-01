// =====================================================
// P1 (2026-11-01) — GPU result delivered once: HTTP push + reconcile replay
// =====================================================
// reports/2026-11-01/gpu-audio-image-run-analysis.md §12 P1: the hub stores
// `animastor:result:<build>:<book>:<ch>:<sc>:<type>` (TTL 1h) and POSTs the
// result; the route processes it, but reconciliation Phase A
// (`recoverResultKeys`) found the fallback copy 20–60 s later and replayed it
// past `animastor:result-processed:*` → no_active_dispatch warnings and an
// `iu-progress` of 3 for 2 IUs (duplicate_same_fence re-ran the INCR).
//
//   R1  HTTP + reconcile for one result: the replay is dropped silently,
//       the handler is not called again, the counter stays 1;
//   R2  2 IUs of one scene, each with HTTP + replay → counter 2;
//   R3  regeneration of the same job after the TTL → processed and counted;
//   R4  regeneration within the TTL (marker of an OLDER dispatch, the
//       audio/video case: no marker clear on re-dispatch) → HTTP answers
//       deduped, reconcile still publishes it through the fence;
//   R5  in-flight / legacy `'1'` marker is no proof → replayed as before;
//   R6  log level: a duplicate's terminal reject is info, an orphan's warn;
//   R7  reader tolerates counters written before the fix (clamped).

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const taskHandlerFactory = require('../src/services/task-handler.cjs');
const jobSchema = require('../src/runtime/job-schema');
const { createMockRedis } = require('./mocks/redis-mock');
const { computeIuReady } = require('../src/routes/book/iu-progress-utils.cjs');
const dispatch = require('@animastor/orchestration').runtime.dispatch;
const artifactNaming = require('@animastor/generation').artifactNaming;

const RECONCILE_PATH = path.resolve(__dirname, '../../packages/animastor-orchestration/src/runtime/reconciliation-engine');

const BOOK = 'book-p1';
const CHAPTER = 'ch-p1';
const SCENE = 'sc-p1';
const BUILD = 'build-p1';
const PREFIX = artifactNaming.scenePrefix(BOOK, CHAPTER, SCENE);
const iu = (n) => `${PREFIX}_iu0${n}`;
const job = (n) => `${iu(n)}:iu_image`;
const PROG_KEY = `animastor:iu-progress:${BOOK}:${CHAPTER}:${SCENE}:image`;
const RESULT_KEY = `animastor:result:${BUILD}:${BOOK}:${CHAPTER}:${SCENE}:image`;

const fenceFor = (jobId, epoch) => qidem.computeIdemKey({
    workspaceId: null, jobId, jobType: 'image', buildId: BUILD,
    params: { '120': { inputs: { seed: 7 } } }, generationEpoch: epoch,
});
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

let tmpRoot;
const canonical = (n) => path.join(tmpRoot, BUILD, `${iu(n)}.png`);
const readCanonical = (n) => (fs.existsSync(canonical(n)) ? fs.readFileSync(canonical(n), 'utf8') : null);

async function seedGeneration(redis, jobId, dispatchId, fence, epoch = 0) {
    await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, jobId), JSON.stringify({
        fence, state: 'active', epoch: String(epoch), supersedes: null, updated_at: Date.now(), history: [],
    }), 'EX', qidem.IDEM_INTENT_TTL_S);
    await redis.set(qidem.dispatchReceiptKey(dispatchId, jobId), fence, 'EX', qidem.IDEM_RECEIPT_TTL_S);
    await dispatch.setDispatchMetadata(redis, BOOK, CHAPTER, SCENE, 'image', {
        dispatch_id: dispatchId, stage: 'image', started_at: Date.now(), worker: 'scheduler',
        retry_attempt: 0, status: 'dispatched',
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

/** Production task handler (fenced iu_image chain), call-counted. */
function makeHandler(redis, calls) {
    const h = taskHandlerFactory(redis, { OUTPUT_DIR: tmpRoot, resultFencingMode: () => 'observe' }, {
        utils: { log: () => {} },
        cleanupService: {
            resolveAssetPath: (jobId, buildId) => ({
                type: 'iu_image', extension: 'png',
                fullPath: path.join(tmpRoot, buildId, `${String(jobId).replace(/:iu_image$/, '')}.png`),
            }),
        },
        audio: {}, image: {}, video: {}, state: {}, book: {}, activeScenes: {}, placeholderAudio: {}, bookDiff: {},
        orchestrator: { completeStage: async () => {} },
        saveIURegistry: async () => {},
        iuRepo: { getImageUnitsForScene: async () => [] },
        getChunk: async () => null,
        saveChunk: async () => {},
    });
    return {
        async handleTaskResult(...args) {
            calls.handler = (calls.handler || 0) + 1;
            return h.handleTaskResult(...args);
        },
    };
}

async function mountRoute(redis, handler) {
    const bookRepo = require('../src/storage/postgres/repositories/book-repo');
    const taskRepo = require('../src/storage/postgres/repositories/task-repo');
    const original = { getWorkspaceId: bookRepo.getWorkspaceId, recordTaskClaim: taskRepo.recordTaskClaim };
    bookRepo.getWorkspaceId = async () => null;
    taskRepo.recordTaskClaim = async () => {};
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    require('../src/routes/generation-routes.cjs')(app, redis, {
        config: { OUTPUT_DIR: tmpRoot, GPU_HUB_API_KEY: null, resultFencingMode: () => 'observe' },
        utils: { log: () => {} },
        orchestrator: { failStage: async () => ({ failed: true }) },
        taskHandler: handler,
        book: { loadBook: () => null },
        queueIdempotency: qidem,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            bookRepo.getWorkspaceId = original.getWorkspaceId;
            taskRepo.recordTaskClaim = original.recordTaskClaim;
        },
    };
}

function body(jobId, dispatchId, bytes) {
    return {
        job_id: jobId, build_id: BUILD, dispatch_id: dispatchId,
        protocol_version: jobSchema.PROTOCOL_VERSION,
        result_base64: `data:image/png;base64,${b64(bytes)}`,
    };
}

/** What the hub does: fallback copy FIRST, then the HTTP push. */
async function hubDeliver(redis, base, jobId, dispatchId, bytes) {
    const b = body(jobId, dispatchId, bytes);
    await redis.set(RESULT_KEY, JSON.stringify({
        job_id: b.job_id, result_base64: b.result_base64, build_id: b.build_id,
        dispatch_id: b.dispatch_id, protocol_version: b.protocol_version,
    }), 'EX', 3600);
    const res = await fetch(`${base}/gpu/task/result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    });
    return { status: res.status, body: await res.json() };
}

async function counter(redis) {
    const raw = await redis.get(PROG_KEY);
    return raw == null || raw === false ? 0 : parseInt(raw, 10);
}

function captureConsole() {
    const out = { log: [], warn: [] };
    const orig = { log: console.log, warn: console.warn };
    console.log = (...a) => { out.log.push(a.join(' ')); };
    console.warn = (...a) => { out.warn.push(a.join(' ')); };
    out.restore = () => { console.log = orig.log; console.warn = orig.warn; };
    return out;
}

describe('P1 — GPU result delivery idempotency (HTTP push + reconcile replay)', () => {
    let redis;
    let calls;
    let engine;

    before(() => { engine = require(RECONCILE_PATH); });
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-result-'));
        redis = withPublish(createMockRedis());
        calls = {};
    });
    afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

    async function reconcile(handler) {
        const cap = captureConsole();
        try {
            const recovered = await engine.recoverResultKeys(redis, { taskHandler: handler }, null);
            return { recovered, log: cap.log, warn: cap.warn };
        } finally {
            cap.restore();
        }
    }

    it('R1: HTTP + reconcile for one result — replay dropped silently, handler once, counter 1', async () => {
        await seedGeneration(redis, job(1), 'd1', fenceFor(job(1), 0));
        const handler = makeHandler(redis, calls);
        const { base, close } = await mountRoute(redis, handler);
        try {
            const r = await hubDeliver(redis, base, job(1), 'd1', 'IU1-V1');
            expect(r.body).to.deep.equal({ ok: true });
        } finally { await close(); }
        expect(await redis.get(qidem.resultDedupKey(job(1), BUILD))).to.equal('done:d1');
        expect(await redis.get(RESULT_KEY), 'old hub: fallback copy still present').to.be.a('string');

        const rec = await reconcile(handler);
        expect(rec.recovered).to.equal(0);
        expect(calls.handler, 'the replay never reaches the handler').to.equal(1);
        expect(await redis.get(RESULT_KEY), 'fallback copy dropped').to.equal(null);
        expect(rec.warn.filter((l) => l.includes(job(1))), 'no warning for a duplicate').to.deep.equal([]);
        expect(await counter(redis)).to.equal(1);
        expect(readCanonical(1)).to.equal('IU1-V1');
    });

    it('R2: 2 IUs of one scene (each HTTP + replay, plus a duplicate_same_fence replay) → counter 2', async () => {
        await seedGeneration(redis, job(1), 'd1', fenceFor(job(1), 0));
        await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, job(2)), JSON.stringify({
            fence: fenceFor(job(2), 0), state: 'active', epoch: '0', supersedes: null, updated_at: Date.now(), history: [],
        }), 'EX', qidem.IDEM_INTENT_TTL_S);
        await redis.set(qidem.dispatchReceiptKey('d1', job(2)), fenceFor(job(2), 0), 'EX', qidem.IDEM_RECEIPT_TTL_S);
        const handler = makeHandler(redis, calls);
        const { base, close } = await mountRoute(redis, handler);
        try {
            await hubDeliver(redis, base, job(1), 'd1', 'IU1');
            await reconcile(handler);
            await hubDeliver(redis, base, job(2), 'd1', 'IU2');
            await reconcile(handler);
        } finally { await close(); }
        expect(calls.handler).to.equal(2);
        expect(await counter(redis)).to.equal(2);

        // Even a replay that bypasses every dedup (operator/audio-recovery
        // style: same fence → duplicate_same_fence) no longer re-counts.
        const replay = await handler.handleTaskResult(job(1), b64('IU1'), BUILD, 'd1');
        expect(replay.commit).to.equal('duplicate_same_fence');
        expect(await counter(redis), 'idempotent per IU × fence').to.equal(2);
    });

    it('R3: regeneration of the same job after the TTL — processed and counted again', async () => {
        await seedGeneration(redis, job(1), 'd1', fenceFor(job(1), 0));
        const handler = makeHandler(redis, calls);
        const { base, close } = await mountRoute(redis, handler);
        try {
            await hubDeliver(redis, base, job(1), 'd1', 'IU1-V1');
            await reconcile(handler);
            // TTL elapsed: dedup marker and fallback copy are gone; the
            // regenerate ritual reset the counter (orchestrator.resetScenes).
            await redis.del(qidem.resultDedupKey(job(1), BUILD));
            await redis.del(PROG_KEY);
            await seedGeneration(redis, job(1), 'd2', fenceFor(job(1), 1), 1);

            const r = await hubDeliver(redis, base, job(1), 'd2', 'IU1-V2');
            expect(r.body).to.deep.equal({ ok: true });
            await reconcile(handler);
        } finally { await close(); }
        expect(calls.handler).to.equal(2);
        expect(readCanonical(1), 'new generation published').to.equal('IU1-V2');
        expect(await counter(redis)).to.equal(1);
        expect(await redis.get(qidem.resultDedupKey(job(1), BUILD))).to.equal('done:d2');
    });

    it('R4: regeneration within the TTL (marker of an older dispatch) — reconcile still publishes it', async () => {
        await seedGeneration(redis, job(1), 'd1', fenceFor(job(1), 0));
        const handler = makeHandler(redis, calls);
        const { base, close } = await mountRoute(redis, handler);
        try {
            await hubDeliver(redis, base, job(1), 'd1', 'IU1-V1');
            await reconcile(handler);
            await redis.del(PROG_KEY);
            // New dispatch of the same job_id, marker NOT cleared (audio/video path).
            await seedGeneration(redis, job(1), 'd2', fenceFor(job(1), 1), 1);
            const r = await hubDeliver(redis, base, job(1), 'd2', 'IU1-V2');
            expect(r.body, 'the route dedup is unchanged (dispatch-independent)').to.deep.equal({ ok: true, deduped: true });
            expect(await redis.get(RESULT_KEY), 'hub keeps the copy on deduped').to.be.a('string');
            const rec = await reconcile(handler);
            expect(rec.recovered).to.equal(1);
        } finally { await close(); }
        expect(readCanonical(1)).to.equal('IU1-V2');
        expect(await counter(redis)).to.equal(1);
        expect(await redis.get(RESULT_KEY)).to.equal(null);
    });

    it('R5: an in-flight / legacy "1" marker is no proof — the result is replayed through the fence', async () => {
        await seedGeneration(redis, job(1), 'd1', fenceFor(job(1), 0));
        const handler = makeHandler(redis, calls);
        await redis.set(qidem.resultDedupKey(job(1), BUILD), '1', 'EX', 3600);
        await redis.set(RESULT_KEY, JSON.stringify({
            job_id: job(1), result_base64: b64('IU1'), build_id: BUILD, dispatch_id: 'd1', protocol_version: jobSchema.PROTOCOL_VERSION,
        }), 'EX', 3600);
        const rec = await reconcile(handler);
        expect(calls.handler).to.equal(1);
        expect(rec.recovered).to.equal(1);
        expect(readCanonical(1)).to.equal('IU1');
    });

    it('R6: terminal reject — info for a duplicate of a delivered result, warn for an orphan', async () => {
        const handler = { handleTaskResult: async () => { const e = new Error('Rejected task result: no_active_dispatch'); e.code = 'no_active_dispatch'; throw e; } };
        const put = () => redis.set(RESULT_KEY, JSON.stringify({
            job_id: job(1), result_base64: b64('X'), build_id: BUILD, dispatch_id: 'd1', protocol_version: jobSchema.PROTOCOL_VERSION,
        }), 'EX', 3600);

        await redis.set(qidem.resultDedupKey(job(1), BUILD), '1', 'EX', 3600);
        await put();
        let rec = await reconcile(handler);
        expect(rec.warn.filter((l) => l.includes('terminally rejected'))).to.deep.equal([]);
        expect(rec.log.filter((l) => l.includes('terminally rejected') && l.includes('duplicate'))).to.have.length(1);
        expect(await redis.get(RESULT_KEY)).to.equal(null);

        await redis.del(qidem.resultDedupKey(job(1), BUILD));
        await put();
        rec = await reconcile(handler);
        expect(rec.warn.filter((l) => l.includes('terminally rejected'))).to.have.length(1);
        expect(await redis.get(RESULT_KEY)).to.equal(null);
    });

    it('R7: counters written before the fix (3 for 2 IUs) are read clamped', async () => {
        await redis.set(PROG_KEY, '3');
        const repo = { getDirtyUnitIds: async () => [] };
        expect(await computeIuReady(redis, repo, BOOK, CHAPTER, SCENE, 2)).to.equal(2);
        await redis.set(PROG_KEY, 'garbage');
        expect(await computeIuReady(redis, repo, BOOK, CHAPTER, SCENE, 2)).to.equal(0);
    });
});
