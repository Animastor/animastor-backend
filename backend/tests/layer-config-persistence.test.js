// ======================================================
// Кирпич №2 — Persistent Layer Configuration
// ======================================================
// Проверяет копию layer-config в book.json (хранилище — PG book_layer_config,
// 2026-11-27; book.json — best-effort копия для экспорта/переносимости):
//   1. set() дублирует конфиг в book.json
//   2. get() без PG-строки один раз засевает её из book.json (в т.ч. из
//      legacy single-file <bookId>.json); restoreFromBooks/C6 больше нет
//   3. saveBookBundle() не затирает layer_config при перезаписи book.json
//   4. legacy single-file формат (<bookId>.json) тоже поддерживается

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const layerConfig = require('../src/services/layer-config');
require('./vbook-test-bindings.cjs');
const config = require('../src/config/runtime-config');
const book = require('../src/book');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

const RUN = `lcp${Date.now().toString(36)}`;

describe('Layer Config Persistence (Кирпич №2)', () => {
    let tmpDir;
    let savedBooksDir;

    const registered = new Set();
    // every test book gets a books row (book_layer_config → books FK)
    async function register(bookId) {
        await query(`INSERT INTO books (book_id, title) VALUES ($1, 'lcp') ON CONFLICT (book_id) DO NOTHING`, [bookId]);
        registered.add(bookId);
        return bookId;
    }
    const rowOf = async (bookId) => (await query('SELECT config FROM book_layer_config WHERE book_id = $1', [bookId])).rows[0];

    before(async () => { await runMigrations(); });
    after(async () => {
        for (const b of registered) await query('DELETE FROM books WHERE book_id = $1', [b]);
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-lc-'));
        savedBooksDir = config.BOOKS_DIR;
        config.BOOKS_DIR = tmpDir;
    });

    afterEach(() => {
        config.BOOKS_DIR = savedBooksDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeBookDir(bookId, meta) {
        const bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(meta));
        return bookDir;
    }

    // ── 1. set() → durable copy in book.json ──
    it('set() persists the config into book.json', async () => {
        const bookId = await register(`${RUN}-lc-book-1`);
        writeBookDir(bookId, { structure: { chapters_order: [] } });

        await layerConfig.set(bookId, { image_enabled: false, chunk_size: 5 });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.image_enabled).to.be.false;
        expect(meta.layer_config.audio_enabled).to.be.true;
        expect(meta.layer_config.chunk_size).to.equal(5);
        expect(meta.layer_config.updated_at).to.be.a('number');
    });

    it('set() merges partial updates into the durable copy', async () => {
        const bookId = await register(`${RUN}-lc-book-2`);
        writeBookDir(bookId, { structure: { chapters_order: [] } });

        await layerConfig.set(bookId, { image_enabled: false });
        await layerConfig.set(bookId, { video_enabled: false });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'book.json'), 'utf8'));
        expect(meta.layer_config.image_enabled).to.be.false;
        expect(meta.layer_config.video_enabled).to.be.false;
        expect(meta.layer_config.audio_enabled).to.be.true;
    });

    it('set() skips persistence when the book is not on disk yet (no crash, PG row still written)', async () => {
        const bookId = await register(`${RUN}-lc-ghost`);
        const cfg = await layerConfig.set(bookId, { image_enabled: false });

        expect(cfg.image_enabled).to.be.false;
        expect((await rowOf(bookId)).config.image_enabled).to.be.false;
        // No book.json on disk, no exception — best-effort skip
        expect(fs.existsSync(path.join(tmpDir, bookId))).to.be.false;
    });

    it('set() merges against the durable book.json copy when the book has no PG row yet', async () => {
        const bookId = await register(`${RUN}-lc-set-durable-1`);
        // PG-строки ещё нет (книга до переезда в PG), копия есть: частичный PUT
        // не должен молча сбросить ранее сохранённое image_enabled=false в defaults.
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false },
        });

        const cfg = await layerConfig.set(bookId, { chunk_size: 5 });

        expect(cfg.image_enabled).to.be.false; // сохранено из durable-копии
        expect(cfg.chunk_size).to.equal(5);
        // PG получил то же самое — последующие чтения согласованы
        const stored = (await rowOf(bookId)).config;
        expect(stored.image_enabled).to.be.false;
        expect(stored.chunk_size).to.equal(5);
    });

    it('set() falls back to defaults when neither a PG row nor a durable copy exists', async () => {
        const bookId = await register(`${RUN}-lc-set-defaults-1`); // нет ни ключа, ни book.json
        const cfg = await layerConfig.set(bookId, { video_enabled: false });
        expect(cfg.audio_enabled).to.be.true;
        expect(cfg.image_enabled).to.be.true;
        expect(cfg.video_enabled).to.be.false;
    });

    // ── 2. get() seeds a missing PG row from book.json (once) ──
    it('get() seeds the PG row from a multi-file book.json copy', async () => {
        const bookId = await register(`${RUN}-lc-seed-1`);
        writeBookDir(bookId, { structure: {}, layer_config: { video_enabled: false, chunk_size: 2 } });
        const cfg = await layerConfig.get(bookId);
        expect(cfg.video_enabled).to.be.false;
        expect(cfg.chunk_size).to.equal(2);
        expect((await rowOf(bookId)).config).to.deep.equal(cfg);
    });

    it('get() seeds from the legacy single-file format (<bookId>.json) too', async () => {
        const bookId = await register(`${RUN}-lc-legacy-1`);
        fs.writeFileSync(path.join(tmpDir, `${bookId}.json`), JSON.stringify({ structure: {}, layer_config: { image_enabled: false } }));
        const cfg = await layerConfig.get(bookId);
        expect(cfg.image_enabled).to.be.false;
        expect((await rowOf(bookId)).config.image_enabled).to.be.false;
    });

    it('get() writes nothing when book.json has no layer_config or is broken', async () => {
        const a = await register(`${RUN}-lc-empty-1`);
        writeBookDir(a, { structure: { chapters_order: [] } });
        expect(await layerConfig.get(a)).to.deep.equal(layerConfig.DEFAULTS);
        expect(await rowOf(a)).to.equal(undefined);
        const b = await register(`${RUN}-lc-broken-1`);
        fs.mkdirSync(path.join(tmpDir, b), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, b, 'book.json'), '{not json');
        expect(await layerConfig.get(b)).to.deep.equal(layerConfig.DEFAULTS);
        expect(await rowOf(b)).to.equal(undefined);
    });

    it('an existing PG row wins over book.json (the copy is never re-read)', async () => {
        const bookId = await register(`${RUN}-lc-pgwins-1`);
        writeBookDir(bookId, { structure: {} });
        await layerConfig.set(bookId, { image_enabled: false });
        writeBookDir(bookId, { structure: {}, layer_config: { image_enabled: true, video_enabled: false } });
        const cfg = await layerConfig.get(bookId);
        expect(cfg.image_enabled).to.be.false;
        expect(cfg.video_enabled).to.be.true;
    });

    // ── 3. persistToBook() legacy single-file ──
    it('persistToBook() writes the legacy single-file format too', () => {
        fs.writeFileSync(path.join(tmpDir, 'lc-legacy-2.json'), JSON.stringify({ structure: {} }));

        const ok = layerConfig.persistToBook('lc-legacy-2', { image_enabled: false });
        expect(ok).to.be.true;

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lc-legacy-2.json'), 'utf8'));
        expect(meta.layer_config.image_enabled).to.be.false;
    });

    // ── 4. saveBookBundle() preserves the durable copy ──
    it('saveBookBundle() does not wipe layer_config when rewriting book.json', () => {
        const bookId = 'lc-preserve-1';
        const bookDir = writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false },
        });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ vbook_version: 4, book_id: bookId, build_id: 'b1' }));
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });

        // Editor rewrite: book object WITHOUT layer_config (e.g. cached before PUT)
        book.saveBookBundle(
            { manifest: { vbook_version: 4, book_id: bookId }, book: { structure: { chapters_order: [] } }, chapters: [] },
            null
        );

        const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.image_enabled).to.be.false;
    });

    it('saveBookBundle() re-import of an archive without layer_config preserves the durable copy', () => {
        const bookId = 'lc-reimport-1';
        const bookDir = writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { video_enabled: false },
        });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ vbook_version: 4, book_id: bookId, build_id: 'b1' }));

        // Re-import of a bundle whose book.json has NO layer_config (export
        // made before Кирпич №2). VBook 4 has no raw-files mode: the importer
        // builds the book object from the archive files and saves the object —
        // the durable copy must survive that write as well.
        const CH = 'ch-0a0a0a0a';
        const imported = book.buildBookFromBundle({
            'manifest.json': JSON.stringify({ vbook_version: 4, book_id: bookId }),
            'book.json': JSON.stringify({ structure: { chapters_order: [`${CH}.json`] } }),
            [`chapters/${CH}.json`]: JSON.stringify({ chapter_id: CH, scenes: [] }),
        });
        expect(imported.book).to.not.have.property('layer_config');
        book.saveBookBundle(imported);
        expect(() => book.saveBookBundle(imported, { 'book.json': '{}' })).to.throw(/saves the book object only/);

        const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.video_enabled).to.be.false;
    });
});
