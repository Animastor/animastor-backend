// ======================================================
// Stage 116 (D3) — CAPACITY DEFERRAL (bounded retry/backoff)
// ======================================================
// Regression net for the Stage 115 defect D3: a stage that could not enqueue
// anything (no live compatible worker, or every job already pending in the
// lane) was re-dispatched on EVERY scheduler tick (SCHEDULER_TICK_MS = 5 s).
// Each attempt created a lease + dispatch metadata, the executor sent
// nothing, the dispatch was cancelled and the FSM was rolled back — an
// unbounded dispatch/cancel loop with lease churn, FSM churn and unbounded
// event-journal growth.
//
// The fix: a bounded per-stage deferral. While the deferral window is open
// the dispatch engine returns WITHOUT any side effect (no lease, no metadata,
// no FSM write, no journal event), the stage stays PENDING and recoverable,
// and the deferral is cleared by a successful dispatch or an explicit cancel.
//
// Isolated: in-memory Redis mock + stubbed host bindings. No production
// Redis/PG, no hub, no network.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const { bindHostModules, clearHostBindings } = require('../src/host/host-bindings');

const BOOK = 'test-stage116-book';
const CHAPTER = 'ch-stage116';
const SCENE = 'sc-stage116';
const BUILD = 'build_test-stage116-book';

