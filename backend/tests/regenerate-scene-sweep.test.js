// ======================================================
// /regenerate never sweeps other scenes' GPU jobs (2026-11-04)
// ======================================================
// Incident reports/2026-11-04/gpu-generation-stall.md §5.3/§9.1: a one-scene
// audio /regenerate (scope current_scene, ch-5e5a8c76/sc-4bb85e02) ended with
// clearHubDispatches([], { book_id }) → DELETE /queue/clear?book_id= — the hub
// removed the RUNNING image job of sc-7cd391e4 (its result was rejected 409
// and lost) and the QUEUED image job of sc-4bb85e02 (recovered only by
// stale-lease recovery 7 min later).
//
// Fix (reports/2026-11-04/regenerate-sweep-fix.md): the post-release sweep
// targets only the dispatch ids resetScenes cancelled for this call; a
// book-wide sweep only for a full restart of the whole book; the
// book-scoped clearHubDispatches form is fail-closed (allowBookSweep).
//
// Real modules: the /regenerate route, orchestration resetScenes + dispatch
// engine (leases / finalize / clearHubDispatches), command gate, task
// registry, queue idempotency — over the in-memory Redis mock. The GPU hub is
// an in-process emulator of DELETE /queue/clear (book_id → every record of
// the book, dispatch_id → that dispatch only) behind globalThis.fetch.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const { wireProductionSeams } = require('./helpers/wire-seams');
const sweepPlan = require('../src/services/regenerate-hub-sweep.cjs');

const BOOK = `ba-sweep-${Date.now()}`;
const CH = 'ch-5e5a8c76';
const S_TARGET = 'sc-4bb85e02'; // the scene of the audio /regenerate
const S_OTHER = 'sc-7cd391e4';  // another scene — image job RUNNING on the worker

function createResponse() {
    return {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

/** In-process hub: records keyed by job, DELETE /queue/clear semantics. */
function fakeHub() {
    const records = new Map(); // job_id → { book_id, dispatch_id, where: 'running'|'queued' }
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        calls.push({ method: opts.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams) });
        if (u.pathname !== '/queue/clear' || opts.method !== 'DELETE') {
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        const bookId = u.searchParams.get('book_id');
        const dispatchId = u.searchParams.get('dispatch_id');
        const removed = { queued: 0, running: 0 };
        for (const [job, r] of [...records]) {
            const hit = dispatchId ? r.dispatch_id === dispatchId : (bookId ? r.book_id === bookId : true);
            if (hit) { records.delete(job); removed[r.where]++; }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, scope: { book_id: bookId || null, dispatch_id: dispatchId || null }, removed }) };
    };
    return { records, calls, fetchImpl };
}

async function putDispatch(redis, chapterId, sceneId, stage, dispatchId) {
    const leaseKey = `animastor:dispatch-lease:${BOOK}:${chapterId}:${sceneId}:${stage}`;
    await redis.set(leaseKey, `tok-${dispatchId}`);
    await redis.set(`animastor:dispatch-meta:${BOOK}:${chapterId}:${sceneId}:${stage}`, JSON.stringify({
        dispatch_id: dispatchId, lease_key: leaseKey, lease_token: `tok-${dispatchId}`, quota_owned: false,
        book_id: BOOK, chapter_id: chapterId, scene_id: sceneId, stage, started_at: Date.now(),
    }));
}

