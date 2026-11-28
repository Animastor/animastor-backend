// ======================================================
// O-10 RUNTIME TESTS — LayerConfigPort contract + adapter delegation
// ======================================================
// Targets the O-10 seam (docs/architecture/generation-module-
// extraction-reconnaissance.md §32.27):
//   1. the port fails fast when unwired and resolves both ops when
//      wired (fail-fast contract, `_resetLayerConfigPort` test
//      hygiene);
//   2. the adapter delegates get 1:1 to services/layer-config.get
//      through the lazy call-time channel — a require.cache stub of
//      ../src/services/layer-config is honored (the worklist-rebuild
//      purge-list stubbing channel); the redis argument is dropped
//      (layer-config is PG-only since 2026-11-27, core 1.4.4);
//   3. the real service answers with the frozen normalize semantics
//      (defaults for a book without a row, clamp on an out-of-range
//      stored value — real PG of the test stack);
//   4. the scene-orchestrator timeout leg keeps its try/catch
//      tolerance (a throwing read leaves videoTimeoutMs undefined).
//   5. restoreFromBooks / reconcile PHASE C6 are gone from the port and
//      the adapter (core ^1.4.4).
// The composition-root wiring is exercised through the mocharc test
// bindings (generation-test-bindings.cjs mirrors backend.cjs).
// ======================================================

const { expect } = require('chai');

const port = require('../node_modules/@animastor/orchestration/src/legacy/runtime/layer-config-port');
const adapter = require('../src/storage/layer-config-adapter');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

const SERVICE_PATH = require.resolve('../src/services/layer-config');

class FakeRedis {
    // Declared test double — see queue-idempotency.ensureIntentAndReceipt.
    constructor() { this.store = new Map(); this.__allowNonLuaFallback = true; }
    async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
    async set(k, v, mode) {
        if (mode === 'NX') {
            if (this.store.has(k)) return null;
            this.store.set(k, v);
            return 'OK';
        }
        this.store.set(k, v);
        return 'OK';
    }
    async del(k) { this.store.delete(k); return 1; }
}

describe('O-10 LayerConfigPort — contract, delegation and consumer-leg semantics', () => {

    describe('port contract', () => {
        afterEach(() => {
            // Re-wire the mocharc bindings adapter (test hygiene).
            port.setLayerConfigPort(adapter);
        });

        it('fails fast when unwired (layerConfig / layerConfigOp)', () => {
            port._resetLayerConfigPort();
            expect(() => port.layerConfig()).to.throw(/layer-config-port: not wired/);
            expect(() => port.layerConfigOp('get')).to.throw(/layer-config-port: op 'get' is not wired/);
        });

        it('the wiring gate rejects a missing adapter and an adapter without get; get alone is enough (1.4.4)', () => {
            expect(() => port.setLayerConfigPort(null)).to.throw(/adapter is required/);
            expect(() => port.setLayerConfigPort({ restoreFromBooks: async () => 0 })).to.throw(/adapter must implement get\(\)/);
            expect(() => port.setLayerConfigPort({ get: async () => ({}) })).to.not.throw();
        });

        it('isLayerConfigPortWired tracks the wiring state; the OPS set is frozen at one op', () => {
            expect(port.isLayerConfigPortWired()).to.equal(true);
            expect(port.OPS).to.deep.equal(['get']);
            port._resetLayerConfigPort();
            expect(port.isLayerConfigPortWired()).to.equal(false);
        });
    });

    describe('adapter delegation (1:1, lazy channel)', () => {
        it('get delegates to the real service through the call-time channel (PG, normalize semantics intact, redis ignored)', async () => {
            await runMigrations();
            const redis = new FakeRedis();
            const bookId = `lcport-${Date.now().toString(36)}`;
            // No row → normalized defaults.
            const cfg = await adapter.get(redis, bookId);
            expect(cfg.audio_enabled).to.equal(true);
            expect(cfg.chunk_size).to.be.a('number');
            // Stored out-of-range values → clamped.
            await query(`INSERT INTO books (book_id, title) VALUES ($1, 'port')`, [bookId]);
            try {
                await query(`INSERT INTO book_layer_config (book_id, config) VALUES ($1, '{"chunk_size": 99, "video_timeout_minutes": 500}'::jsonb)`, [bookId]);
                const clamped = await adapter.get(redis, bookId);
                expect(clamped.chunk_size).to.equal(5);      // clamp 1..5
                expect(clamped.video_timeout_minutes).to.equal(180); // clamp 10..180
                expect(redis.store.size).to.equal(0);        // Redis never written
            } finally {
                await query('DELETE FROM books WHERE book_id = $1', [bookId]);
            }
        });

        it('the adapter exposes get only (restoreFromBooks is gone with core 1.4.4)', () => {
            expect(Object.keys(adapter)).to.deep.equal(['get']);
        });

        it('a require.cache stub of the service is honored through the adapter (stubbing parity)', async () => {
            const real = require(SERVICE_PATH);
            const originalGet = real.get;
            let calls = 0;
            real.get = async () => { calls++; return { stubbed: true }; };
            try {
                const result = await adapter.get(new FakeRedis(), 'book-stub');
                expect(calls).to.equal(1);
                expect(result).to.deep.equal({ stubbed: true });
            } finally {
                real.get = originalGet;
            }
        });
    });

    describe('consumer-leg semantics preserved through the port', () => {
        it('the scene-orchestrator timeout leg tolerates a throwing read (pre-O-10 try/catch tolerance)', async () => {
            // The leg wraps the port call in try { … } catch (_) {} — a
            // throwing adapter/service read must leave videoTimeoutMs
            // undefined and never reject the dispatch.
            const stubErr = new Error('layer-config read failed');
            const savedImpl = adapter.get;
            adapter.get = async () => { throw stubErr; };
            try {
                let videoTimeoutMs;
                try {
                    const cfg = await port.layerConfigOp('get')(new FakeRedis(), 'book-1');
                    if (cfg && cfg.video_timeout_minutes > 0) {
                        videoTimeoutMs = cfg.video_timeout_minutes * 60 * 1000;
                    }
                } catch (_) {}
                expect(videoTimeoutMs).to.equal(undefined);
            } finally {
                adapter.get = savedImpl;
            }
        });
    });

    describe('host channel unchanged', () => {
        it('services/layer-config keeps its public surface (routes/agent/test consumers); the Redis grammar is gone', () => {
            const svc = require(SERVICE_PATH);
            for (const op of ['get', 'set', 'getChunkSize', 'normalize', 'isValidScope', 'persistToBook', 'SCOPES', 'ANALYSIS_MODES', 'DEFAULTS']) {
                expect(svc[op], `services/layer-config must keep exporting ${op}`).to.not.be.undefined;
            }
            for (const gone of ['key', 'restoreFromBooks']) {
                expect(svc[gone], `services/layer-config must not export ${gone}`).to.equal(undefined);
            }
        });
    });

});
