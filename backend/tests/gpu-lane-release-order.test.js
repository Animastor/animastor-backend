// ======================================================
// Stage 118 — GPU lane release ordering (audit 117 · B4)
//
// The Stage 116 implementation released the backend-side pending claims
// BEFORE the hub lane was cleared. That order opened a duplicate window:
// when the hub call failed, the claims were already free while the lane
// entries survived ⇒ the next dispatch enqueued a SECOND copy of a task
// that was still queued.
//
// The contract now: the lane is cleared FIRST; the claims are released only
// after the hub confirmed. On a hub failure the claims are KEPT (the safe
// direction — no duplicates).
//
// Isolated: the route modules with stubbed hubs, no production Redis/PG.
// ======================================================

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

describe('Stage 118: GPU lane release ordering (audit 117 · B4)', () => {
    const modulePaths = [
        '../src/routes/book/generation-routes.cjs',
        '../src/routes/book/cache-routes.cjs',
        '../src/storage/postgres/repositories/scene-assets-repo',
        '../src/storage/postgres/repositories/task-repo',
        '../src/storage/postgres/repositories/generation-cancel-repo',
        '../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler',
        '../node_modules/@animastor/orchestration/src/runtime/scene-window',
    ];
    const savedCache = new Map();

    beforeEach(() => {
        savedCache.clear();
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            savedCache.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
    });

    afterEach(() => {
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            const saved = savedCache.get(resolved);
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
    });

    function stub(request, exports) {
        const resolved = require.resolve(request);
        require.cache[resolved] = { exports, id: resolved, filename: resolved, loaded: true };
    }

    /** A queue-idempotency port double that records the release order. */
    function makeQidem(order) {
        return {
            releaseClaimsForBook: async (redis, bookId) => {
                order.push(`release:${bookId}`);
                return { released: 1, done: 1, scanned: 1 };
            },
            releaseClaimsForScene: async (redis, bookId, chapterId, sceneId) => {
                order.push(`release-scene:${bookId}/${chapterId}/${sceneId}`);
                return { released: 1, done: 1, scanned: 1 };
            },
        };
    }

    function stubBaseModules() {
        stub('../src/storage/postgres/repositories/scene-assets-repo', {
            setDirtyUnitIds: async () => {},
            markStale: async () => {},
            getAsset: async () => null,
            ensureSceneRow: async () => {},
        });
        stub('../src/storage/postgres/repositories/task-repo', {
            createTask: async () => {},
            updateTaskStatus: async () => {},
            cancelActiveTasksForBook: async () => 0,
        });
        stub('../src/storage/postgres/repositories/generation-cancel-repo', {
            setCancelled: async () => {},
            clear: async () => {},
            isCancelled: async () => false,
            getAllCancelled: async () => [],
        });
        stub('../node_modules/@animastor/orchestration/src/runtime/runtime-scheduler', {
            clearBookFromActiveIndex: async () => {},
            addSceneToActiveIndex: async () => {},
            removeScenesFromActiveIndex: async () => {},
        });
        stub('../node_modules/@animastor/orchestration/src/runtime/scene-window', {
            setCancelFlag: async () => {},
            clearCancelFlag: async () => {},
        });
    }

    // ── cancel-generation ─────────────────────────────────────────────────
    describe('POST /api/v1/book/:bookId/cancel-generation', () => {
        function registerCancel(redis, deps) {
            const handlers = new Map();
            const app = { post(p, h) { handlers.set(p, h); }, get() {}, put() {}, delete() {} };
            require('../src/routes/book/generation-routes.cjs')(app, redis, deps);
            return handlers.get('/api/v1/book/:bookId/cancel-generation');
        }

        it('clears the hub lane BEFORE the claims are released', async () => {
            stubBaseModules();
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const deps = {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null },
                    runtime: {
                        sceneWindow: { setCancelFlag: async () => {}, clearCancelFlag: async () => {} },
                        scheduler: { clearBookFromActiveIndex: async () => {}, addSceneToActiveIndex: async () => {} },
                    },
                    utils: { log: () => {} },
                    queueIdempotency: makeQidem(order),
                };
                const handler = registerCancel(redis, deps);
                const response = createResponse();
                await handler({ params: { bookId: 'order-book' } }, response);
                expect(response.statusCode).to.equal(200);
                // the hub clear comes FIRST, the release SECOND
                expect(order[0]).to.match(/^hub-clear:/);
                expect(order[1]).to.equal('release:order-book');
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('keeps the claims when the hub clear FAILS (no duplicate window)', async () => {
            stubBaseModules();
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async () => ({ ok: false, status: 500 });
            try {
                const deps = {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null },
                    runtime: {
                        sceneWindow: { setCancelFlag: async () => {}, clearCancelFlag: async () => {} },
                        scheduler: { clearBookFromActiveIndex: async () => {}, addSceneToActiveIndex: async () => {} },
                    },
                    utils: { log: () => {} },
                    queueIdempotency: makeQidem(order),
                };
                const handler = registerCancel(redis, deps);
                const response = createResponse();
                await handler({ params: { bookId: 'failed-hub-book' } }, response);
                // the hub failure is reported (500) and NO claim was released
                expect(response.statusCode).to.equal(500);
                expect(order.filter(o => o.startsWith('release:'))).to.have.length(0);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('Stage 120 (M-b): the lane is swept a SECOND time after the claims are released', async () => {
            stubBaseModules();
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const deps = {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null },
                    runtime: {
                        sceneWindow: { setCancelFlag: async () => {}, clearCancelFlag: async () => {} },
                        scheduler: { clearBookFromActiveIndex: async () => {}, addSceneToActiveIndex: async () => {} },
                    },
                    utils: { log: () => {} },
                    queueIdempotency: makeQidem(order),
                };
                const handler = registerCancel(redis, deps);
                const response = createResponse();
                await handler({ params: { bookId: 'cancel-sweep-book' } }, response);
                expect(response.statusCode).to.equal(200);
                const releaseIdx = order.indexOf('release:cancel-sweep-book');
                const hubClears = order.map((o, i) => (o.startsWith('hub-clear:') ? i : -1)).filter(i => i >= 0);
                // clear → release → CLEAR: a dispatch landing between the two
                // cannot leave an orphan lane entry behind
                expect(hubClears).to.have.length(2);
                expect(hubClears[0]).to.be.lessThan(releaseIdx);
                expect(hubClears[1]).to.be.greaterThan(releaseIdx);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });
    });

    // ── cache teardown ────────────────────────────────────────────────────
    describe('DELETE /api/v1/book/:bookId/cache', () => {
        function registerCache(redis, ctx) {
            const handlers = new Map();
            const app = { post(p, h) { handlers.set(p, h); }, get(p, h) { handlers.set(p, h); }, put() {}, delete(p, h) { handlers.set(p, h); } };
            require('../src/routes/book/cache-routes.cjs')(app, { ...ctx, redis });
            return handlers.get('/api/v1/book/:bookId/cache');
        }

        it('clears the hub lane BEFORE the claims are released', async () => {
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const handler = registerCache(redis, {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null, OUTPUT_DIR: '/tmp/opencode/no-output' },
                    storage: { postgres: { query: async () => {} } },
                    path: require('path'),
                    fs: require('fs'),
                    getAllChunks: async () => [],
                    getChunk: async () => null,
                    cleanBookRedisKeys: async () => {},
                    purgeAssistantForBook: async () => {},
                    queueIdempotency: makeQidem(order),
                    clearDeferrals: { book: async () => { order.push('clear-deferrals'); return 0; } },
                    log: () => {},
                });
                const response = createResponse();
                await handler({ params: { bookId: 'cache-order-book' } }, response);
                expect(response.statusCode).to.equal(200);
                expect(order[0]).to.match(/^hub-clear:/);
                expect(order).to.include('release:cache-order-book');
                expect(order.indexOf('release:cache-order-book')).to.be.greaterThan(0);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('keeps the claims when the hub clear FAILS', async () => {
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async () => ({ ok: false, status: 500 });
            try {
                const handler = registerCache(redis, {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null, OUTPUT_DIR: '/tmp/opencode/no-output' },
                    storage: { postgres: { query: async () => {} } },
                    path: require('path'),
                    fs: require('fs'),
                    getAllChunks: async () => [],
                    getChunk: async () => null,
                    cleanBookRedisKeys: async () => {},
                    purgeAssistantForBook: async () => {},
                    queueIdempotency: makeQidem(order),
                    clearDeferrals: { book: async () => 0 },
                    log: () => {},
                });
                const response = createResponse();
                await handler({ params: { bookId: 'cache-failed-hub' } }, response);
                expect(response.statusCode).to.equal(200);
                expect(order.filter(o => o.startsWith('release:'))).to.have.length(0);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('Stage 120 (M-a): a FAILED hub clear is reported honestly instead of {cleared:true}', async () => {
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async () => { order.push('hub-clear:attempt'); return { ok: false, status: 500 }; };
            try {
                const handler = registerCache(redis, {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null, OUTPUT_DIR: '/tmp/opencode/no-output' },
                    storage: { postgres: { query: async () => {} } },
                    path: require('path'),
                    fs: require('fs'),
                    getAllChunks: async () => [],
                    getChunk: async () => null,
                    cleanBookRedisKeys: async () => {},
                    purgeAssistantForBook: async () => {},
                    queueIdempotency: makeQidem(order),
                    clearDeferrals: { book: async () => 0 },
                    log: () => {},
                });
                const response = createResponse();
                await handler({ params: { bookId: 'cache-ma-book' } }, response);
                // the claims/markers were KEPT (the safe direction) — the
                // caller must learn that the book will NOT auto-regenerate
                // until they expire (audit 119 · M-a, proof-p11 P11.7)
                expect(response.statusCode).to.equal(200);   // the teardown itself ran
                expect(response.body).to.be.an('object');
                expect(response.body.cleared).to.equal(false);
                expect(response.body.hub_cleared).to.equal(false);
                expect(response.body.claims_kept).to.equal(true);
                expect(response.body.error).to.equal('hub_queue_clear_failed');
                expect(response.body.book_id).to.equal('cache-ma-book');
                // nothing was released and no post-release sweep runs
                expect(order.filter(o => o.startsWith('release:'))).to.have.length(0);
                expect(order).to.have.length(1);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('Stage 120 (M-b): the lane is swept a SECOND time after the claims are released', async () => {
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const handler = registerCache(redis, {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null, OUTPUT_DIR: '/tmp/opencode/no-output' },
                    storage: { postgres: { query: async () => {} } },
                    path: require('path'),
                    fs: require('fs'),
                    getAllChunks: async () => [],
                    getChunk: async () => null,
                    cleanBookRedisKeys: async () => {},
                    purgeAssistantForBook: async () => {},
                    queueIdempotency: makeQidem(order),
                    clearDeferrals: { book: async () => { order.push('clear-deferrals'); return 0; } },
                    log: () => {},
                });
                const response = createResponse();
                await handler({ params: { bookId: 'cache-sweep-book' } }, response);
                expect(response.statusCode).to.equal(200);
                expect(response.body.cleared).to.equal(true);
                const releaseIdx = order.indexOf('release:cache-sweep-book');
                const hubClears = order.map((o, i) => (o.startsWith('hub-clear:') ? i : -1)).filter(i => i >= 0);
                // clear → release → CLEAR (the orphan-entry window of the
                // Stage 118 order is closed)
                expect(hubClears).to.have.length(2);
                expect(hubClears[0]).to.be.lessThan(releaseIdx);
                expect(hubClears[1]).to.be.greaterThan(releaseIdx);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('Stage 120 (M-b): a FAILED claim release still ends with the safety sweep (recoverable state)', async () => {
            const redis = createMockRedis();
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const failingQidem = {
                    ...makeQidem(order),
                    releaseClaimsForBook: async () => { order.push('release:boom'); throw new Error('scan failed'); },
                };
                const handler = registerCache(redis, {
                    config: { HUB_URL: 'http://gpu-hub.invalid', GPU_HUB_API_KEY: null, OUTPUT_DIR: '/tmp/opencode/no-output' },
                    storage: { postgres: { query: async () => {} } },
                    path: require('path'),
                    fs: require('fs'),
                    getAllChunks: async () => [],
                    getChunk: async () => null,
                    cleanBookRedisKeys: async () => {},
                    purgeAssistantForBook: async () => {},
                    queueIdempotency: failingQidem,
                    clearDeferrals: { book: async () => 0 },
                    log: () => {},
                });
                const response = createResponse();
                await handler({ params: { bookId: 'cache-release-fail' } }, response);
                // the release error is contained (warn) and the SECOND sweep
                // still runs — the state stays consistent either way
                expect(response.statusCode).to.equal(200);
                expect(order).to.include('release:boom');
                expect(order[order.length - 1]).to.match(/^hub-clear:/);
                expect(order.filter(o => o.startsWith('hub-clear:')).length).to.equal(2);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });
    });

    // ── Stage 120 — book deletion cascade sweep (audit 119 · M-b) ─────────
    describe('DELETE book cascade (audit 119 · M-b)', () => {
        function makeDeletion(order) {
            const { createBookDeletion } = require('../src/services/book-deletion.cjs');
            return createBookDeletion({
                book: { resetBook: async () => {} },
                redis: createMockRedis(),
                storage: { postgres: { query: async () => {} } },
                config: { BOOKS_DIR: '/tmp/opencode/no-books', OUTPUT_DIR: '/tmp/opencode/no-output' },
                getAllChunks: async () => [],
                getChunk: async () => null,
                cleanBookRedisKeys: async () => {},
                log: () => {},
                setCancelFlag: async () => {},
                agentSessionControl: { cancelSessions: async () => {} },
                purgeAssistantForBook: async () => {},
                queueIdempotency: makeQidem(order),
                clearDeferrals: { book: async () => { order.push('clear-deferrals'); return 0; } },
            });
        }

        it('M-b: deleteBook sweeps the hub lane AGAIN after releasing the claims', async () => {
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async (url) => {
                order.push(`hub-clear:${String(url).includes('queue/clear')}`);
                return { ok: true, status: 200 };
            };
            try {
                const result = await makeDeletion(order).deleteBook('del-sweep-book');
                expect(result.deleted).to.equal(true);
                const releaseIdx = order.indexOf('release:del-sweep-book');
                const hubClears = order.map((o, i) => (o.startsWith('hub-clear:') ? i : -1)).filter(i => i >= 0);
                expect(releaseIdx).to.be.greaterThan(0);
                expect(hubClears).to.have.length(2);
                expect(hubClears[0]).to.be.lessThan(releaseIdx);
                expect(hubClears[1]).to.be.greaterThan(releaseIdx);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });

        it('M-b: when the FIRST hub clear fails the claims are KEPT and no sweep runs', async () => {
            const order = [];
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async () => { order.push('hub-clear:attempt'); return { ok: false, status: 500 }; };
            try {
                const result = await makeDeletion(order).deleteBook('del-failed-hub');
                expect(result.deleted).to.equal(true);
                // safe direction: nothing released, exactly one (failed) attempt
                expect(order.filter(o => o.startsWith('release:'))).to.have.length(0);
                expect(order).to.have.length(1);
            } finally {
                globalThis.fetch = savedFetch;
            }
        });
    });

    // ── Stage 120 — regenerate path sweep (audit 119 · M-b) ───────────────
    describe('/regenerate post-release sweep (audit 119 · M-b)', () => {
        it('the regenerate path sweeps the hub lane again through the hubCancel port', () => {
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '../src/routes/book/generation-routes.cjs'), 'utf8');
            const releaseIdx = src.indexOf('releaseClaimsForScene(');
            const sweepIdx = src.indexOf("hubCancelOp('clearHubDispatches')");
            expect(releaseIdx).to.be.greaterThan(0);
            // the sweep must come AFTER the per-scene claim release
            expect(sweepIdx).to.be.greaterThan(releaseIdx);
            expect(src).to.include('Stage 120 (M-b)');
            // the port is consulted (never a blind call on an unwired port)
            expect(src).to.include('isHubCancelPortWired()');
        });
    });

    // ── Stage 122 — behavioural book-scoped sweep (audit 121 · N1) ────────
    // The Stage 120 structural test only checked the call SITE existed. Audit
    // 121 · N1 proved the call was a NO-OP: clearHubDispatches ignored book_id
    // and an empty id list issued ZERO hub requests. These cases pin the FIXED
    // CONTRACT: the exact hub request and the real result accounting.
    describe('clearHubDispatches book-scoped sweep (audit 121 · N1)', () => {
        const clearHubDispatches = () => require('@animastor/orchestration').runtime.dispatch.clearHubDispatches;
        const HUB = 'http://hub.test';

        it('empty ids + book_id issues EXACTLY one book-scoped DELETE and reports it', async () => {
            const requests = [];
            const fetchImpl = async (url, opts) => {
                requests.push({ url, method: opts.method });
                return { ok: true, status: 200, json: async () => ({ ok: true, scope: { book_id: 'bk-n1' }, removed: {} }) };
            };
            const result = await clearHubDispatches()([], { book_id: 'bk-n1', hubUrl: HUB, apiKey: 'k', fetchImpl, warn: () => {} });
            expect(requests).to.have.lengthOf(1);
            expect(requests[0].method).to.equal('DELETE');
            expect(requests[0].url).to.equal(`${HUB}/queue/clear?book_id=bk-n1`);
            expect(result).to.deep.equal({ requested: 1, cleared: 1, failed: 0 });
        });

        it('a hub ERROR is reported honestly (failed, never cleared)', async () => {
            const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
            const result = await clearHubDispatches()([], { book_id: 'bk-n1', hubUrl: HUB, fetchImpl, warn: () => {} });
            expect(result).to.deep.equal({ requested: 1, cleared: 0, failed: 1 });
        });

        it('an UNREACHABLE hub counts as failed and never throws', async () => {
            const fetchImpl = async () => { throw new Error('ECONNREFUSED 127.0.0.1:1'); };
            const result = await clearHubDispatches()([], { book_id: 'bk-n1', hubUrl: HUB, fetchImpl, warn: () => {} });
            expect(result).to.deep.equal({ requested: 1, cleared: 0, failed: 1 });
        });

        it('a hub that echoes a FOREIGN scope is a failure (never clears other books)', async () => {
            const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, scope: { book_id: 'OTHER-book' }, removed: {} }) });
            const result = await clearHubDispatches()([], { book_id: 'bk-n1', hubUrl: HUB, fetchImpl, warn: () => {} });
            expect(result).to.deep.equal({ requested: 1, cleared: 0, failed: 1 });
        });

        it('empty ids and NO book_id issues NO request at all (no fake HTTP)', async () => {
            const requests = [];
            const fetchImpl = async (url) => { requests.push(url); return { ok: true, status: 200, json: async () => ({}) }; };
            const result = await clearHubDispatches()([], { hubUrl: HUB, fetchImpl, warn: () => {} });
            expect(requests).to.have.lengthOf(0);
            expect(result).to.deep.equal({ requested: 0, cleared: 0, failed: 0 });
        });

        it('the per-id form is unchanged (one DELETE per dispatch id)', async () => {
            const requests = [];
            const fetchImpl = async (url) => { requests.push(url); return { ok: true, status: 200 }; };
            const result = await clearHubDispatches()(['d1', 'd2'], { hubUrl: HUB, fetchImpl, warn: () => {} });
            expect(requests).to.have.lengthOf(2);
            expect(requests[0]).to.include('dispatch_id=d1');
            expect(requests[1]).to.include('dispatch_id=d2');
            expect(result).to.deep.equal({ requested: 2, cleared: 2, failed: 0 });
        });
    });
});