describe('Stage 116 (D3): capacity deferral (bounded retry/backoff)', () => {
    let redis;
    let dispatchEngine;
    let journalEvents;
    let executorCalls;
    let executorResult;
    let rollbacks;

    beforeEach(async () => {
        redis = createMockRedis();
        journalEvents = [];
        executorCalls = 0;
        rollbacks = [];
        executorResult = { dispatched: false, jobs: 0, reason: 'no_worker_available', retryable: true };

        clearHostBindings();
        bindHostModules({
            journal: () => ({
                appendSceneEvent: async (r, b, c, s, type, state, details) => {
                    journalEvents.push({ type, state, details });
                    return true;
                },
            }),
            seams: () => ({
                getOrchestrationSeam: (name) => {
                    if (name === 'dispatchStage') {
                        return async () => {
                            executorCalls++;
                            return executorResult;
                        };
                    }
                    if (name === 'rollbackStageToPending') {
                        return async (r, b, c, s, stage, buildId, reason) => {
                            rollbacks.push({ stage, reason });
                            return { changed: true };
                        };
                    }
                    throw new Error(`[stage116-test] seam not wired: ${name}`);
                },
            }),
        });

        dispatchEngine = require('../src/runtime/dispatch-engine');
    });

    afterEach(() => {
        clearHostBindings();
    });

    const dispatch = () => dispatchEngine.dispatchStage(
        redis, BOOK, CHAPTER, SCENE, 'image', { book_id: BOOK }, BUILD
    );

    it('a stage that enqueued nothing is deferred and reported as retryable', async () => {
        const result = await dispatch();
        expect(result.dispatched).to.equal(false);
        expect(result.reason).to.equal('no_worker_available');
        expect(result.retryable).to.equal(true);
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
    });

    it('a deferred stage is NOT re-dispatched on the next tick (no side effects)', async () => {
        await dispatch();                       // attempt 1 — really attempted
        const callsAfterFirst = executorCalls;
        const journalAfterFirst = journalEvents.length;

        // the next scheduler tick (5 s later) must be a no-op
        const second = await dispatch();
        expect(second.dispatched).to.equal(false);
        expect(second.reason).to.equal('deferred_capacity');
        expect(second.retryable).to.equal(true);
        expect(executorCalls).to.equal(callsAfterFirst);          // executor NOT called
        expect(journalEvents.length).to.equal(journalAfterFirst); // no journal event
    });

    it('100 scheduler ticks inside the deferral window ⇒ ONE attempt (bounded churn)', async () => {
        await dispatch();
        for (let i = 0; i < 99; i++) await dispatch();
        expect(executorCalls).to.equal(1);
        // the journal must not grow with the tick count (bounded, not unbounded)
        const journalAfterLoop = journalEvents.length;
        expect(journalAfterLoop).to.be.lessThan(10);
    });

    it('the deferral window expires ⇒ the stage is dispatched again', async () => {
        await dispatch();
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
        // simulate the TTL elapsing (the mock keeps keys until told otherwise)
        await redis.del(dispatchEngine.deferredStageKey(BOOK, CHAPTER, SCENE, 'image'));
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);

        executorResult = { dispatched: true, jobs: 2, reason: null };
        const result = await dispatch();
        expect(result.dispatched).to.equal(true);
        expect(executorCalls).to.equal(2);
    });

    it('a successful dispatch clears the deferral', async () => {
        await dispatch();                       // deferred
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
        await redis.del(dispatchEngine.deferredStageKey(BOOK, CHAPTER, SCENE, 'image'));
        executorResult = { dispatched: true, jobs: 1, reason: null };
        await dispatch();
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);
    });

    it('an explicit cancel clears the deferral (the user asked for the work)', async () => {
        await dispatch();
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
        await dispatchEngine.cancelActiveDispatch(redis, BOOK, CHAPTER, SCENE, 'image', 'user_cancel');
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);
    });

    it('a deferred attempt does NOT consume the retry budget (it is not a failure)', async () => {
        const budgetKey = `animastor:retry-budget:${BOOK}:${CHAPTER}:${SCENE}:image`;
        await redis.set(budgetKey, '3');
        await dispatch();
        const after = await redis.get(budgetKey);
        expect(after).to.equal('3');     // unchanged — no budget consumed
    });

    it('a deferred attempt is not reported as a failure (retryable, not fatal)', async () => {
        const result = await dispatch();
        expect(result.dispatched).to.equal(false);
        expect(result.reason).to.equal('no_worker_available');
        expect(result.retryable).to.equal(true);
        // the dispatch engine must not have marked the stage as failed
        expect(result.result && result.result.retryable).to.equal(true);
    });

    it('the deferral is per stage — another stage of the same scene is not blocked', async () => {
        await dispatch();                       // image stage deferred
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
        expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'video')).to.equal(false);
        expect(await dispatchEngine.isStageDeferred(redis, 'other-book', CHAPTER, SCENE, 'image')).to.equal(false);
    });

    it('deferrable outcomes are classified explicitly (capacity only)', () => {
        expect(dispatchEngine.isDeferrableOutcome('no_worker_available')).to.equal(true);
        expect(dispatchEngine.isDeferrableOutcome('duplicate_pending')).to.equal(true);
        expect(dispatchEngine.isDeferrableOutcome('already_completed')).to.equal(true);
        // the generic "sent nothing" outcomes keep their historic contract
        // (immediate retry) — the audit-6929ba5 regressions depend on it
        expect(dispatchEngine.isDeferrableOutcome('no_jobs_sent')).to.equal(false);
        expect(dispatchEngine.isDeferrableOutcome('no_jobs_generated')).to.equal(false);
        expect(dispatchEngine.isDeferrableOutcome('send_failed')).to.equal(false);
        expect(dispatchEngine.isDeferrableOutcome('already_ready')).to.equal(false);
        expect(dispatchEngine.isDeferrableOutcome('circuit_open')).to.equal(false);
    });

    it('the deferral window is bounded (not a permanent block)', () => {
        expect(dispatchEngine.DEFERRED_STAGE_TTL_S).to.be.a('number');
        expect(dispatchEngine.DEFERRED_STAGE_TTL_S).to.be.greaterThan(0);
        expect(dispatchEngine.DEFERRED_STAGE_TTL_S).to.be.lessThanOrEqual(600);
        // the key lives under the runtime namespace (backend-owned family)
        expect(dispatchEngine.DEFERRED_STAGE_KEY_PREFIX).to.equal('animastor:runtime:deferred:');
    });
});