describe('/regenerate hub sweep is scene-scoped (incident 2026-11-04)', function () {
    this.timeout(20000);

    const modulePaths = [
        '../src/routes/book/generation-routes.cjs',
        '../src/storage/postgres/repositories/scene-assets-repo',
        '../src/storage/postgres/repositories/task-repo',
        '../src/storage/postgres/repositories/generation-cancel-repo',
        '../src/storage/postgres/repositories/book-repo',
    ];
    const savedCache = new Map();
    let savedFetch;
    let hub;
    let logs;
    let pgTasks;

    function stub(request, exports) {
        const resolved = require.resolve(request);
        require.cache[resolved] = { exports, id: resolved, filename: resolved, loaded: true };
    }

    beforeEach(() => {
        wireProductionSeams();
        savedCache.clear();
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            savedCache.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            setDirtyUnitIds: async () => {}, ensureSceneRow: async () => {},
        });
        pgTasks = [];
        stub('../src/storage/postgres/repositories/task-repo', {
            createTask: async (taskId, bookId, chapterId, sceneId, type) => { pgTasks.push({ taskId, bookId, chapterId, sceneId, type }); },
            updateTaskStatus: async () => {},
        });
        stub('../src/storage/postgres/repositories/generation-cancel-repo', { clear: async () => {} });
        stub('../src/storage/postgres/repositories/book-repo', { getWorkspaceId: async () => null });
        hub = fakeHub();
        savedFetch = globalThis.fetch;
        globalThis.fetch = hub.fetchImpl;
        logs = [];
    });

    afterEach(() => {
        globalThis.fetch = savedFetch;
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            const saved = savedCache.get(resolved);
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
        wireProductionSeams();
    });

    function mountRoute(redis, layerCfg) {
        const orchestration = require('@animastor/orchestration');
        const handlers = new Map();
        const app = { post(p, h) { handlers.set(p, h); }, get() {}, put() {}, delete() {} };
        const allScenes = [S_OTHER, S_TARGET, 'sc-d75dee8e'].map(scene_id => ({ chapter_id: CH, scene_id, payload: { units: [] } }));
        const deps = {
            config: { HUB_URL: 'http://127.0.0.1:9' },
            book: {
                loadBook: () => ({ manifest: { build_id: `build_${BOOK}` } }),
                collectScenes: () => allScenes,
            },
            layerConfig: { get: async () => layerCfg, set: async () => layerCfg },
            bookDiff: {
                filterDirtyScenesByScope: (dirty, scope, chapterId, sceneId) => {
                    if (scope === 'current_scene') return dirty.filter(d => d.chapter_id === chapterId && d.scene_id === sceneId);
                    if (scope === 'current_chapter') return dirty.filter(d => d.chapter_id === chapterId);
                    return dirty;
                },
                markDirtyScenes: async (_r, _b, _build, scenes) => ({ marked: scenes.length }),
            },
            storage: {},
            orchestrator: orchestration,
            queueIdempotency: require('../src/helpers/queue-idempotency.cjs'),
            regenerateHubSweep: sweepPlan,
            runtime: {
                sceneWindow: { clearCancelFlag: async () => {}, setCancelFlag: async () => {} },
                scheduler: orchestration.runtime.scheduler,
            },
            utils: { log: (m) => logs.push(m) },
        };
        require('../src/routes/book/generation-routes.cjs')(app, redis, deps);
        return handlers.get('/api/v1/book/:bookId/regenerate');
    }

    async function seedIncident(redis) {
        // In-flight image command of the chapter: S_OTHER running on the
        // worker, S_TARGET queued. Plus a stale audio dispatch of S_TARGET
        // (the one the audio /regenerate legitimately resets).
        await putDispatch(redis, CH, S_OTHER, 'image', 'dispatch-img-other');
        await putDispatch(redis, CH, S_TARGET, 'image', 'dispatch-img-target');
        await putDispatch(redis, CH, S_TARGET, 'audio', 'dispatch-aud-target');
        hub.records.set(`${BOOK}_${CH}_${S_OTHER}_iu-677669ab:iu_image`, { book_id: BOOK, dispatch_id: 'dispatch-img-other', where: 'running' });
        hub.records.set(`${BOOK}_${CH}_${S_TARGET}_iu-4152f8a6:iu_image`, { book_id: BOOK, dispatch_id: 'dispatch-img-target', where: 'queued' });
        hub.records.set(`${BOOK}_${CH}_${S_TARGET}_0001:audio`, { book_id: BOOK, dispatch_id: 'dispatch-aud-target', where: 'queued' });
    }

    it('one-scene AUDIO /regenerate keeps the running and the queued IMAGE jobs of the book (no book-wide sweep)', async () => {
        const redis = createMockRedis();
        await seedIncident(redis);
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });

        const res = createResponse();
        await handler({ params: { bookId: BOOK }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) OPR/102.0.0.0' }, body: {
            scope: 'current_scene', chapter_id: CH, scene_id: S_TARGET, worker_types: ['audio'], rebuild_all: true,
            client_action: { kind: 'user_click', source: 'generator.scope_dialog', action_id: 'ua-0123456789abcdef', trusted: true },
        } }, res);
        expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
        // which click sent the command (logged, never a reason to refuse)
        const cmdLine = logs.find(l => /\[REGENERATE\].*: command scope=/.test(l));
        expect(cmdLine, logs.join('\n')).to.include('client_action=generator.scope_dialog id=ua-0123456789abcdef trusted=true');
        expect(cmdLine).to.include(`scope=current_scene/${CH}/${S_TARGET} worker_types=audio`);
        expect(cmdLine).to.include('ua=Mozilla');

        // Not a single book-scoped hub request.
        const bookSweeps = hub.calls.filter(c => c.path === '/queue/clear' && c.query.book_id);
        expect(bookSweeps, 'book-wide /queue/clear').to.deep.equal([]);
        // Image jobs of the book survive: the running one (S_OTHER) and the
        // queued one of the SAME scene (another stage).
        expect(hub.records.has(`${BOOK}_${CH}_${S_OTHER}_iu-677669ab:iu_image`), 'running image of another scene').to.equal(true);
        expect(hub.records.has(`${BOOK}_${CH}_${S_TARGET}_iu-4152f8a6:iu_image`), 'queued image of the target scene').to.equal(true);
        // The reset stage's own dispatch is cleared.
        expect(hub.records.has(`${BOOK}_${CH}_${S_TARGET}_0001:audio`), 'reset audio dispatch').to.equal(false);
        const perDispatch = hub.calls.filter(c => c.path === '/queue/clear').map(c => c.query.dispatch_id);
        expect(perDispatch.every(id => id === 'dispatch-aud-target'), perDispatch.join(',')).to.equal(true);
        // Image leases untouched.
        expect(await redis.get(`animastor:dispatch-lease:${BOOK}:${CH}:${S_OTHER}:image`)).to.equal('tok-dispatch-img-other');
        expect(await redis.get(`animastor:dispatch-lease:${BOOK}:${CH}:${S_TARGET}:image`)).to.equal('tok-dispatch-img-target');

        // [REGENERATE] log: scope, dispatch ids, book_sweep=false.
        const line = logs.find(l => /\[REGENERATE\].*hub sweep/.test(l));
        expect(line, logs.join('\n')).to.be.a('string');
        expect(line).to.include(`scope=current_scene/${CH}/${S_TARGET}`);
        expect(line).to.include('book_sweep=false');
    });

    it('a chapter-scoped IMAGE /regenerate does not sweep the book either', async () => {
        const redis = createMockRedis();
        await seedIncident(redis);
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });
        const res = createResponse();
        await handler({ params: { bookId: BOOK }, body: {
            scope: 'current_chapter', chapter_id: CH, worker_types: ['image'], rebuild_all: true,
        } }, res);
        expect(res.statusCode).to.equal(200);
        // an old client (no client_action) is still accepted — marked absent
        expect(logs.find(l => /: command scope=/.test(l))).to.include('client_action=absent');
        expect(hub.calls.filter(c => c.query.book_id)).to.deep.equal([]);
        // the audio job (not part of an image command) survives
        expect(hub.records.has(`${BOOK}_${CH}_${S_TARGET}_0001:audio`)).to.equal(true);
    });

    // Integration E §6: the click guard lives in the fronts; the backend only
    // LOGS the source. An old client (web before 6f29cfc, APK ≤ 0.2.5) sends
    // no client_action and must still get its command and its task.
    it('an old client WITHOUT client_action → 200, the task is created (Redis + PG), source logged as absent', async () => {
        const redis = createMockRedis();
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });
        const res = createResponse();
        await handler({ params: { bookId: BOOK }, headers: { 'user-agent': 'okhttp/4.12.0' }, body: {
            scope: 'current_scene', chapter_id: CH, scene_id: S_TARGET, worker_types: ['audio'], rebuild_all: true,
        } }, res);
        expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
        expect(res.body.error).to.equal(undefined);
        expect(res.body.tasks).to.have.lengthOf(1);
        expect(res.body.tasks[0]).to.include({ type: 'audio', target_count: 1 });
        expect(pgTasks.map(t => [t.type, t.chapterId, t.sceneId])).to.deep.equal([['audio', CH, S_TARGET]]);
        expect(pgTasks[0].taskId).to.equal(res.body.tasks[0].task_id);
        expect(logs.find(l => /: command scope=/.test(l))).to.include('client_action=absent');
    });

    it('client_action with trusted=false is logged, never refused (200, task created)', async () => {
        const redis = createMockRedis();
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });
        const res = createResponse();
        await handler({ params: { bookId: BOOK }, body: {
            scope: 'current_chapter', chapter_id: CH, worker_types: ['image'], rebuild_all: true,
            client_action: { kind: 'user_click', source: 'generator.retry_row', action_id: 'ua-00000000000000ff', trusted: false },
        } }, res);
        expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
        expect(res.body.tasks).to.have.lengthOf(1);
        expect(res.body.tasks[0].type).to.equal('image');
        expect(logs.find(l => /: command scope=/.test(l))).to.include('client_action=generator.retry_row id=ua-00000000000000ff trusted=false');
    });

    it('«Generate Audio» → «Whole book» (fronts always send rebuild_all:true) with image also enabled → no book-wide sweep', async () => {
        const redis = createMockRedis();
        await seedIncident(redis);
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });
        const res = createResponse();
        await handler({ params: { bookId: BOOK }, body: {
            scope: 'whole_book', chapter_id: null, scene_id: null, worker_types: ['audio'], rebuild_all: true,
            client_action: { kind: 'user_click', source: 'generator.scope_dialog', action_id: 'ua-0123456789abcdee', trusted: true },
        } }, res);
        expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
        expect(hub.calls.filter(c => c.query.book_id), 'book-wide /queue/clear').to.deep.equal([]);
        // the image command of the book is not touched by an audio command
        expect(hub.records.has(`${BOOK}_${CH}_${S_OTHER}_iu-677669ab:iu_image`)).to.equal(true);
        expect(hub.records.has(`${BOOK}_${CH}_${S_TARGET}_iu-4152f8a6:iu_image`)).to.equal(true);
        expect(logs.find(l => /\[REGENERATE\].*hub sweep/.test(l))).to.include('book_sweep=false');
    });

    it('a full restart of the whole book (whole_book + every enabled layer) may sweep the book', async () => {
        const redis = createMockRedis();
        await seedIncident(redis);
        const handler = mountRoute(redis, { audio_enabled: true, image_enabled: true, video_enabled: false });
        const res = createResponse();
        await handler({ params: { bookId: BOOK }, body: {
            scope: 'whole_book', worker_types: ['audio', 'image'], rebuild_all: true,
        } }, res);
        expect(res.statusCode).to.equal(200);
        const bookSweeps = hub.calls.filter(c => c.path === '/queue/clear' && c.query.book_id === BOOK);
        expect(bookSweeps).to.have.lengthOf(1);
        const line = logs.find(l => /\[REGENERATE\].*hub sweep/.test(l));
        expect(line).to.include('book_sweep=true');
    });
});

