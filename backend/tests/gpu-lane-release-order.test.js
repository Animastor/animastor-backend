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
    });
});
