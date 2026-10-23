// =====================================================
// Stage 127 — durable intent fence + immutable dispatch receipt
// =====================================================
// Phase 1 of the result-fencing rollout (contract 126 §1, §7). Everything
// here runs against REAL queue-idempotency + the REAL gpu-dispatcher with a
// fake Redis and a stubbed hub fetch — no network, no production Redis/PG.
//
// Covered (contract 127 scope, item 7):
//   1. same-intent re-dispatch      — the fence is preserved; the receipt of
//                                     a re-dispatch binds the SAME fence
//   2. new intent                   — reset task epoch → new fence, the
//                                     intent record supersedes the old one,
//                                     the OLD receipt stays immutable
//   3. immutable receipt            — a receipt is SET NX and never rewritten
//   4. conflicting existing receipt — same (dispatch_id, job_id) with a
//                                     different fence is rejected and nothing
//                                     (intent/claim/ref) is corrupted
//   5. timeout after hub acceptance — the receipt exists BEFORE the POST, so
//                                     an ambiguous outcome keeps identity
//   6. restart recovery             — a fresh dispatcher instance reuses the
//                                     pinned identity; receipts survive
// plus the fallback (non-Lua) path for Redis doubles without a working eval.
//
// NOT covered here (later fencing phases): result admission, staged writes,
// CAS commit, cancel/regenerate supersede wiring — the hub envelope, result
// route, canonical artifact paths, completion semantics and PG schema are
// untouched by this stage on purpose.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const { createMockRedis } = require('./mocks/redis-mock');

// ── fixtures ──────────────────────────────────────────────────────────────

const WS = '3317e019-879d-4dfb-a9f8-edc9b72da7f4';
const BOOK = 'book-s127';
const CHAPTER = 'ch-s127';
const SCENE = 'sc-s127';
const BUILD = 'build-s127';
const JOB = `${BOOK}_${CHAPTER}_${SCENE}_iu01:iu_image`;
const JOB_2 = `${BOOK}_${CHAPTER}_${SCENE}_iu02:iu_image`;

function params() {
    return { '120': { inputs: { seed: 458007174637134, steps: 8, cfg: 2 } } };
}

/** The fence of a logical task for a given intent epoch — same formula the dispatcher uses.
 *  The dispatcher stub below routes into the SYSTEM pool (bookRepo → null
 *  workspace), so workspaceId is null here too. */
function fenceFor(epoch, jobId = JOB) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: epoch,
    });
}

function ensureArgs(fence, dispatchId, { epoch = 0, jobId = JOB } = {}) {
    return { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId, dispatchId, fence, epoch };
}

/** Wrap a double so `eval` disappears → exercises the lock-guarded fallback path. */
function withoutEval(redis) {
    const out = {};
    for (const key of Object.keys(redis)) {
        if (key === 'eval') continue;
        out[key] = typeof redis[key] === 'function' ? redis[key].bind(redis) : redis[key];
    }
    return out;
}

/** Spy on eval to prove the atomic Lua script is the production path. */
function spyEval(redis) {
    const seen = [];
    const original = redis.eval.bind(redis);
    redis.eval = async (script, ...rest) => {
        seen.push(script);
        return original(script, ...rest);
    };
    return seen;
}

/** A live system-pool worker heartbeat exactly as the hub writes it. */
function writeHeartbeat(redis, type = 'image') {
    return redis.set(`animastor:worker:heartbeat:${type}:w-s127`, JSON.stringify({
        type,
        worker_id: 'w-s127',
        ts: Date.now(),
        workspace_id: null,
        mode: 'system',
    }), 'EX', 30);
}

function taskSpec(dispatchId, jobId = JOB) {
    return {
        job_id: jobId,
        params: params(),
        job_type: 'image',
        build_id: BUILD,
        dispatch_id: dispatchId,
        timeout_ms: 60_000,
    };
}

