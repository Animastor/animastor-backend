// ======================================================
// Bootstrap idempotency — per-book lock, 409, no-op (2026-11-26)
// ======================================================
// ba_1795695606197: two parallel POST /bootstrap → two runs → two chapter-0
// files. Covered here:
//   (а) two concurrent POST /bootstrap → one run, the second gets 409
//       bootstrap_in_progress (+ session_id); next-window / resume share the lock;
//   (б) a repeated bootstrap of a finished book → no-op 200, same chapter files;
//   (г) the deterministic detector on the book's source → one prologue
//       (the real copy via ANIMASTOR_BA_SOURCE_TXT; the user's text is not
//       committed — the suite skips that case without it);
//   (д) chunk / placeholder names carry chapter_id, never "undefined".
// (в) — two createFromAnalysis on one book → one chapter-0 file — lives in the
// package suite (packages/animastor-vbook-runtime/test/bootstrap-idempotency.test.js).
// Redis: the TEST instance (REDIS_PORT of .env.test), real SET NX / Lua.
// Docs: animastor-docs architecture/BOOTSTRAP_IDEMPOTENCY.md.

'use strict';

const _booksDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'animastor-bootstrap-idem-'));
require('./vbook-test-bindings.cjs');
const config = require('../src/config/runtime-config');

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const bootstrapLock = require('../src/services/bootstrap-lock');
const registerImportRoutes = require('../src/routes/book/import-routes.cjs');

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

