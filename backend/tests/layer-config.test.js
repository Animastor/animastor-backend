// ======================================================
// Layer Config Service — PG only (book_layer_config, ORCHESTRATION_V2 §11.1)
// ======================================================
// Real PG of the test stack. The service never touches Redis: every case
// passes `noRedis` (a Proxy that throws on ANY property access) through the
// legacy (redis, bookId[, partial]) signature, and the new signature too.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const layerConfig = require('../src/services/layer-config');
const config = require('../src/config/runtime-config');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

const RUN = `lc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const noRedis = new Proxy({}, { get(_t, prop) { throw new Error(`Redis touched: .${String(prop)}`); } });

describe('Layer Config Service', () => {
    const books = new Set();
    let tmpBooks; let savedBooksDir;
    const id = (tag) => `${RUN}-${tag}`;
    async function register(tag) {
        const bookId = id(tag);
        await query(`INSERT INTO books (book_id, title) VALUES ($1, 'lc') ON CONFLICT (book_id) DO NOTHING`, [bookId]);
        books.add(bookId);
        return bookId;
    }
    const rowOf = async (bookId) => (await query('SELECT config, updated_at FROM book_layer_config WHERE book_id = $1', [bookId])).rows[0];
    function writeBookJson(bookId, meta) {
        fs.mkdirSync(path.join(tmpBooks, bookId), { recursive: true });
        fs.writeFileSync(path.join(tmpBooks, bookId, 'book.json'), JSON.stringify(meta));
    }
    const readBookJson = (bookId) => JSON.parse(fs.readFileSync(path.join(tmpBooks, bookId, 'book.json'), 'utf8'));

    before(async () => {
        await runMigrations();
        for (const t of ['b1', 'b2', 'b4', 'b5', 'b6', 'b7', 'b-para', 'b-bogus', 'b-p', 'b-mix']) await register(t);
    });
    beforeEach(() => {
        tmpBooks = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-lc-svc-'));
        savedBooksDir = config.BOOKS_DIR;
        config.BOOKS_DIR = tmpBooks;
    });
    afterEach(() => {
        config.BOOKS_DIR = savedBooksDir;
        fs.rmSync(tmpBooks, { recursive: true, force: true });
    });
    after(async () => {
        for (const b of books) await query('DELETE FROM books WHERE book_id = $1', [b]);
    });

    const DEFAULTS = {
        audio_enabled: true,
        image_enabled: true,
        video_enabled: true,
        chunk_size: 3,
        analysis_mode: 'sequential',
        analysis_parallelism: 3,
        audio_timeout_minutes: 30,
        image_timeout_minutes: 30,
        video_timeout_minutes: 60,
    };

    it('returns defaults for an unknown book (no row, no book.json) and writes no row', async () => {
        const bookId = await register('unknown');
        expect(await layerConfig.get(bookId)).to.deep.equal(DEFAULTS);
        expect(await layerConfig.get(noRedis, bookId)).to.deep.equal(DEFAULTS);
        expect(await rowOf(bookId)).to.equal(undefined);
    });

    it('a stored partial row is normalized on read (legacy single-flag JSON)', async () => {
        const bookId = await register('legacy');
        await query(`INSERT INTO book_layer_config (book_id, config) VALUES ($1, '{"image_enabled": false}'::jsonb)`, [bookId]);
        const cfg = await layerConfig.get(bookId);
        expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false });
    });

    it('a stored row with out-of-range values is clamped on read', async () => {
        const bookId = await register('clamp-read');
        await query(`INSERT INTO book_layer_config (book_id, config) VALUES ($1, '{"chunk_size": 99, "analysis_mode": "turbo"}'::jsonb)`, [bookId]);
        const cfg = await layerConfig.get(bookId);
        expect(cfg.chunk_size).to.equal(5);
        expect(cfg.analysis_mode).to.equal('sequential');
    });

    it('set merges partial update', async () => {
        await layerConfig.set(id('b1'), { image_enabled: false });
        const cfg = await layerConfig.get(id('b1'));
        expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false });
    });

    it('set preserves untouched fields', async () => {
        await layerConfig.set(id('b2'), { video_enabled: false });
        await layerConfig.set(id('b2'), { image_enabled: false });
        const cfg = await layerConfig.get(id('b2'));
        expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false, video_enabled: false });
    });

    it('set allows audio_enabled=false (image-only mode)', async () => {
        const cfg = await layerConfig.set(id('b4'), { audio_enabled: false });
        expect(cfg.audio_enabled).to.be.false;
        expect(cfg.image_enabled).to.be.true;
        expect(cfg.chunk_size).to.equal(3);
    });

    it('set supports chunk_size field', async () => {
        const cfg = await layerConfig.set(id('b5'), { chunk_size: 5 });
        expect(cfg.chunk_size).to.equal(5);
        // Reload from PG
        const got = await layerConfig.get(id('b5'));
        expect(got.chunk_size).to.equal(5);
    });

    it('set clamps chunk_size to valid range [1,5]', async () => {
        const cfgLow = await layerConfig.set(id('b6'), { chunk_size: 0 });
        expect(cfgLow.chunk_size).to.equal(1);
        const cfgHigh = await layerConfig.set(id('b6'), { chunk_size: 10 });
        expect(cfgHigh.chunk_size).to.equal(5);
    });

    it('set clamps timeout values to valid ranges', async () => {
        const cfgLow = await layerConfig.set(id('b7'), { audio_timeout_minutes: 1 });
        expect(cfgLow.audio_timeout_minutes).to.equal(5);
        const cfgHigh = await layerConfig.set(id('b7'), { video_timeout_minutes: 999 });
        expect(cfgHigh.video_timeout_minutes).to.equal(180);
    });

    it('isValidScope accepts only known values', () => {
        expect(layerConfig.isValidScope('current_scene')).to.be.true;
        expect(layerConfig.isValidScope('current_chapter')).to.be.true;
        expect(layerConfig.isValidScope('from_current_scene')).to.be.true;
        expect(layerConfig.isValidScope('whole_book')).to.be.true;
        expect(layerConfig.isValidScope('everywhere')).to.be.false;
    });

    it('the Redis key grammar is gone from the public surface', () => {
        expect(layerConfig).to.not.have.property('key');
        expect(layerConfig).to.not.have.property('restoreFromBooks');
    });

    it('SCOPES is frozen', () => {
        expect(Object.isFrozen(layerConfig.SCOPES)).to.be.true;
    });

    it('set/get without a bookId return defaults and touch nothing', async () => {
        expect(await layerConfig.set(null, undefined, { image_enabled: false })).to.deep.equal(DEFAULTS);
        expect(await layerConfig.get(undefined)).to.deep.equal(DEFAULTS);
        expect(await layerConfig.get(null, undefined)).to.deep.equal(DEFAULTS);
    });

    it('the legacy (redis, bookId, partial) signature works and never touches Redis', async () => {
        const bookId = await register('legacy-sig');
        const cfg = await layerConfig.set(noRedis, bookId, { video_enabled: false });
        expect(cfg.video_enabled).to.equal(false);
        expect(await layerConfig.get(noRedis, bookId)).to.deep.equal(cfg);
        expect(await layerConfig.getChunkSize(noRedis, bookId)).to.equal(3);
        expect(await layerConfig.get(bookId)).to.deep.equal(cfg);
    });

    // ── PG semantics (ORCHESTRATION_V2 §11.1, 2026-11-27) ──
    describe('PG storage', () => {
        it('no row, book.json has layer_config → get returns it AND writes the row; later reads come from PG', async () => {
            const bookId = await register('seed');
            writeBookJson(bookId, { structure: {}, layer_config: { image_enabled: false, chunk_size: 2, updated_at: 1 } });
            const cfg = await layerConfig.get(bookId);
            expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false, chunk_size: 2 });
            const row = await rowOf(bookId);
            expect(row.config).to.deep.equal(cfg);
            // book.json changes no longer matter: PG is the store
            writeBookJson(bookId, { structure: {}, layer_config: { image_enabled: true } });
            expect((await layerConfig.get(bookId)).image_enabled).to.equal(false);
        });

        it('no row, no book.json → defaults, no row; a book.json without layer_config → same', async () => {
            const a = await register('none-a');
            expect(await layerConfig.get(a)).to.deep.equal(DEFAULTS);
            expect(await rowOf(a)).to.equal(undefined);
            const b = await register('none-b');
            writeBookJson(b, { structure: {} });
            expect(await layerConfig.get(b)).to.deep.equal(DEFAULTS);
            expect(await rowOf(b)).to.equal(undefined);
        });

        it('a book without a books row: get serves the book.json copy; set merges into book.json only (no row, no error)', async () => {
            const ghost = id('ghost');
            writeBookJson(ghost, { structure: {}, layer_config: { video_enabled: false } });
            expect((await layerConfig.get(ghost)).video_enabled).to.equal(false);
            expect(await rowOf(ghost)).to.equal(undefined);
            const cfg = await layerConfig.set(ghost, { image_enabled: false });
            expect(cfg).to.deep.equal({ ...DEFAULTS, video_enabled: false, image_enabled: false });
            expect(await rowOf(ghost)).to.equal(undefined);
            expect(readBookJson(ghost).layer_config).to.include({ video_enabled: false, image_enabled: false });
            // once the book is registered, the first get() seeds the row from that copy
            await query(`INSERT INTO books (book_id, title) VALUES ($1, 'lc')`, [ghost]);
            books.add(ghost);
            expect(await layerConfig.get(ghost)).to.deep.equal(cfg);
            expect((await rowOf(ghost)).config).to.deep.equal(cfg);
        });

        it('set writes the row (updated_at moves) and the book.json copy', async () => {
            const bookId = await register('write');
            writeBookJson(bookId, { structure: {} });
            await layerConfig.set(bookId, { image_enabled: false });
            const r1 = await rowOf(bookId);
            expect(r1.config).to.deep.equal({ ...DEFAULTS, image_enabled: false });
            await new Promise((r) => setTimeout(r, 5));
            await layerConfig.set(bookId, { chunk_size: 4 });
            const r2 = await rowOf(bookId);
            expect(r2.config).to.deep.equal({ ...DEFAULTS, image_enabled: false, chunk_size: 4 });
            expect(r2.updated_at.getTime()).to.be.greaterThan(r1.updated_at.getTime());
            const copy = readBookJson(bookId).layer_config;
            expect(copy).to.include({ image_enabled: false, chunk_size: 4 });
            expect(copy.updated_at).to.be.a('number');
        });

        it('concurrent set() on different fields → every change is kept (one transaction per set, per-book lock)', async () => {
            const bookId = await register('race');
            writeBookJson(bookId, { structure: {} });
            const partials = [
                { audio_enabled: false }, { image_enabled: false }, { video_enabled: false },
                { chunk_size: 1 }, { analysis_mode: 'parallel' }, { analysis_parallelism: 7 },
                { audio_timeout_minutes: 11 }, { image_timeout_minutes: 12 }, { video_timeout_minutes: 13 },
            ];
            for (let round = 0; round < 3; round += 1) {
                await query('DELETE FROM book_layer_config WHERE book_id = $1', [bookId]);
                await Promise.all(partials.map((p) => layerConfig.set(bookId, p)));
                const expected = Object.assign({ ...DEFAULTS }, ...partials);
                expect(await layerConfig.get(bookId), `round ${round}`).to.deep.equal(expected);
                expect(readBookJson(bookId).layer_config, `book.json round ${round}`).to.include(expected);
            }
        });

        it('concurrent first get() (lazy seed) and set() → set wins, one row', async () => {
            const bookId = await register('seed-race');
            writeBookJson(bookId, { structure: {}, layer_config: { image_enabled: false } });
            await Promise.all([layerConfig.get(bookId), layerConfig.set(bookId, { video_enabled: false }), layerConfig.get(bookId)]);
            const cfg = await layerConfig.get(bookId);
            expect(cfg).to.include({ image_enabled: false, video_enabled: false });
            expect(Number((await query('SELECT count(*) AS n FROM book_layer_config WHERE book_id = $1', [bookId])).rows[0].n)).to.equal(1);
        });

        it('deleting the book removes its row (ON DELETE CASCADE)', async () => {
            const bookId = await register('cascade');
            await layerConfig.set(bookId, { image_enabled: false });
            expect(await rowOf(bookId)).to.be.an('object');
            await query('DELETE FROM books WHERE book_id = $1', [bookId]);
            books.delete(bookId);
            expect(await rowOf(bookId)).to.equal(undefined);
        });
    });

    // ── Parallel/Subagent AI Analysis (Reconnaissance, Milestone #1) ──
    describe('analysis_mode contract', () => {
        it('defaults to sequential for unknown books (backwards compat)', async () => {
            const cfg = await layerConfig.get(id('unknown-book'));
            expect(cfg.analysis_mode).to.equal('sequential');
            expect(cfg.analysis_parallelism).to.equal(3);
        });

        it('ANALYSIS_MODES exposes sequential and parallel values', () => {
            expect(layerConfig.ANALYSIS_MODES).to.deep.equal({
                SEQUENTIAL: 'sequential',
                PARALLEL:   'parallel',
            });
        });

        it('set accepts analysis_mode=parallel and roundtrips it', async () => {
            const cfg = await layerConfig.set(id('b-para'), { analysis_mode: 'parallel' });
            expect(cfg.analysis_mode).to.equal('parallel');
            const got = await layerConfig.get(id('b-para'));
            expect(got.analysis_mode).to.equal('parallel');
        });

        it('set rejects unknown analysis_mode values and falls back to sequential', async () => {
            const cfg = await layerConfig.set(id('b-bogus'), { analysis_mode: 'turbo' });
            expect(cfg.analysis_mode).to.equal('sequential');
        });

        it('set clamps analysis_parallelism to [1, 8]', async () => {
            const cfgLow = await layerConfig.set(id('b-p'), { analysis_parallelism: 0 });
            expect(cfgLow.analysis_parallelism).to.equal(1);
            const cfgHigh = await layerConfig.set(id('b-p'), { analysis_parallelism: 999 });
            expect(cfgHigh.analysis_parallelism).to.equal(8);
        });

        it('partial set preserves untouched analysis fields', async () => {
            await layerConfig.set(id('b-mix'), { analysis_mode: 'parallel', analysis_parallelism: 4 });
            const cfg = await layerConfig.set(id('b-mix'), { image_enabled: false });
            expect(cfg.analysis_mode).to.equal('parallel');
            expect(cfg.analysis_parallelism).to.equal(4);
            expect(cfg.image_enabled).to.equal(false);
        });

        it('normalize() coerces a missing analysis_mode to sequential', () => {
            const cfg = layerConfig.normalize({ chunk_size: 2 });
            expect(cfg.analysis_mode).to.equal('sequential');
        });
    });
});