/** The REAL gpu-dispatcher wired to a fake Redis, stubbed PG routing + fetch. */
function makeDispatcher({ redis, fetchImpl = null }) {
    const calls = [];
    const gpuDispatcher = proxyquire('../src/runtime/gpu-dispatcher', {
        '../storage/postgres/repositories/book-repo': { getWorkspaceId: async () => null },
        '../storage/postgres/repositories/worker-repo': {
            hasActivePrivateWorkerOfType: async () => false,
            findGrantPolicyForRouting: async () => null,
        },
    });
    gpuDispatcher.setRedis(redis);
    gpuDispatcher.clearRoutingCaches();

    const originalFetch = global.fetch;
    global.fetch = fetchImpl || (async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    return {
        gpuDispatcher,
        calls,
        restore() {
            global.fetch = originalFetch;
            gpuDispatcher.setRedis(null);
        },
    };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('Stage 127: durable intent fence + immutable dispatch receipt', () => {
    let redis;

    beforeEach(() => {
        redis = createMockRedis();
    });

    // ── 1. atomic creation on the production (Lua) path ───────────────────
    describe('ensureIntentAndReceipt (atomic Lua path)', () => {
        it('creates the intent record and the receipt, verified by the Lua script', async () => {
            const seen = spyEval(redis);
            const fence = fenceFor(0);

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence, 'd1'));
            expect(verdict.status).to.equal('created');
            expect(seen, 'the production path must run the atomic Lua script').to.have.length(1);
            expect(seen[0]).to.include('receipt_conflict');
            expect(seen[0]).to.include('intent_not_active');

            const intent = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(intent).to.deep.include({ fence, state: 'active', epoch: '0', supersedes: null });
            expect(intent.updated_at).to.be.a('number');

            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence);
            // Durable beyond the claim (24 h) / done marker (7 d); receipt
            // covers hub result retention + claim backstop + an outage.
            expect(await redis.ttl(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB))).to.equal(qidem.IDEM_INTENT_TTL_S);
            expect(await redis.ttl(qidem.dispatchReceiptKey('d1', JOB))).to.equal(qidem.IDEM_RECEIPT_TTL_S);
            expect(qidem.IDEM_INTENT_TTL_S).to.be.greaterThan(qidem.IDEM_DONE_TTL_S);
            expect(qidem.IDEM_RECEIPT_TTL_S).to.be.greaterThan(qidem.IDEM_CLAIM_TTL_S);
        });

        it('re-running the same (dispatch, job, fence) is idempotent — the intent record is not rewritten', async () => {
            const fence = fenceFor(0);
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence, 'd1'))).status).to.equal('created');

            const before = await redis.get(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB));
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence, 'd1'));
            expect(verdict.status).to.equal('reused');
            expect(await redis.get(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB))).to.equal(before);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence);
        });

        it('a receipt is IMMUTABLE: the same dispatch+job with a different fence is rejected and nothing changes', async () => {
            const fence1 = fenceFor(0);
            const fence2 = fenceFor(1);
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence1, 'd1'))).status).to.equal('created');

            const intentBefore = await redis.get(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB));
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence2, 'd1'));
            expect(verdict.status).to.equal('receipt_conflict');

            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence1);
            expect(await redis.get(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB))).to.equal(intentBefore);
        });

        it('a NEW intent gets a new fence, supersedes the old one and keeps the old receipt intact', async () => {
            const fence1 = fenceFor(0);
            const fence2 = fenceFor(1);
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence1, 'd1'))).status).to.equal('created');
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence2, 'd2'))).status).to.equal('created');

            const intent = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(intent.fence).to.equal(fence2);
            expect(intent.supersedes).to.equal(fence1);
            expect(intent.state).to.equal('active');

            // Both receipts survive, each bound to its own fence.
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence1);
            expect(await qidem.readDispatchReceipt(redis, 'd2', JOB)).to.equal(fence2);
        });

        it('a non-active intent rejects the receipt and writes nothing', async () => {
            const fence = fenceFor(0);
            const cancelled = JSON.stringify({ fence, state: 'cancelled', epoch: '0', supersedes: null, updated_at: 1 });
            await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), cancelled, 'EX', 60);

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fence, 'd9'));
            expect(verdict).to.deep.equal({ status: 'intent_not_active', state: 'cancelled' });
            expect(await redis.get(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB))).to.equal(cancelled);
            expect(await redis.get(qidem.dispatchReceiptKey('d9', JOB))).to.equal(null);
        });

        it('a corrupt intent record fails closed', async () => {
            await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB), 'not-json{', 'EX', 60);
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1'));
            expect(verdict.status).to.equal('intent_corrupt');
            expect(await redis.get(qidem.dispatchReceiptKey('d1', JOB))).to.equal(null);
        });

        it('a non-hex fence fails closed before touching Redis', async () => {
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs('not-a-fence', 'd1'));
            expect(verdict.status).to.equal('invalid_fence');
        });

        it('dispatch/job collisions: receipts are per (dispatch, job); only an exact-match pair is reused', async () => {
            const fenceA = fenceFor(0, JOB);
            const fenceB = fenceFor(0, JOB_2);
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceA, 'dX', { jobId: JOB }))).status).to.equal('created');
            // Same dispatch, ANOTHER job → its own receipt (one dispatch fans out to many jobs)
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceB, 'dX', { jobId: JOB_2 }))).status).to.equal('created');
            expect(await qidem.readDispatchReceipt(redis, 'dX', JOB)).to.equal(fenceA);
            expect(await qidem.readDispatchReceipt(redis, 'dX', JOB_2)).to.equal(fenceB);
            // Exact same pair → reused
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceA, 'dX', { jobId: JOB }))).status).to.equal('reused');
        });

        it('two racing writers of one receipt: exactly one wins, the loser never overwrites', async () => {
            const fence1 = fenceFor(0);
            const fence2 = fenceFor(1);
            const verdicts = await Promise.all([
                qidem.ensureIntentAndReceipt(redis, ensureArgs(fence1, 'dR')),
                qidem.ensureIntentAndReceipt(redis, ensureArgs(fence2, 'dR')),
            ]);
            const statuses = verdicts.map((v) => v.status).sort();
            expect(statuses).to.deep.equal(['created', 'receipt_conflict']);
            const stored = await qidem.readDispatchReceipt(redis, 'dR', JOB);
            expect([fence1, fence2]).to.include(stored);
        });
    });

    // ── 2. fallback path for doubles without eval ─────────────────────────
    describe('ensureIntentAndReceipt (locked fallback without eval)', () => {
        it('produces the same verdicts and leaves no lock behind', async () => {
            const r = withoutEval(redis);
            const fence1 = fenceFor(0);
            const fence2 = fenceFor(1);

            expect((await qidem.ensureIntentAndReceipt(r, ensureArgs(fence1, 'd1'))).status).to.equal('created');
            expect((await qidem.ensureIntentAndReceipt(r, ensureArgs(fence1, 'd1'))).status).to.equal('reused');
            expect((await qidem.ensureIntentAndReceipt(r, ensureArgs(fence2, 'd1'))).status).to.equal('receipt_conflict');

            expect((await qidem.ensureIntentAndReceipt(r, ensureArgs(fence2, 'd2'))).status).to.equal('created');
            const intent = await qidem.readIntent(r, BOOK, CHAPTER, SCENE, JOB);
            expect(intent.fence).to.equal(fence2);
            expect(intent.supersedes).to.equal(fence1);

            // Non-active intent through the fallback
            await redis.set(qidem.intentKey(BOOK, CHAPTER, SCENE, JOB_2),
                JSON.stringify({ fence: fence1, state: 'superseded', epoch: '0', supersedes: null, updated_at: 1 }), 'EX', 60);
            const notActive = await qidem.ensureIntentAndReceipt(r, ensureArgs(fence1, 'd3', { jobId: JOB_2 }));
            // Stage 129: the fallback verdicts carry `degraded: true` — a
            // non-Lua path is never silent about being a weaker transport.
            expect(notActive).to.deep.include({ status: 'intent_not_active', state: 'superseded', degraded: true });

            // The fallback lock is always released
            const [, locks] = await r.scan('0', 'MATCH', 'animastor:intent-lock:*');
            expect(locks).to.deep.equal([]);
        });
    });

    // ── 3. sendUnified integration (real dispatcher) ──────────────────────
    describe('sendUnified (real dispatcher, stubbed hub)', () => {
        let ctx;

        afterEach(() => {
            if (ctx && ctx.restore) ctx.restore();
            ctx = null;
        });

        it('same-intent re-dispatch preserves the fence and writes one receipt per actually-POSTed dispatch', async () => {
            await writeHeartbeat(redis);
            let post = 0;
            const seenCalls = [];
            ctx = makeDispatcher({
                redis,
                fetchImpl: async (url, opts) => {
                    post += 1;
                    seenCalls.push({ url, body: JSON.parse(opts.body) });
                    if (post === 1) return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
                    return { ok: true, status: 200, json: async () => ({ ok: true }) };
                },
            });

            // Dispatch 1: definitive 403 → the claim is released, but the
            // receipt (written BEFORE the POST) survives immutably.
            const first = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(first).to.include({ sent: false, reason: 'hub_rejected' });
            const fence = fenceFor(0);
            expect(first.status).to.equal(403);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence);
            const intentAfterFirst = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(intentAfterFirst.fence).to.equal(fence);

            // Dispatch 2 (new dispatch_id, SAME logical task): the pinned
            // epoch yields the SAME fence; intent reused, receipt added.
            const second = await ctx.gpuDispatcher.sendUnified(taskSpec('d2'));
            expect(second).to.include({ sent: true });
            expect(second.idem_key).to.equal(fence);
            expect(await qidem.readDispatchReceipt(redis, 'd2', JOB)).to.equal(fence);
            const intentAfterSecond = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(intentAfterSecond.fence).to.equal(fence);
            expect(intentAfterSecond.supersedes).to.equal(null);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence); // still immutable
            expect(seenCalls).to.have.length(2);

            // Dispatch 3 while the claim is held: suppressed as duplicate —
            // no POST, therefore no receipt for a dispatch that never sent.
            const third = await ctx.gpuDispatcher.sendUnified(taskSpec('d3'));
            expect(third).to.include({ sent: false, reason: 'duplicate_pending', suppressed: true });
            expect(third.idem_key).to.equal(fence);
            expect(await qidem.readDispatchReceipt(redis, 'd3', JOB)).to.equal(null);
            expect(seenCalls).to.have.length(2);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(fence);
        });

        it('a NEW intent (reset task epoch) gets a new fence, supersedes the old one, old receipt untouched', async () => {
            await writeHeartbeat(redis);
            ctx = makeDispatcher({ redis });

            const first = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(first.sent).to.equal(true);
            const oldFence = first.idem_key;

            // Exactly what /gpu/task/error does for a consumed failure (and
            // what an explicit regeneration does): release + forget + bump
            // stage epoch + drop the per-task pin.
            await qidem.releaseTask(redis, oldFence);
            await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, JOB);
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            await qidem.resetJobEpoch(redis, BOOK, CHAPTER, SCENE, JOB);

            const second = await ctx.gpuDispatcher.sendUnified(taskSpec('d2'));
            expect(second.sent).to.equal(true);
            const newFence = second.idem_key;
            expect(newFence).to.not.equal(oldFence);
            expect(newFence).to.equal(fenceFor(1));

            const intent = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
            expect(intent.fence).to.equal(newFence);
            expect(intent.supersedes).to.equal(oldFence);
            expect(intent.state).to.equal('active');

            expect(await qidem.readDispatchReceipt(redis, 'd2', JOB)).to.equal(newFence);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(oldFence);
        });

        it('timeout after the hub may have taken the task: the receipt was already written before the POST', async function () {
            this.timeout(15_000); // 3 POST attempts with 1 s backoff each
            await writeHeartbeat(redis);
            let attempts = 0;
            const failingFetch = async () => {
                attempts += 1;
                throw new Error('ECONNRESET');
            };
            ctx = makeDispatcher({ redis, fetchImpl: failingFetch });

            const first = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(first).to.include({ sent: false, reason: 'ambiguous_post' });
            expect(attempts).to.equal(3);

            // The identity is durable regardless of the lost response.
            const fence = fenceFor(0);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(fence);
            expect(await redis.get(qidem.idemClaimKey(fence))).to.equal('ambiguous');

            // A re-dispatch of the same task stays suppressed (one lane entry)
            // and does not touch the intent or mint a receipt for a dispatch
            // that never reached the hub.
            const second = await ctx.gpuDispatcher.sendUnified(taskSpec('d2'));
            expect(second).to.include({ sent: false, reason: 'duplicate_pending', suppressed: true });
            expect(second.idem_key).to.equal(fence);
            expect(attempts).to.equal(3);
            expect(await qidem.readDispatchReceipt(redis, 'd2', JOB)).to.equal(null);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(fence);
        });

        it('restart recovery: a fresh dispatcher instance reuses the pinned identity and receipts survive', async function () {
            this.timeout(15_000); // the ambiguous leg runs 3 POST attempts with backoff
            await writeHeartbeat(redis);
            let attempts = 0;
            const flakyFetch = async () => {
                attempts += 1;
                throw new Error('ETIMEDOUT');
            };
            ctx = makeDispatcher({ redis, fetchImpl: flakyFetch });
            const before = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(before).to.include({ sent: false, reason: 'ambiguous_post' });
            const fence = fenceFor(0);
            ctx.restore();

            // "Restart": the module instance is new, Redis state survives —
            // exactly the production situation after a graceful shutdown.
            ctx = makeDispatcher({ redis });

            // A recovery path settles the ambiguous claim (result/error was
            // consumed or the claim expired), then the stage re-dispatches
            // with a NEW dispatch_id under the SAME intent.
            await qidem.releaseTask(redis, fence);
            const recovered = await ctx.gpuDispatcher.sendUnified(taskSpec('d2'));
            expect(recovered.sent).to.equal(true);
            expect(recovered.idem_key).to.equal(fence); // pinned epoch survived the restart
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(fence);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).supersedes).to.equal(null);
            expect(await qidem.readDispatchReceipt(redis, 'd2', JOB)).to.equal(fence);
            // The receipt of the interrupted dispatch is still resolvable —
            // a late callback for d1 proves which fence authorized it.
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(fence);
        });

        it('dispatch/job collision: reusing a dispatch_id with a NEW fence is rejected, state reverted, hub never called', async () => {
            await writeHeartbeat(redis);
            let post = 0;
            const seenCalls = [];
            ctx = makeDispatcher({
                redis,
                fetchImpl: async (url, opts) => {
                    post += 1;
                    seenCalls.push({ url, body: JSON.parse(opts.body) });
                    if (post === 1) return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
                    return { ok: true, status: 200, json: async () => ({ ok: true }) };
                },
            });

            // d1 sent once (definitive 403 → claim released, receipt kept).
            const first = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(first).to.include({ sent: false, reason: 'hub_rejected' });
            const oldFence = fenceFor(0);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(oldFence);

            // The task's own intent changes (consumed failure) — yet the SAME
            // dispatch_id is re-sent (the dirty-unit style path). The receipt
            // is immutable: this combination must be rejected BEFORE the POST.
            await qidem.releaseTask(redis, oldFence);
            await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, JOB);
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            await qidem.resetJobEpoch(redis, BOOK, CHAPTER, SCENE, JOB);

            const collided = await ctx.gpuDispatcher.sendUnified(taskSpec('d1'));
            expect(collided).to.include({ sent: false, reason: 'receipt_conflict', retryable: false });
            expect(collided.idem_key).to.equal(fenceFor(1));

            // Nothing was corrupted: no POST, receipt and intent unchanged,
            // and the rejected sender reverted its own claim + ref.
            expect(post).to.equal(1);
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(oldFence);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(oldFence);
            expect(await redis.get(qidem.idemClaimKey(fenceFor(1)))).to.equal(null);
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(null);
        });
    });
});
