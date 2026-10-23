// =====================================================
// Stage 129 — intent-fence regressions (audit 128 · B1, B2, F3–F8)
// =====================================================
// Every scenario of the Stage 129 brief, run against BOTH the atomic Lua path
// (queue-idempotency + the Lua script mirrored by tests/mocks/redis-mock.js)
// and the non-Lua transactional fallback (the same double with `eval`
// removed). No network, no production Redis/PG/Hub.
//
// NOTE on the Lua path: there is no redis-server (and therefore no Lua
// runtime) in this environment, so the atomic script is exercised through an
// INDEPENDENT mirror in the mock. The mirror is checked against the JS
// decision function by the verdict matrix below; a change to the script that
// is not mirrored fails these tests.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const qidem = require('../src/helpers/queue-idempotency.cjs');
const { createMockRedis } = require('./mocks/redis-mock');
const {
    isDeferrableOutcome,
    isFenceRejectedOutcome,
    CAPACITY_OUTCOMES,
} = require('../../packages/animastor-orchestration/src/runtime/dispatch-outcomes');
const { deferralWindowFor, DEFERRED_IDEMPOTENT_TTL_S } = require('../../packages/animastor-orchestration/src/runtime/dispatch-engine');

// ── fixtures ──────────────────────────────────────────────────────────────

const BOOK = 'book-s129';
const CHAPTER = 'ch-s129';
const SCENE = 'sc-s129';
const BUILD = 'build-s129';
const JOB = `${BOOK}_${CHAPTER}_${SCENE}_iu01:iu_image`;

const INTENT = () => qidem.intentKey(BOOK, CHAPTER, SCENE, JOB);
const RECEIPT = (dispatchId) => qidem.dispatchReceiptKey(dispatchId, JOB);

function params() {
    return { '120': { inputs: { seed: 458007174637134, steps: 8, cfg: 2 } } };
}

function fenceFor(epoch) {
    return qidem.computeIdemKey({
        workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: epoch,
    });
}

function ensureArgs(fence, dispatchId, epoch = 0) {
    return { bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: JOB, dispatchId, fence, epoch };
}

function withoutEval(redis) {
    const out = {};
    for (const key of Object.keys(redis)) {
        if (key === 'eval') continue;
        out[key] = typeof redis[key] === 'function' ? redis[key].bind(redis) : redis[key];
    }
    return out;
}

/** The two transport paths under test. */
const PATHS = [
    ['lua', (redis) => redis],
    ['fallback', (redis) => withoutEval(redis)],
];

function writeHeartbeat(redis) {
    return redis.set('animastor:worker:heartbeat:image:w-s129', JSON.stringify({
        type: 'image', worker_id: 'w-s129', ts: Date.now(), workspace_id: null, mode: 'system',
    }), 'EX', 30);
}

function taskSpec(dispatchId) {
    return {
        job_id: JOB, params: params(), job_type: 'image', build_id: BUILD,
        dispatch_id: dispatchId, timeout_ms: 60_000,
    };
}