describe('planRegenerateHubSweep (pure, fail-closed)', () => {
    const { planRegenerateHubSweep } = sweepPlan;
    const enabled = ['audio', 'image'];

    it('current_scene → only the reset dispatch ids', () => {
        const p = planRegenerateHubSweep({ scope: 'current_scene', rebuildAll: true, requestedWorkerTypes: ['audio'], enabledWorkerTypes: enabled, dispatchIds: ['d1', 'd1', null, 'd2'] });
        expect(p).to.deep.equal({ mode: 'dispatch', book_sweep: false, dispatch_ids: ['d1', 'd2'], full_book_restart: false });
    });

    it('nothing reset → no sweep at all (never book-wide)', () => {
        for (const scope of ['current_scene', 'current_chapter', 'from_current_scene']) {
            expect(planRegenerateHubSweep({ scope, rebuildAll: true, requestedWorkerTypes: enabled, enabledWorkerTypes: enabled, dispatchIds: [] }).mode).to.equal('none');
        }
        expect(planRegenerateHubSweep({}).mode).to.equal('none');
    });

    it('whole_book of ONE layer is not a full restart', () => {
        const p = planRegenerateHubSweep({ scope: 'whole_book', rebuildAll: true, requestedWorkerTypes: ['audio'], enabledWorkerTypes: enabled, dispatchIds: [] });
        expect(p.book_sweep).to.equal(false);
    });

    it('whole_book without rebuild_all (diff run) is not a full restart', () => {
        const p = planRegenerateHubSweep({ scope: 'whole_book', rebuildAll: false, requestedWorkerTypes: enabled, enabledWorkerTypes: enabled, dispatchIds: ['d1'] });
        expect(p).to.include({ mode: 'dispatch', book_sweep: false });
    });

    it('whole_book + rebuild_all + every enabled layer → book sweep allowed', () => {
        const p = planRegenerateHubSweep({ scope: 'whole_book', rebuildAll: true, requestedWorkerTypes: ['image', 'audio'], enabledWorkerTypes: enabled, dispatchIds: [] });
        expect(p).to.include({ mode: 'book', book_sweep: true, full_book_restart: true });
    });

    it('log line carries scope, ids and book_sweep', () => {
        const line = sweepPlan.formatSweepLog('b1', 'current_scene/ch/sc', { mode: 'dispatch', book_sweep: false, dispatch_ids: ['d1', 'd2'] });
        expect(line).to.equal('[REGENERATE] b1: hub sweep scope=current_scene/ch/sc dispatch_ids=[d1,d2] book_sweep=false mode=dispatch');
    });
});
