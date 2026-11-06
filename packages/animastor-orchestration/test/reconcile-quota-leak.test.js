// ======================================================
// reconcile-quota-leak (2026-11-05, BA ba_1788172242081) — regression net
// ======================================================
// Incident: «Генерировать аудио → Вся книга» stalled after 4 scenes.
//   1. dispatch outcomes WITHOUT jobs that the executor reported as
//      `completed` (already_done / recovered_via_completeChunk) kept lease +
//      dispatch-meta + the owned quota slot → active-audio 8/8, zero jobs;
//   2. the periodic stale-lease recovery then demoted stages committed by the
//      current generation (DIRTY, epoch bump, PG stale);
//   3. the DRIFT check compared the counter with the NUMBER of leases — the
//      leaked leases matched the leaked counter, "0 drift";
//   4. the stale scene with a real commit could neither be restored nor
//      regenerated, the command hung silently.
//
// Isolated: in-memory Redis mock + stubbed host bindings and ports.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const { bindHostModules, clearHostBindings } = require('../src/legacy/host/host-bindings');
const persistencePort = require('../src/legacy/runtime/persistence-port');
const progressEventsPort = require('../src/legacy/runtime/progress-events-port');

const BOOK = 'ba_test_quota_leak';
const CH = 'ch-q1';
const BUILD = `build_${BOOK}`;
const COUNTER = 'animastor:runtime:active-audio';

const metaKey = (sc, stage = 'audio') => `animastor:dispatch-meta:${BOOK}:${CH}:${sc}:${stage}`;
const leaseKey = (sc, stage = 'audio') => `animastor:dispatch-lease:${BOOK}:${CH}:${sc}:${stage}`;

function makePersistence(overrides = {}) {
    const adapter = {};
    for (const op of persistencePort.OPS) {
        const noop = async () => null;
        const [ns, fn] = op.includes('.') ? op.split('.') : [null, op];
        if (ns === null) adapter[fn] = overrides[op] || noop;
        else {
            adapter[ns] = adapter[ns] || {};
            adapter[ns][fn] = overrides[op] || noop;
        }
    }
    return adapter;
}

const AssetState = {
    NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
    GENERATING: 'generating', READY: 'ready', FAILED: 'failed',
};

