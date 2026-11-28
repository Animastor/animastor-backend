// ======================================================
// layer-config → PG (2026-11-27): reconcile PHASE C6 is gone
// ======================================================
// Until 1.4.3 the real reconcileCycle healed the Redis layer-config keys from
// book.json (PHASE C6, layer_config_restore:N). Layer-config is PG-only now:
// the cycle (startup and periodic) writes no layer-config key, reports no
// C6 phase, and the PG row / book.json copy stay as they were. The rest of
// the cycle runs on the real modules with mock redis and must stay ok:true.
// The C6 removal ships in @animastor/orchestration 1.4.4 (legacy runtime).

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');

require('./vbook-test-bindings.cjs');
const config = require('../src/config/runtime-config');
const layerConfig = require('../src/services/layer-config');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const reconciliation = require('../node_modules/@animastor/orchestration/src/legacy/runtime/reconciliation-engine');
// S-5: production seam wiring (reconcileCycle resolves FSM writers via seams)
require('./helpers/wire-seams').wireProductionSeams();

const BOOK = `lcnr-${Date.now().toString(36)}`;

describe('layer-config: reconcileCycle no longer touches it (C6 removed, PG-only)', () => {
    let tmpDir;
    let savedBooksDir;
    let redis;

    before(async () => {
        await runMigrations();
        await query(`INSERT INTO books (book_id, title, orchestration) VALUES ($1, 'lcnr', 'legacy')`, [BOOK]);
    });
    after(async () => {
        await query('DELETE FROM books WHERE book_id = $1', [BOOK]);
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-lcnr-'));
        savedBooksDir = config.BOOKS_DIR;
        config.BOOKS_DIR = tmpDir;
        redis = createMockRedis();
    });

    afterEach(() => {
        config.BOOKS_DIR = savedBooksDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeBookDir(bookId, meta) {
        const bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(meta));
    }

    for (const startup of [true, false]) {
        it(`${startup ? 'startup' : 'periodic'} cycle: no layer_config_restore phase, no layer-config key in Redis, PG row unchanged`, async () => {
            writeBookDir(BOOK, { structure: { chapters_order: [] } });
            await layerConfig.set(BOOK, { image_enabled: false });
            const rowBefore = (await query('SELECT config::text AS c, updated_at FROM book_layer_config WHERE book_id = $1', [BOOK])).rows[0];
            // book.json says otherwise — C6 would have pushed this into Redis
            writeBookDir(BOOK, { structure: { chapters_order: [] }, layer_config: { image_enabled: true, video_enabled: false } });

            const result = await reconciliation.reconcileCycle(redis, {}, { startup });

            expect(result.ok).to.be.true;
            expect(result.summary.errors).to.deep.equal([]);
            expect(result.phases.some((p) => p.startsWith('layer_config_restore'))).to.equal(false);
            expect((await redis.scan('0', 'MATCH', 'animastor:layer-config:*', 'COUNT', 1000))[1]).to.deep.equal([]);
            const rowAfter = (await query('SELECT config::text AS c, updated_at FROM book_layer_config WHERE book_id = $1', [BOOK])).rows[0];
            expect(rowAfter).to.deep.equal(rowBefore);
            expect((await layerConfig.get(BOOK)).image_enabled).to.equal(false);
        });
    }
});