describe('bootstrap idempotency (per-book lock, 409, no-op)', function () {
    this.timeout(20000);
    let redis;
    const prevBooksDir = config.BOOKS_DIR;
    const bookKeys = new Set();
    const uniq = (tag) => {
        const id = `ba_idem_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        bookKeys.add(bootstrapLock.lockKey(id));
        return id;
    };

    before(async () => {
        redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT || 6379),
            db: Number(process.env.REDIS_DB || 0),
            lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 4000,
        });
        await redis.connect();
    });
    after(async () => {
        config.BOOKS_DIR = prevBooksDir;
        try { if (bookKeys.size) await redis.del(...bookKeys); } finally { redis.disconnect(); }
        fs.rmSync(_booksDir, { recursive: true, force: true });
    });

    // ── the lock itself ──────────────────────────────────────────────────
    describe('bootstrap-lock', () => {
        it('SET NX EX 900: the second acquire is refused while the first holds it', async () => {
            const id = uniq('nx');
            const a = await bootstrapLock.acquire(redis, id);
            expect(a).to.be.an('object');
            const ttl = await redis.ttl(bootstrapLock.lockKey(id));
            expect(ttl).to.be.within(890, 900);
            expect(await bootstrapLock.acquire(redis, id)).to.equal(null);
            await a.release();
            expect(await redis.exists(bootstrapLock.lockKey(id))).to.equal(0);
            const b = await bootstrapLock.acquire(redis, id);
            expect(b).to.be.an('object');
            await b.release();
        });

        it('release deletes only its own token (compare-and-del)', async () => {
            const id = uniq('owner');
            const a = await bootstrapLock.acquire(redis, id, { ttlSec: 60 });
            // a's lock expired and someone else took it
            await redis.set(bootstrapLock.lockKey(id), 'someone-else', 'EX', 60);
            await a.release();
            expect(await redis.get(bootstrapLock.lockKey(id))).to.equal('someone-else');
            await redis.del(bootstrapLock.lockKey(id));
        });

        it('heartbeat extends the TTL while the run is alive (window longer than the TTL)', async () => {
            const id = uniq('hb');
            const a = await bootstrapLock.acquire(redis, id, { ttlSec: 2, heartbeatMs: 400 });
            await new Promise((r) => setTimeout(r, 3000));
            expect(await redis.get(bootstrapLock.lockKey(id))).to.equal(a.token);
            expect(a.isLost()).to.equal(false);
            await a.release();
            expect(await redis.exists(bootstrapLock.lockKey(id))).to.equal(0);
        });

        it('withBootstrapLock releases in finally on error; busy → BootstrapInProgressError', async () => {
            const id = uniq('with');
            let err = null;
            try { await bootstrapLock.withBootstrapLock(redis, id, async () => { throw new Error('boom'); }); } catch (e) { err = e; }
            expect(err.message).to.equal('boom');
            expect(await redis.exists(bootstrapLock.lockKey(id))).to.equal(0);

            const held = await bootstrapLock.acquire(redis, id);
            err = null;
            try { await bootstrapLock.withBootstrapLock(redis, id, async () => 'ran'); } catch (e) { err = e; }
            expect(err).to.be.instanceOf(bootstrapLock.BootstrapInProgressError);
            expect(err.code).to.equal('bootstrap_in_progress');
            await held.release();
        });

        it('no redis → fail-closed (no unlocked run)', async () => {
            let err = null;
            try { await bootstrapLock.withBootstrapLock(null, 'ba_x', async () => 'ran'); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.match(/redis client required/);
        });
    });

    // ── txt-importer: every entry point takes the lock ───────────────────
    describe('txt-importer entry points', () => {
        const txtImporter = require('../src/services/txt-importer');
        const lazyBook = require('../src/book/lazy-book');

        it('bootstrapImportedText / bootstrapNextWindow refuse while the book is locked', async () => {
            config.BOOKS_DIR = _booksDir;
            const { bookId } = lazyBook.createDraftBook('Пролог.\n\nТекст.\n', lazyBook.SourceType.TXT, 'BA.txt');
            bookKeys.add(bootstrapLock.lockKey(bookId));
            const held = await bootstrapLock.acquire(redis, bookId);
            try {
                for (const fn of ['bootstrapImportedText', 'bootstrapNextWindow']) {
                    let err = null;
                    try { await txtImporter[fn](bookId, null, null, redis); } catch (e) { err = e; }
                    expect(err, fn).to.be.an('error');
                    expect(err.code, fn).to.equal('bootstrap_in_progress');
                }
            } finally { await held.release(); }
        });
    });

    // ── HTTP routes ──────────────────────────────────────────────────────
    function buildApp(over) {
        const calls = { run: 0, chunks: [], placeholders: [], firstWindow: [] };
        const deps = {
            utils: { log: () => {} },
            config: { BOOK_SCENE_TOTAL: (b) => `test:scene-total:${b}`, BOOK_SCENE_NEXT: (b) => `test:scene-next:${b}` },
            state: {}, audio: null, image: null, video: null,
            book: { loadBook: () => null },
            orchestrator: null, storage: { postgres: { query: async () => ({ rows: [] }) } },
            txtImporter: over.txtImporter,
            lazyBook: over.lazyBook,
            genSessionRepo: { markFirstWindowCompleted: async (...a) => { calls.firstWindow.push(a); } },
            bookSourceRepo: {},
            placeholderAudio: { ensureAllPlaceholderAudio: async (_b, _book, scenes) => { calls.placeholders.push(...scenes); return { created: scenes.length, skipped: 0 }; } },
            layerConfig: null, genScope: null, activeScenes: null,
            saveChunk: async (id, data) => { calls.chunks.push({ id, data }); },
            getChunk: null, getAllChunks: async () => [],
            getBookWindowStatus: null, detectAvailableMode: null,
            recoverChunksFromDisk: async () => [], recoverAllBooksFromDisk: async () => {},
            cleanupService: null, bookDiff: null, taskHandler: null,
            windowGenerator: null, iuRepo: null, cleanBookRedisKeys: null,
            agentSession: { getActiveSessionForBook: async () => ({ session_id: 'sess-A' }) },
        };
        const app = express();
        app.use(express.json());
        registerImportRoutes(app, redis, deps);
        return { app, calls };
    }
    async function listen(app) {
        const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        return { server, base: `http://127.0.0.1:${server.address().port}` };
    }
    const post = (base, p) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(async (r) => ({ status: r.status, body: await r.json() }));

    it('(а)+(д) two concurrent POST /bootstrap → one run, second 409 bootstrap_in_progress; chapter_id in the answer and chunk names', async () => {
        const bookId = uniq('par');
        const gate = deferred();
        const started = deferred();
        let runs = 0;
        const txtImporter = {
            bootstrapImportedTextUnderLock: async () => {
                runs++;
                started.resolve();
                await gate.promise;
                return {
                    bookId, title: 'BA', author: null, language: 'ru', state: 'bootstrapped',
                    characters: 1, locations: 0, scenes: 2, session_id: 'sess-A',
                    window_source_range: { start: 56, end: 788 },
                    chapter: { chapter_id: 'ch-0000abcd', chapter_title: 'Пролог', chapter_index: 0, status: 'parsed',
                        scenes: [{ scene_id: 'sc-1', type: 'chapter_intro' }, { scene_id: 'sc-2', type: 'narration' }] },
                };
            },
            bootstrapNextWindow: async () => { throw new bootstrapLock.BootstrapInProgressError(bookId); },
            bootstrapImportedText: async () => { throw new bootstrapLock.BootstrapInProgressError(bookId); },
        };
        const lazyBook = {
            loadDraftBook: () => ({ sourceText: 'x', manifest: { state: 'RAW_IMPORTED', build_id: 'b1' }, chapters: [] }),
            BookState: { BOOTSTRAPPED: 'bootstrapped', ACTIVE: 'active' },
        };
        const { app, calls } = buildApp({ txtImporter, lazyBook });
        const { server, base } = await listen(app);
        try {
            const first = post(base, `/api/v1/book/${bookId}/bootstrap`);
            await started.promise;
            const second = await post(base, `/api/v1/book/${bookId}/bootstrap`);
            expect(second.status).to.equal(409);
            expect(second.body).to.include({ error: 'bootstrap_in_progress', session_id: 'sess-A' });

            const next = await post(base, `/api/v1/book/${bookId}/bootstrap-next-window`);
            expect(next.status).to.equal(409);
            expect(next.body.error).to.equal('bootstrap_in_progress');

            gate.resolve();
            const r1 = await first;
            expect(r1.status).to.equal(200);
            expect(runs).to.equal(1);
            expect(r1.body.already_bootstrapped).to.equal(false);
            expect(r1.body.chapters[0]).to.include({ chapter: 'ch-0000abcd', chapter_id: 'ch-0000abcd' });

            // (д) chunk ids, chunk records and placeholders carry the chapter_id
            expect(calls.chunks).to.have.length(2);
            for (const c of calls.chunks) {
                expect(c.id).to.not.include('undefined');
                expect(c.id).to.include('_ch-0000abcd_');
                expect(c.data.chapter_id).to.equal('ch-0000abcd');
            }
            expect(calls.placeholders.map((p) => p.chapter_id)).to.deep.equal(['ch-0000abcd', 'ch-0000abcd']);
            // window 0 row gets its source range
            expect(calls.firstWindow[0][2]).to.deep.equal({ start: 56, end: 788 });
            // the lock is released after the run
            expect(await redis.exists(bootstrapLock.lockKey(bookId))).to.equal(0);
        } finally {
            server.close();
            await redis.del(`test:scene-total:${bookId}`, `test:scene-next:${bookId}`);
        }
    });

    it('(б) repeated POST /bootstrap of a finished book → 200 no-op, same chapter files, no run', async () => {
        config.BOOKS_DIR = _booksDir;
        const lazyBook = require('../src/book/lazy-book');
        const txtImporter = require('../src/services/txt-importer');
        const { bookId } = lazyBook.createDraftBook('Пролог. Мир\n\nЮра вошёл.\n\nГлава 1. Земля\n\nАнна.\n', lazyBook.SourceType.TXT, 'BA.txt');
        bookKeys.add(bootstrapLock.lockKey(bookId));
        // the finished first window (what a completed run left on disk)
        lazyBook.createFromAnalysis(bookId, {
            structure: { title: 'BA', chapters: [{ type: 'prologue', label: 'Пролог', title: 'Мир' }, { type: 'chapter', number: 1, title: 'Земля' }] },
            characters: [], locations: [],
            scenes: [{ title: 'Комната', text: 'Юра вошёл.', source_start: 12, source_end: 22, units: [{ type: 'perception', text: 'Юра вошёл.' }] }],
        });
        const chDir = path.join(_booksDir, bookId, 'chapters');
        const filesBefore = fs.readdirSync(chDir).sort();
        const orderBefore = JSON.parse(fs.readFileSync(path.join(_booksDir, bookId, 'book.json'), 'utf8')).structure.chapters_order;

        const { app, calls } = buildApp({ txtImporter, lazyBook });
        const { server, base } = await listen(app);
        try {
            for (let i = 0; i < 2; i++) {
                const r = await post(base, `/api/v1/book/${bookId}/bootstrap`);
                expect(r.status).to.equal(200);
                expect(r.body.already_bootstrapped).to.equal(true);
                expect(r.body.state).to.equal(lazyBook.BookState.BOOTSTRAPPED);
                expect(r.body.chapters).to.have.length(1);
                expect(r.body.chapters[0].chapter_index).to.equal(0);
                expect(r.body.chapters[0].chapter).to.equal(r.body.chapters[0].chapter_id);
            }
            expect(fs.readdirSync(chDir).sort()).to.deep.equal(filesBefore);
            const orderAfter = JSON.parse(fs.readFileSync(path.join(_booksDir, bookId, 'book.json'), 'utf8')).structure.chapters_order;
            expect(orderAfter).to.deep.equal(orderBefore);
            expect(calls.chunks).to.deep.equal([]);
            expect(calls.firstWindow).to.deep.equal([]);
            expect(await redis.exists(bootstrapLock.lockKey(bookId))).to.equal(0);
        } finally { server.close(); }
    });

    // ── (г) detector regression on the book's own source ─────────────────
    describe('(г) structure detector on ba_1795695606197 source.txt', () => {
        const SRC = process.env.ANIMASTOR_BA_SOURCE_TXT;
        const run = (SRC && fs.existsSync(SRC)) ? it : it.skip;
        run('one prologue segment, 4 segments (prologue + 3 chapters)', () => {
            const sd = require('@animastor/ai-analysis/tasks/structure-detector-deterministic');
            const text = fs.readFileSync(SRC, 'utf8');
            const map = sd.buildDeterministicMap(text);
            const segs = map.segments || map.chapters || [];
            expect(segs.filter((s) => s.type === 'prologue')).to.have.length(1);
            expect(segs.map((s) => s.type)).to.deep.equal(['prologue', 'chapter', 'chapter', 'chapter']);
        });
    });
});