describe('reconcile-quota-leak (BA 2026-11-05)', function () {
    this.timeout(10000);

    let redis;
    let executorResult;
    let executorCalls;
    let assetStates;
    let stateWrites;
    let markDirtyCalls;
    let pgAssets;
    let committed;
    let failedStages;
    let blockedStages;
    let aliveWorkers;

    function freshModules() {
        for (const rel of [
            '../src/legacy/runtime/dispatch-engine',
            '../src/legacy/runtime/counter-reconciliation',
            '../src/legacy/runtime/reconciliation-engine',
            '../src/legacy/runtime/runtime-scheduler',
            '../src/legacy/runtime/command-gate',
            '../src/legacy/runtime/worker-health',
        ]) {
            delete require.cache[require.resolve(rel)];
        }
    }

    beforeEach(() => {
        redis = createMockRedis();
        executorCalls = 0;
        executorResult = { dispatched: false, jobs: 0, completed: true, reason: 'already_done' };
        assetStates = {};
        stateWrites = [];
        markDirtyCalls = [];
        pgAssets = {};
        committed = {};
        failedStages = [];
        blockedStages = [];
        aliveWorkers = 1;

        clearHostBindings();
        bindHostModules({
            config: () => ({
                OUTPUT_DIR: '/data/output',
                WORKER_HEARTBEAT_TYPES: ['audio', 'image', 'video'],
                WORKER_HEARTBEAT_TTL: 30,
                WORKER_HEARTBEAT_TYPE_PATTERN: (type) => `animastor:worker:heartbeat:${type}:*`,
            }),
            journal: () => ({ EventType: {}, appendSceneEvent: async () => true }),
            state: () => ({
                AssetState,
                getAssetStates: async (r, b, c, s) => ({ ...(assetStates[s] || {}) }),
                unsafeRestoreAssetState: async (r, b, c, s, asset, st) => {
                    stateWrites.push({ s, asset, st });
                    assetStates[s] = { ...(assetStates[s] || {}), [asset]: st };
                },
                validateAssetTransition: () => ({ valid: true }),
            }),
            seams: () => ({
                getOrchestrationSeam: (name) => {
                    if (name === 'dispatchStage') {
                        return async () => { executorCalls++; return executorResult; };
                    }
                    if (name === 'rollbackStageToPending') return async () => ({ changed: true });
                    if (name === 'markDirtyScene') {
                        return async (r, b, c, s, assets) => { markDirtyCalls.push({ s, assets }); };
                    }
                    throw new Error(`seam not wired in test: ${name}`);
                },
                isOrchestrationSeamWired: () => true,
            }),
            media: () => ({
                audio: {
                    isSceneAudioCommitted: async (buildId, b, c, s) => ({ ready: committed[s] === true }),
                },
            }),
        });
        persistencePort.setPersistencePort(makePersistence({
            'sceneAssets.getAsset': async (b, c, s, stage) => pgAssets[`${s}:${stage}`] || null,
        }));
        progressEventsPort.setProgressEventsPort({
            publishProgress: async () => {},
            getSceneTaskState: async () => ({ managed: true, activeTypes: new Set(['audio']) }),
            hasActiveTasks: async () => true,
            reconcileCompletedTasks: async () => [],
            blockSceneStage: async (r, b, c, s, type, reason) => { blockedStages.push({ s, type, reason }); return { tasks: [{ task_id: 't1' }] }; },
            failSceneStage: async (r, b, c, s, type, info) => { failedStages.push({ s, type, info }); return { tasks: [{ task_id: 't1' }] }; },
        });
        freshModules();
    });

    afterEach(() => {
        clearHostBindings();
        persistencePort._resetPersistencePort();
        progressEventsPort._resetProgressEventsPort();
    });

    const dispatch = (sc, stage = 'audio') => require('../src/legacy/runtime/dispatch-engine')
        .dispatchStage(redis, BOOK, CH, sc, stage, { book_id: BOOK }, BUILD);

    // ── (а) ─────────────────────────────────────────────
    describe('(а) a dispatch outcome without jobs releases slot + lease + meta', () => {
        for (const reason of ['already_done', 'recovered_via_completeChunk', 'cache_hit', 'scene_not_found']) {
            it(`completed outcome «${reason}» — active-audio unchanged, lease/meta removed, completed surfaced`, async () => {
                executorResult = { dispatched: false, jobs: 0, completed: true, reason };
                const res = await dispatch('sc-a');
                expect(executorCalls).to.equal(1);
                expect(res.dispatched).to.equal(false);
                expect(await redis.get(COUNTER), 'quota slot leaked').to.equal('0');
                expect(await redis.get(metaKey('sc-a')), 'dispatch-meta leaked').to.equal(null);
                expect(await redis.get(leaseKey('sc-a')), 'dispatch-lease leaked').to.equal(null);
                expect(res.completed).to.equal(true);
            });
        }

        it('no_jobs_generated (not completed) — slot released too, not reported completed', async () => {
            executorResult = { dispatched: false, jobs: 0, reason: 'no_jobs_generated', retryable: true };
            const res = await dispatch('sc-b');
            expect(res.completed).to.equal(false);
            expect(await redis.get(COUNTER)).to.equal('0');
            expect(await redis.get(metaKey('sc-b'))).to.equal(null);
            expect(await redis.get(leaseKey('sc-b'))).to.equal(null);
        });

        it('a real dispatch keeps its slot and flags the meta jobs_enqueued', async () => {
            executorResult = { dispatched: true, jobs: 7, reason: null };
            const res = await dispatch('sc-c');
            expect(res.dispatched).to.equal(true);
            expect(await redis.get(COUNTER)).to.equal('1');
            const meta = JSON.parse(await redis.get(metaKey('sc-c')));
            expect(meta.jobs_enqueued).to.equal(true);
            expect(meta.jobs).to.equal(7);
            expect(meta.quota_owned).to.equal(true);
            require('../src/legacy/runtime/dispatch-engine').stopDispatchRenewal?.(BOOK, CH, 'sc-c', 'audio');
        });
    });

    // ── (б) ─────────────────────────────────────────────
    describe('(б) N ticks in a row — the counter does not grow', () => {
        it('17 scenes × 6 ticks of already_done / recovered / no_jobs ⇒ active-audio stays 0, never backpressure', async () => {
            const outcomes = [
                { dispatched: false, jobs: 0, completed: true, reason: 'already_done' },
                { dispatched: false, jobs: 0, completed: true, reason: 'recovered_via_completeChunk' },
                { dispatched: false, jobs: 0, reason: 'no_jobs_generated', retryable: true },
            ];
            const engine = require('../src/legacy/runtime/dispatch-engine');
            let backpressure = 0;
            for (let tick = 0; tick < 6; tick++) {
                for (let i = 0; i < 17; i++) {
                    executorResult = outcomes[(tick + i) % outcomes.length];
                    // a deferral would hide the executor — clear it to force an attempt
                    await redis.del(engine.deferredStageKey(BOOK, CH, `sc-${i}`, 'audio'));
                    const res = await dispatch(`sc-${i}`);
                    if (res.reason === 'backpressure') backpressure++;
                }
                expect(await redis.get(COUNTER)).to.equal('0');
            }
            expect(backpressure).to.equal(0);
            expect(executorCalls).to.equal(17 * 6);
        });
    });

    // ── (в) ─────────────────────────────────────────────
    describe('(в) stale-lease recovery never demotes a stage committed by the current generation', () => {
        async function staleLeaseFor(sc) {
            await redis.set(leaseKey(sc), 'tok-1');
            await redis.set(metaKey(sc), JSON.stringify({
                dispatch_id: `dispatch-${sc}`, stage: 'audio', started_at: Date.now() - 40 * 60 * 1000,
                status: 'dispatched', lease_key: leaseKey(sc), lease_token: 'tok-1', quota_owned: true,
            }));
            await redis.set(COUNTER, '1');
        }

        it('committed + PG ready ⇒ lease/quota released, asset re-asserted READY, NO markDirtyScene', async () => {
            await staleLeaseFor('sc-r');
            assetStates['sc-r'] = { audio: AssetState.PENDING };
            pgAssets['sc-r:audio'] = { status: 'ready' };
            committed['sc-r'] = true;
            const rec = require('../src/legacy/runtime/reconciliation-engine');
            const out = await rec.applyFix(redis, { action: 'RELEASE_STALE_LEASE', scene: { bookId: BOOK, chapterId: CH, sceneId: 'sc-r' } });
            expect(out.success).to.equal(true);
            expect(markDirtyCalls).to.deep.equal([]);
            expect(stateWrites).to.deep.include({ s: 'sc-r', asset: 'audio', st: AssetState.READY });
            expect(await redis.get(COUNTER)).to.equal('0');
            expect(await redis.get(leaseKey('sc-r'))).to.equal(null);
        });

        it('NOT committed ⇒ the historic recovery (markDirtyScene for the in-flight stage)', async () => {
            await staleLeaseFor('sc-n');
            assetStates['sc-n'] = { audio: AssetState.GENERATING };
            pgAssets['sc-n:audio'] = { status: 'ready' };
            committed['sc-n'] = false;
            const rec = require('../src/legacy/runtime/reconciliation-engine');
            await rec.applyFix(redis, { action: 'RELEASE_STALE_LEASE', scene: { bookId: BOOK, chapterId: CH, sceneId: 'sc-n' } });
            expect(markDirtyCalls).to.deep.equal([{ s: 'sc-n', assets: ['audio'] }]);
        });

        it('committed but PG stale ⇒ not trusted here (left to the dispatch path + version gate)', async () => {
            const rec = require('../src/legacy/runtime/reconciliation-engine');
            pgAssets['sc-s:audio'] = { status: 'stale' };
            committed['sc-s'] = true;
            expect(await rec.isStageCommittedReady(BOOK, CH, 'sc-s', 'audio')).to.equal(false);
            pgAssets['sc-s:audio'] = { status: 'ready' };
            expect(await rec.isStageCommittedReady(BOOK, CH, 'sc-s', 'audio')).to.equal(true);
            expect(await rec.isStageCommittedReady(BOOK, CH, 'sc-s', 'image')).to.equal(false);
        });
    });

    // ── (г) ─────────────────────────────────────────────
    describe('(г) DRIFT reconciliation repairs the phantom counter', () => {
        async function phantom(sc, extra = {}) {
            await redis.set(leaseKey(sc), `tok-${sc}`);
            await redis.set(metaKey(sc), JSON.stringify({
                dispatch_id: `dispatch-${sc}`, stage: 'audio', started_at: Date.now() - 10 * 60 * 1000,
                worker: 'scheduler', retry_attempt: 0, status: 'dispatched',
                lease_key: leaseKey(sc), lease_token: `tok-${sc}`, quota_owned: true, ...extra,
            }));
        }

        it('BA snapshot: 8 phantom dispatches, counter 8/8 ⇒ cancelled on the 2nd sweep, counter 0', async () => {
            for (let i = 0; i < 8; i++) await phantom(`sc-p${i}`);
            await redis.set(COUNTER, '8');
            const cr = require('../src/legacy/runtime/counter-reconciliation');

            const first = await cr.reconcileCounters(redis);
            // first sweep only marks suspects (no cancel on a single observation)
            expect(await redis.get(COUNTER)).to.equal('8');
            expect(first.summary.phantomsCancelled || 0).to.equal(0);

            const second = await cr.reconcileCounters(redis);
            expect(second.summary.phantomsCancelled).to.equal(8);
            expect(await redis.get(COUNTER)).to.equal('0');
            for (let i = 0; i < 8; i++) {
                expect(await redis.get(metaKey(`sc-p${i}`))).to.equal(null);
                expect(await redis.get(leaseKey(`sc-p${i}`))).to.equal(null);
            }
        });

        it('live dispatches are kept: jobs_enqueued, a hub job (running / queue), or younger than the grace', async () => {
            await phantom('sc-live-flag', { jobs_enqueued: true });
            await phantom('sc-live-running');
            await phantom('sc-live-queue');
            await phantom('sc-young', { started_at: Date.now() });
            await phantom('sc-dead');
            await redis.hset('animastor:running', 'job-1', JSON.stringify({ dispatch_id: 'dispatch-sc-live-running', job_type: 'audio' }));
            await redis.rpush('animastor:queue:audio', JSON.stringify({ job_id: 'job-2', dispatch_id: 'dispatch-sc-live-queue' }));
            await redis.set(COUNTER, '5');
            const cr = require('../src/legacy/runtime/counter-reconciliation');
            await cr.reconcileCounters(redis);
            await cr.reconcileCounters(redis);
            expect(await redis.get(metaKey('sc-dead'))).to.equal(null);
            for (const sc of ['sc-live-flag', 'sc-live-running', 'sc-live-queue', 'sc-young']) {
                expect(await redis.get(metaKey(sc)), sc).to.not.equal(null);
            }
            expect(await redis.get(COUNTER)).to.equal('4');
        });

        it('a lease without metadata keeps the historic semantics (counted, never cancelled)', async () => {
            await redis.set(leaseKey('sc-bare'), 'tok');
            await redis.set(COUNTER, '3');
            const cr = require('../src/legacy/runtime/counter-reconciliation');
            await cr.reconcileCounters(redis);
            await cr.reconcileCounters(redis);
            expect(await redis.get(leaseKey('sc-bare'))).to.equal('tok');
            expect(await redis.get(COUNTER)).to.equal('1');
        });
    });

    // ── (е, scheduler part) ─────────────────────────────
    describe('(е) a command without movement does not hang silently', () => {
        it('backpressure with NO worker of the type alive anywhere ⇒ blocked no_worker', async () => {
            await redis.set(COUNTER, '8'); // full quota
            const gate = require('../src/legacy/runtime/command-gate');
            // simulate the scheduler branch: no heartbeat keys exist in the mock
            const wh = require('../src/legacy/runtime/worker-health');
            expect(await wh.getAnyAliveCount(redis, 'audio')).to.equal(0);
            await gate.blockStageNoWorker(redis, BOOK, CH, 'sc-x', 'audio');
            expect(blockedStages).to.deep.equal([{ s: 'sc-x', type: 'audio', reason: 'no_worker:audio' }]);
        });

        it('a fresh heartbeat of the type (any scope) counts as alive — no block', async () => {
            const wh = require('../src/legacy/runtime/worker-health');
            await redis.set('animastor:worker:heartbeat:audio:w1', JSON.stringify({ worker_id: 'w1', ts: Date.now(), mode: 'private', workspace_id: 'ws-1' }));
            expect(await wh.getAnyAliveCount(redis, 'audio')).to.equal(1);
            await redis.set('animastor:worker:heartbeat:audio:w2', JSON.stringify({ worker_id: 'w2', ts: Date.now() - 120000 }));
            expect(await wh.getAnyAliveCount(redis, 'audio')).to.equal(1);
        });

        it('no-progress outcomes fail the command only after the time window AND ≥3 attempts', async () => {
            const gate = require('../src/legacy/runtime/command-gate');
            const t0 = 1_000_000;
            let np = await gate.noteNoProgress(redis, BOOK, CH, 'sc-np', 'audio', 'no_jobs_generated', t0);
            expect(np.exceeded).to.equal(false);
            np = await gate.noteNoProgress(redis, BOOK, CH, 'sc-np', 'audio', 'locked', t0 + 5_000);
            np = await gate.noteNoProgress(redis, BOOK, CH, 'sc-np', 'audio', 'no_jobs_generated', t0 + 10_000);
            expect(np.attempts).to.equal(3);
            expect(np.exceeded).to.equal(false); // 3 attempts, but only 10 s
            np = await gate.noteNoProgress(redis, BOOK, CH, 'sc-np', 'audio', 'no_jobs_generated', t0 + gate.NO_PROGRESS_FAIL_MS);
            expect(np.exceeded).to.equal(true);
            const res = await gate.failStageNoProgress(redis, BOOK, CH, 'sc-np', 'audio', 'no_jobs_generated', np.attempts);
            expect(res.error_class).to.equal('no_progress');
            expect(failedStages).to.have.length(1);
            expect(failedStages[0].info.error_code).to.equal('no_jobs_generated');
            expect(await redis.get(gate.noProgressKey(BOOK, CH, 'sc-np', 'audio'))).to.equal(null);
        });

        it('progress resets the window', async () => {
            const gate = require('../src/legacy/runtime/command-gate');
            await gate.noteNoProgress(redis, BOOK, CH, 'sc-rs', 'audio', 'no_jobs_generated', 1);
            await gate.clearNoProgress(redis, BOOK, CH, 'sc-rs', 'audio');
            const np = await gate.noteNoProgress(redis, BOOK, CH, 'sc-rs', 'audio', 'no_jobs_generated', 2 + gate.NO_PROGRESS_FAIL_MS);
            expect(np.attempts).to.equal(1);
            expect(np.exceeded).to.equal(false);
        });
    });
});