function makeDispatcher(redis, fetchImpl) {
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

/** Seed the intent record of the task directly (state a previous send leaves). */
async function seedIntent(redis, { fence, epoch = 0, state = 'active', supersedes = null, history = [] }) {
    await redis.set(INTENT(), JSON.stringify({
        fence, state, epoch: String(epoch), supersedes, updated_at: Date.now(), history,
    }), 'EX', qidem.IDEM_INTENT_TTL_S);
}

// ── 1. verdict matrix: the same admission rules on both paths ─────────────

describe('Stage 129: intent fence regressions', () => {
    for (const [pathName, wrap] of PATHS) {
        describe(`admission rules (${pathName} path)`, () => {
            let redis;

            beforeEach(() => { redis = wrap(createMockRedis()); });

            it('B1: F1 → supersede F2 → repeat F1 is rejected and never becomes current', async () => {
                const f1 = fenceFor(0);
                const f2 = fenceFor(1);

                expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0))).status).to.equal('created');
                expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd2', 1))).status).to.equal('created');

                const before = await redis.get(INTENT());
                const replay = await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd3', 0));

                expect(replay.status, 'a superseded fence must never be admitted again').to.equal('stale_intent');
                expect(await redis.get(INTENT()), 'the newer intent must not be rewritten').to.equal(before);
                expect(await redis.get(RECEIPT('d3')), 'no receipt for a rejected dispatch').to.equal(null);
                expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(f2);
            });

            it('B1: an OLDER epoch can never supersede a newer intent (even with a fresh fence)', async () => {
                const f2 = fenceFor(2);
                await qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd1', 2));

                const older = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd2', 0));
                expect(older.status).to.equal('stale_intent');
                expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(f2);
            });

            it('B1: an EQUAL epoch cannot resurrect the superseded generation either', async () => {
                const f1 = fenceFor(0);
                const f1b = qidem.computeIdemKey({
                    workspaceId: null, jobId: JOB, jobType: 'image', buildId: BUILD,
                    params: { '120': { inputs: { seed: 999, steps: 8, cfg: 2 } } }, generationEpoch: 0,
                });
                await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));
                // same epoch, different inputs (e.g. an edited prompt) — admitted
                expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1b, 'd2', 0))).status).to.equal('created');
                // ... and the generation it replaced can never come back
                expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd3', 0))).status).to.equal('stale_intent');
            });

            it('two concurrent writers of one intent: the newer generation wins the state', async () => {
                const f1 = fenceFor(0);
                const f2 = fenceFor(1);
                await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd0', 0));

                const verdicts = await Promise.all([
                    qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd2', 1)),
                    qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1b', 0)),
                ]);

                expect(verdicts[0].status, 'the newer generation is admitted').to.equal('created');
                expect(verdicts[1].status, 'the stale replay is rejected').to.equal('stale_intent');
                expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(f2);
                expect(await redis.get(RECEIPT('d1b'))).to.equal(null);
            });

            it('F6: a record without a fence is corrupt — the send is never admitted', async () => {
                await redis.set(INTENT(), JSON.stringify({ state: 'active', epoch: '0', updated_at: 1 }), 'EX', 60);
                const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
                expect(verdict.status).to.equal('intent_corrupt');
                expect(await redis.get(RECEIPT('d1'))).to.equal(null);
            });

            it('F8: a cancelled record blocks the same generation but a NEWER epoch revives it', async () => {
                const f1 = fenceFor(0);
                await seedIntent(redis, { fence: f1, epoch: 0, state: 'cancelled' });

                const same = await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));
                expect(same).to.deep.include({ status: 'intent_not_active', state: 'cancelled' });

                const newer = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(1), 'd2', 1));
                expect(newer.status).to.equal('created');
                const intent = await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB);
                expect(intent).to.deep.include({ fence: fenceFor(1), state: 'active', epoch: '1' });
            });
        });
    }

    // ── 2. TTL edges and the dispatch_id admission rule (F3) ──────────────

    describe('TTL edges / dispatch_id admission', () => {
        let redis;
        beforeEach(() => { redis = createMockRedis(); });

        it('receipt expired while the intent lives: only the CURRENT generation may be re-bound', async () => {
            const f1 = fenceFor(0);
            const f2 = fenceFor(1);
            await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));
            await qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd2', 1));

            // the receipt of d1 expired (or was evicted) after 48 h
            await redis.del(RECEIPT('d1'));
            // a re-dispatch of d1 under the OLD fence must not bind it to anything
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0))).status).to.equal('stale_intent');
            expect(await redis.get(RECEIPT('d1'))).to.equal(null);

            // the same dispatch_id bound to the CURRENT generation is admitted
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd1', 1))).status).to.equal('created');
            expect(await qidem.readDispatchReceipt(redis, 'd1', JOB)).to.equal(f2);
        });

        it('intent expired while the receipt lives: never silently re-created', async () => {
            const f1 = fenceFor(0);
            await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));

            // data loss: the intent record is gone, its receipt still authorizes d1
            await redis.del(INTENT());
            const replay = await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));
            expect(replay.status).to.equal('intent_missing');
            expect(await redis.get(INTENT()), 'no intent record may be invented').to.equal(null);

            // a NEW dispatch is a fresh start and creates both records
            expect((await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd2', 0))).status).to.equal('created');
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(f1);
        });

        it('the generation counter is kept alive by accepted sends and its loss cannot jam the task', async () => {
            const stageKey = qidem.stageEpochKey(BOOK, CHAPTER, SCENE, 'image');
            await redis.set(stageKey, '3', 'EX', 60);

            // a send under the CURRENT generation refreshes the counter TTL
            const f3 = fenceFor(3);
            const args = { ...ensureArgs(f3, 'd3', 3), stageEpochKey: stageKey };
            expect((await qidem.ensureIntentAndReceipt(redis, args)).status).to.equal('created');
            expect(await redis.ttl(stageKey)).to.equal(qidem.STAGE_EPOCH_TTL_S);

            // while the counter EXISTS an older generation is rejected ...
            const older = { ...ensureArgs(fenceFor(1), 'd1', 1), stageEpochKey: stageKey };
            expect((await qidem.ensureIntentAndReceipt(redis, older)).status).to.equal('stale_intent');

            // ... but a LOST counter (expiry/eviction) cannot be mistaken for
            // an older generation: it must not block the task for 14 days.
            await redis.del(stageKey);
            const afterLoss = { ...ensureArgs(fenceFor(1), 'd1', 1), stageEpochKey: stageKey };
            expect((await qidem.ensureIntentAndReceipt(redis, afterLoss)).status).to.equal('created');
            expect(await redis.get(stageKey), 'an absent counter is not resurrected').to.equal(null);
        });

        it('the receipt TTL outlives every window in which a result can still arrive', () => {
            // Admission rule documented in the report: a result may only arrive
            // while the claim it belongs to can still be refilled/settled; the
            // receipt must not expire before that (48 h > 24 h claim + 1 h hub
            // result retention).
            expect(qidem.IDEM_RECEIPT_TTL_S).to.be.greaterThan(qidem.IDEM_CLAIM_TTL_S);
            expect(qidem.IDEM_RECEIPT_TTL_S).to.be.greaterThan(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);
            expect(qidem.IDEM_INTENT_TTL_S).to.be.greaterThan(qidem.IDEM_RECEIPT_TTL_S);
        });
    });

    // ── 3. B2: no silent fallback, no partial state, lock ownership ────────

    describe('B2: atomic path failures fail closed', () => {
        it('ACL refusal is NOT a capability gap: unavailable, no fallback, no writes', async () => {
            const redis = createMockRedis();
            let denied = 0;
            redis.eval = async () => {
                denied += 1;
                throw new Error('NOPERM this user has no permissions to run the eval command');
            };
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'unavailable', reason: 'eval_error' });
            expect(denied, 'exactly one attempt — never a retry through the fallback').to.equal(1);
            expect(await redis.get(INTENT())).to.equal(null);
            expect(await redis.get(RECEIPT('d1'))).to.equal(null);
        });

        it('CROSSSLOT and timeouts fail closed as well', async () => {
            for (const message of [
                'CROSSSLOT Keys in request don\'t hash to the same slot',
                'Command timed out after 5000ms',
                'READONLY You can\'t write against a read only replica',
            ]) {
                const redis = createMockRedis();
                redis.eval = async () => { throw new Error(message); };
                const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
                expect(verdict.status, message).to.equal('unavailable');
                expect(verdict.reason, message).to.equal('eval_error');
                expect(await redis.get(RECEIPT('d1')), message).to.equal(null);
            }
        });

        it('an unclassifiable reply from the script fails closed (no second decision)', async () => {
            const redis = createMockRedis();
            redis.eval = async () => 'SOMETHING-ELSE';
            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'unavailable', reason: 'unexpected_eval_reply' });
            expect(await redis.get(INTENT())).to.equal(null);
            expect(await redis.get(RECEIPT('d1'))).to.equal(null);
        });

        it('a client without eval fails closed unless it EXPLICITLY opts into the fallback', async () => {
            const base = createMockRedis();
            const strict = withoutEval(base);
            delete strict.__allowNonLuaFallback;

            const blocked = await qidem.ensureIntentAndReceipt(strict, ensureArgs(fenceFor(0), 'd1', 0));
            expect(blocked).to.deep.include({ status: 'unavailable', reason: 'atomic_script_unavailable' });
            expect(await base.get(INTENT())).to.equal(null);

            // the declared double does fall back — and says so
            const verdict = await qidem.ensureIntentAndReceipt(withoutEval(base), ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'created', degraded: true });
        });

        it('a command rejected while queuing the transaction leaves NO partial state', async () => {
            const base = createMockRedis();
            const redis = withoutEval(base);
            let rejected = false;
            redis.multi = () => {
                const tx = base.multi();
                return {
                    set: (key, value, ...rest) => {
                        if (!rejected && String(key).startsWith(qidem.IDEM_RECEIPT_PREFIX)) {
                            rejected = true;
                            throw new Error('EXECABORT Transaction discarded because of previous errors.');
                        }
                        return tx.set(key, value, ...rest);
                    },
                    del: (...args) => tx.del(...args),
                    expire: (...args) => tx.expire(...args),
                    exec: () => tx.exec(),
                };
            };

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'unavailable', degraded: true });
            expect(rejected).to.equal(true);
            expect(await base.get(INTENT()), 'the intent must not be written').to.equal(null);
            expect(await base.get(RECEIPT('d1')), 'the receipt must not be written').to.equal(null);

            // a retry converges: both records, same fence, no half state
            const retried = await qidem.ensureIntentAndReceipt(withoutEval(base), ensureArgs(fenceFor(0), 'd1', 0));
            expect(retried.status).to.equal('created');
            expect((await qidem.readIntent(base, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(fenceFor(0));
            expect(await qidem.readDispatchReceipt(base, 'd1', JOB)).to.equal(fenceFor(0));
        });

        it('a client with neither Lua nor WATCH/MULTI is reported as NON-transactional', async () => {
            const base = createMockRedis();
            const redis = withoutEval(base);
            delete redis.watch;
            delete redis.multi;
            delete redis.unwatch;

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'created', degraded: true, transactional: false });

            // ... and a Redis failure in the write phase is never a success
            const brokenBase = createMockRedis();
            const broken = withoutEval(brokenBase);
            delete broken.watch;
            delete broken.multi;
            delete broken.unwatch;
            const realSet = broken.set;
            broken.set = async (key, value, ...args) => {
                if (String(key).startsWith(qidem.IDEM_RECEIPT_PREFIX)) throw new Error('connection reset');
                return realSet(key, value, ...args);
            };
            const failed = await qidem.ensureIntentAndReceipt(broken, ensureArgs(fenceFor(0), 'd1', 0));
            expect(failed).to.deep.include({ status: 'unavailable', transactional: false });
        });

        it('the fallback lock has an OWNER TOKEN and is never deleted after it lapsed', async () => {
            const base = createMockRedis();
            const redis = withoutEval(base);
            const realSet = base.set.bind(base);
            redis.set = async (key, value, ...args) => {
                const result = await realSet(key, value, ...args);
                // the 15 s TTL lapses and ANOTHER owner takes the lock while we
                // are still inside the critical section
                if (String(key).startsWith(qidem.IDEM_INTENT_LOCK_PREFIX) && args.includes('NX') && result) {
                    await realSet(key, 'foreign-owner-token', 'EX', 30);
                }
                return result;
            };

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict.status).to.equal('created');

            const [, locks] = await base.scan('0', 'MATCH', `${qidem.IDEM_INTENT_LOCK_PREFIX}*`);
            expect(locks).to.have.length(1);
            expect(await base.get(locks[0]), 'a lapsed lock belongs to its new owner').to.equal('foreign-owner-token');
        });

        it('a held lock makes the fallback wait, then report busy — without touching the lock', async () => {
            const base = createMockRedis();
            const redis = withoutEval(base);
            const lockKey = `${qidem.IDEM_INTENT_LOCK_PREFIX}${INTENT().slice(qidem.IDEM_INTENT_PREFIX.length)}`;
            await base.set(lockKey, 'another-process', 'EX', 30);

            const verdict = await qidem.ensureIntentAndReceipt(redis, ensureArgs(fenceFor(0), 'd1', 0));
            expect(verdict).to.deep.include({ status: 'busy', degraded: true });
            expect(await base.get(lockKey)).to.equal('another-process');
            expect(await base.get(INTENT())).to.equal(null);
        });
    });

    // ── 4. F4: rollback is fence-scoped ───────────────────────────────────

    describe('F4: rollback ownership', () => {
        it('forgetTaskRef deletes the ref only while it points at OUR fence', async () => {
            const redis = createMockRedis();
            const mine = fenceFor(0);
            const newer = fenceFor(1);

            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, JOB, mine);
            const foreign = await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, JOB, { fence: newer });
            expect(foreign).to.deep.include({ deleted: false, reason: 'not_owner' });
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(mine);

            const own = await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, JOB, { fence: mine });
            expect(own).to.deep.include({ deleted: true });
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(null);
        });

        it('releaseTask reports whether the claim was really released', async () => {
            const redis = createMockRedis();
            const fence = fenceFor(0);
            await qidem.claimTask(redis, fence);
            expect(await qidem.releaseTask(redis, fence)).to.deep.include({ released: true });
            expect(await qidem.releaseTask(redis, fence)).to.deep.include({ released: false, reason: 'absent' });
        });

        it('a failing rollback is never reported as success', async () => {
            const redis = createMockRedis();
            const fence = fenceFor(0);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, JOB, fence);
            redis.watch = async () => { throw new Error('connection lost'); };

            const verdict = await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, JOB, { fence });
            expect(verdict).to.deep.include({ deleted: false, reason: 'error' });
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, JOB)).to.equal(fence);
        });
    });

    // ── 5. F5: terminal reasons land in the shared taxonomy ───────────────

    describe('F5: fence rejections do not churn every 5 s', () => {
        it('every terminal fence reason is deferrable and uses the long window', () => {
            for (const reason of ['stale_intent', 'receipt_conflict', 'intent_not_active', 'intent_corrupt', 'intent_missing']) {
                expect(isFenceRejectedOutcome(reason), reason).to.equal(true);
                expect(isDeferrableOutcome(reason), reason).to.equal(true);
                expect(deferralWindowFor(reason), reason).to.equal(DEFERRED_IDEMPOTENT_TTL_S);
            }
        });

        it('a transient fencing outage is a bounded retry, not a terminal rejection', () => {
            expect(CAPACITY_OUTCOMES.has('intent_receipt_unavailable')).to.equal(true);
            expect(isFenceRejectedOutcome('intent_receipt_unavailable')).to.equal(false);
            expect(isDeferrableOutcome('intent_receipt_unavailable')).to.equal(true);
            expect(deferralWindowFor('intent_receipt_unavailable')).to.not.equal(DEFERRED_IDEMPOTENT_TTL_S);
        });
    });

    // ── 6. dispatcher integration: stale sender never reaches the hub ─────

    describe('sendUnified: a stale generation never reaches the hub', () => {
        let redis;
        let ctx;

        beforeEach(async () => {
            redis = createMockRedis();
            await writeHeartbeat(redis);
        });

        afterEach(() => { if (ctx) ctx.restore(); ctx = null; });

        it('rejects a stale fence with stale_intent, reverts its own claim/ref, never POSTs', async () => {
            // The current generation is epoch 1; a straggler still pinned to
            // epoch 0 presents the superseded fence.
            const newer = fenceFor(1);
            await seedIntent(redis, { fence: newer, epoch: 1 });
            await redis.set(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, JOB), '0');
            await redis.set(qidem.stageEpochKey(BOOK, CHAPTER, SCENE, 'image'), '1');

            ctx = makeDispatcher(redis);
            const result = await ctx.gpuDispatcher.sendUnified(taskSpec('d-stale'));

            expect(result).to.include({ sent: false, reason: 'stale_intent', retryable: false, suppressed: false });
            expect(ctx.calls, 'the hub must never see a stale generation').to.have.length(0);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(newer);
            expect(await redis.get(RECEIPT('d-stale'))).to.equal(null);
            expect(await redis.get(qidem.idemClaimKey(result.idem_key)), 'its own claim is released').to.equal(null);
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, JOB), 'its own ref is released').to.equal(null);
            expect(ctx.gpuDispatcher.getStats().jobs_fence_rejected).to.be.greaterThan(0);
        });

        it('a corrupt record (no fence) is rejected before the POST and surfaces as terminal', async () => {
            await redis.set(INTENT(), JSON.stringify({ state: 'active', epoch: '0', updated_at: 1 }), 'EX', 60);
            ctx = makeDispatcher(redis);
            const result = await ctx.gpuDispatcher.sendUnified(taskSpec('d-corrupt'));
            expect(result).to.include({ sent: false, reason: 'intent_corrupt', retryable: false });
            expect(ctx.calls).to.have.length(0);
            expect(await redis.get(RECEIPT('d-corrupt'))).to.equal(null);
        });

        it('an unavailable atomic path is a retryable not-sent outcome, not a POST', async () => {
            redis.eval = async () => { throw new Error('NOPERM this user has no permissions to run the eval command'); };
            ctx = makeDispatcher(redis);
            const result = await ctx.gpuDispatcher.sendUnified(taskSpec('d-acl'));
            expect(result).to.include({ sent: false, reason: 'intent_receipt_unavailable', retryable: true });
            expect(ctx.calls).to.have.length(0);
            expect(await redis.get(RECEIPT('d-acl'))).to.equal(null);
        });

        it('a superseded generation stays superseded across a module "restart"', async () => {
            const f1 = fenceFor(0);
            const f2 = fenceFor(1);
            await qidem.ensureIntentAndReceipt(redis, ensureArgs(f1, 'd1', 0));
            await qidem.ensureIntentAndReceipt(redis, ensureArgs(f2, 'd2', 1));
            ctx = makeDispatcher(redis);
            ctx.restore();

            // a fresh dispatcher instance on the same durable state
            await redis.set(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, JOB), '0');
            await redis.set(qidem.stageEpochKey(BOOK, CHAPTER, SCENE, 'image'), '1');
            ctx = makeDispatcher(redis);
            const result = await ctx.gpuDispatcher.sendUnified(taskSpec('d-restarted'));
            expect(result).to.include({ sent: false, reason: 'stale_intent', retryable: false });
            expect(ctx.calls).to.have.length(0);
            expect((await qidem.readIntent(redis, BOOK, CHAPTER, SCENE, JOB)).fence).to.equal(f2);
        });
    });
});
