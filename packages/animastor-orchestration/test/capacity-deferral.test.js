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
        expect(dispatchEngine.isDeferrableOutcome('ambiguous_post')).to.equal(true);
        // Stage 118 (M4): 'already_completed' is NOT a capacity gap — the
        // logical task is already complete. It stays deferrable (the stage
        // must not spin) but in its OWN bucket with its own window.
        expect(dispatchEngine.isCapacityOutcome('already_completed')).to.equal(false);
        expect(dispatchEngine.isIdempotentOutcome('already_completed')).to.equal(true);
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

    // ── Stage 118 (audit 117) ─────────────────────────────────────────────
    describe('Stage 118: audit 117 corrections', () => {
        it('M2: force mode does NOT bypass the deferral', async () => {
            await dispatch();                       // deferred (capacity)
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
            const callsBefore = executorCalls;
            // The force-dispatch flag lives for 120 s and is set for the WHOLE
            // book by /regenerate — bypassing the backoff there reproduced the
            // very churn D3 removes (≈24 full attempts per scene).
            const forced = await dispatchEngine.dispatchStage(
                redis, BOOK, CHAPTER, SCENE, 'image', { book_id: BOOK }, BUILD, { force: true }
            );
            expect(forced.dispatched).to.equal(false);
            expect(forced.reason).to.equal('deferred_capacity');
            expect(forced.deferred).to.equal(true);
            expect(executorCalls).to.equal(callsBefore);   // no side effect
        });

        it('M4: the idempotent suppression gets its OWN (longer) window', async () => {
            executorResult = { dispatched: false, jobs: 0, reason: 'already_completed', retryable: true };
            await dispatch();
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
            expect(dispatchEngine.deferralWindowFor('already_completed'))
                .to.equal(dispatchEngine.DEFERRED_IDEMPOTENT_TTL_S);
            expect(dispatchEngine.deferralWindowFor('no_worker_available'))
                .to.equal(dispatchEngine.DEFERRED_STAGE_TTL_S);
            expect(dispatchEngine.DEFERRED_IDEMPOTENT_TTL_S)
                .to.be.greaterThan(dispatchEngine.DEFERRED_STAGE_TTL_S);
        });

        it('M1: a book_id containing ":" cannot reach into another book key space', async () => {
            const bookA = 'a';
            const bookB = 'a:b';
            const chapter = 'ch';
            const scene = 'sc';
            // the deferral key of book 'a' / chapter 'b' must not collide
            // with the key of book 'a:b'
            executorResult = { dispatched: false, jobs: 0, reason: 'no_worker_available', retryable: true };
            await dispatchEngine.dispatchStage(redis, bookA, chapter, scene, 'image', { book_id: bookA }, BUILD);
            expect(await dispatchEngine.isStageDeferred(redis, bookA, chapter, scene, 'image')).to.equal(true);
            expect(await dispatchEngine.isStageDeferred(redis, bookB, chapter, scene, 'image')).to.equal(false);
            expect(dispatchEngine.deferredStageKey(bookA, chapter, scene, 'image'))
                .to.not.equal(dispatchEngine.deferredStageKey(bookB, chapter, scene, 'image'));
        });

        it('M2: an explicit intent clears the backoff of a book / a scene', async () => {
            await dispatch();
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
            const cleared = await dispatchEngine.clearDeferralsForBook(redis, BOOK);
            expect(cleared).to.be.greaterThan(0);
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);

            await dispatch();
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(true);
            await dispatchEngine.clearDeferralsForScene(redis, BOOK, CHAPTER, SCENE);
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);
            // a sibling book is untouched
            await dispatchEngine.dispatchStage(redis, 'other-book', CHAPTER, SCENE, 'image', { book_id: 'other-book' }, BUILD);
            await dispatchEngine.clearDeferralsForBook(redis, 'other-book');
            expect(await dispatchEngine.isStageDeferred(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(false);
        });

        it('M3: several deferrable reasons are classified (the dominant one is reported)', () => {
            const { classifyNotSentReasons } = require('../src/runtime/dispatch-outcomes');
            expect(classifyNotSentReasons(new Map([['no_worker_available', 3], ['duplicate_pending', 1]])))
                .to.equal('no_worker_available');
            // a real failure keeps the historic semantics
            expect(classifyNotSentReasons(new Map([['no_worker_available', 3], ['send_failed', 1]])))
                .to.equal(null);
            expect(classifyNotSentReasons(new Map())).to.equal(null);
        });
    });
});
