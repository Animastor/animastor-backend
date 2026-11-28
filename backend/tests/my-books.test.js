// ======================================================
// «Мои книги» — list fields, POST /book/:id/opened, cache clear scope
// ======================================================
// 1. GET /api/v1/books entries carry vbook_version, last_opened_at,
//    has_generated_content; recently opened first.
// 2. POST /api/v1/book/:id/opened records books.last_opened_at and nothing
//    else (updated_at unchanged, no other handler runs).
// 3. Access: anonymous → 401, a stranger → 403 on /opened, on DELETE /cache
//    and on DELETE /book (production guard wiring), the list never shows a
//    stranger's book.
// 4. DELETE /book/:id/cache keeps voices/ (voice references) and the book
//    text (data/books/<id>/) — only generated artifacts go.

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerRecentBooksRoutes = require('../src/routes/book/recent-books-routes.cjs');
const { collectRecentBooks, toEpochMs } = registerRecentBooksRoutes;
const registerCacheRoutes = require('../src/routes/book/cache-routes.cjs');
const { hasBookArtifacts } = require('../src/services/book-artifacts.cjs');
const { PRESERVED_ENTRIES } = require('../src/utils/build-dir');
const { authContext, requireBookAccess, requireIdentityForWrites } = require('../src/middleware/auth-context');

function cookieOf(setCookieHeader) {
    if (!setCookieHeader) return null;
    const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return first.split(';')[0];
}

function touch(file, body = 'x') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

describe('«Мои книги»', () => {
    describe('toEpochMs', () => {
        it('normalizes ISO strings, epoch seconds and epoch ms', () => {
            expect(toEpochMs('2026-11-22T10:00:00.000Z')).to.equal(Date.parse('2026-11-22T10:00:00.000Z'));
            expect(toEpochMs(1795107927)).to.equal(1795107927000);
            expect(toEpochMs('1795107927')).to.equal(1795107927000);
            expect(toEpochMs(1795107927502)).to.equal(1795107927502);
            expect(toEpochMs(null)).to.equal(null);
            expect(toEpochMs('not a date')).to.equal(null);
            expect(toEpochMs(0)).to.equal(null);
        });
    });

    describe('collectRecentBooks — list fields and order', () => {
        const ws = '00000000-0000-4000-8000-0000000000aa';
        function deps({ owned, statuses }) {
            return {
                bookSourceRepo: { listRecent: async () => [] },
                bookRepo: {
                    listBookIdsByWorkspace: async () => owned.map(({ book_id, workspace_id }) => ({ book_id, workspace_id })),
                    lastOpenedByWorkspace: async () => new Map(owned.filter((r) => r.last_opened_at != null).map((r) => [r.book_id, r.last_opened_at])),
                },
                lazyBook: {
                    getBooksDir: () => '/nonexistent',
                    getBookStatus: (id) => {
                        const st = statuses[id];
                        if (st && st.unsupported) {
                            const e = new Error('unsupported'); e.code = 'UNSUPPORTED_VBOOK_VERSION'; e.vbookVersion = st.version; throw e;
                        }
                        return st || null;
                    },
                    getBookDir: (id) => `/books/${id}`,
                    getManifestPath: () => '/nonexistent/manifest.json',
                    getBookMetaPath: () => '/nonexistent/book.json',
                    loadDraftBook: (id) => ({ manifest: { build_id: `b_${id}` } }),
                },
                workspaceId: ws,
                limit: 100,
            };
        }

        it('orders recently opened first; never-opened books by their last update', async () => {
            const books = await collectRecentBooks({
                ...deps({
                    owned: [
                        { book_id: 'old_opened', workspace_id: ws, last_opened_at: '1795200000000' },
                        { book_id: 'new_never', workspace_id: ws, last_opened_at: null },
                        { book_id: 'fresh_opened', workspace_id: ws, last_opened_at: 1795300000000 },
                    ],
                    statuses: {
                        old_opened: { title: 'A', state: 'X', updatedAt: '2026-01-01T00:00:00Z' },
                        new_never: { title: 'B', state: 'X', updatedAt: '2026-11-20T00:00:00Z' },
                        fresh_opened: { title: 'C', state: 'X', updatedAt: '2026-01-01T00:00:00Z' },
                    },
                }),
                hasGeneratedContent: (id) => id === 'fresh_opened',
            });
            expect(books.map((b) => b.book_id)).to.deep.equal(['fresh_opened', 'old_opened', 'new_never']);
            expect(books[0]).to.include({ last_opened_at: 1795300000000, vbook_version: 4, has_generated_content: true });
            expect(books[1]).to.include({ last_opened_at: 1795200000000, has_generated_content: false });
            expect(books[2]).to.include({ last_opened_at: null, updated_at_ms: Date.parse('2026-11-20T00:00:00Z') });
            // updated_at keeps its source shape for older clients
            expect(books[2].updated_at).to.equal('2026-11-20T00:00:00Z');
        });

        it('a 3.1 book is listed with unsupported + its vbook_version', async () => {
            const books = await collectRecentBooks(deps({
                owned: [{ book_id: 'legacy', workspace_id: ws, last_opened_at: null }],
                statuses: { legacy: { unsupported: true, version: '3.1' } },
            }));
            expect(books).to.have.length(1);
            expect(books[0]).to.include({ book_id: 'legacy', unsupported: true, vbook_version: '3.1' });
            // no probe → unknown, never a guess
            expect(books[0].has_generated_content).to.equal(null);
        });

        it('a blank book (manifest with created_at only) gets updated_at_ms from created_at', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-blank-'));
            try {
                const created = '2026-11-24T14:38:10.619Z';
                fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ vbook_version: 4, book_id: 'blank', build_id: 'manual_blank', created_at: created }));
                const d = deps({
                    owned: [{ book_id: 'blank', workspace_id: ws, last_opened_at: null }],
                    statuses: { blank: { title: 'Blank', state: null, updatedAt: undefined } },
                });
                d.lazyBook.getManifestPath = () => path.join(dir, 'manifest.json');
                const books = await collectRecentBooks(d);
                expect(books).to.have.length(1);
                expect(books[0].updated_at_ms).to.equal(Date.parse(created));
                // updated_at keeps its old shape (0) — older clients parse it as before
                expect(books[0].updated_at).to.equal(0);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('hasBookArtifacts', () => {
        let out;
        let booksDir;
        beforeEach(() => {
            out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-out-'));
            booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-books-'));
            fs.mkdirSync(path.join(booksDir, 'bk_1'));
            fs.mkdirSync(path.join(booksDir, 'other_2'));
        });
        afterEach(() => {
            fs.rmSync(out, { recursive: true, force: true });
            fs.rmSync(booksDir, { recursive: true, force: true });
        });
        const probe = (buildIds) => hasBookArtifacts({
            outputDir: out, booksDir, bookId: 'bk_1', buildIds,
            buildScoped: PRESERVED_ENTRIES, preserve: PRESERVED_ENTRIES,
        });

        it('false when nothing was generated', () => {
            expect(probe(['manual_1'])).to.equal(false);
        });
        it('false when the build dir holds only voices/ (references are not generated content)', () => {
            touch(path.join(out, 'manual_1', 'voices', 'hero.wav'));
            expect(probe(['manual_1'])).to.equal(false);
        });
        it('true for an artifact of the book in its build dir', () => {
            touch(path.join(out, 'manual_1', 'bk_1_ch-1_sc-1.mp3'));
            expect(probe(['manual_1'])).to.equal(true);
        });
        it('false when a shared build dir holds only another book\'s artifacts', () => {
            touch(path.join(out, 'shared', 'other_2_ch-1_sc-1.mp3'));
            expect(probe(['shared'])).to.equal(false);
        });
    });

    describe('DELETE /book/:id/cache — scope', () => {
        let out;
        let booksDir;
        let server;
        let port;
        const bookId = 'mb_cache_book';
        const build = 'manual_mb_cache';
        const pgDeleted = [];

        before(async () => {
            out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cache-out-'));
            booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cache-books-'));
            // book text (VBook 4 layout) — must survive
            touch(path.join(booksDir, bookId, 'manifest.json'), '{"vbook_version":4}');
            touch(path.join(booksDir, bookId, 'book.json'), '{"title":"T"}');
            touch(path.join(booksDir, bookId, 'chapters', 'ch-1.json'), '{"scenes":[]}');
            // voice references — must survive
            touch(path.join(out, build, 'voices', 'narrator.wav'), 'RIFF');
            // generated artifacts — must go
            touch(path.join(out, build, `${bookId}_ch-1_sc-1.mp3`));
            touch(path.join(out, build, `${bookId}_ch-1_sc-1.png`));

            const app = express();
            registerCacheRoutes(app, {
                redis: {},
                config: { OUTPUT_DIR: out, BOOKS_DIR: booksDir },
                storage: { postgres: { query: async (sql) => { pgDeleted.push(sql.split(' ')[2]); return { rowCount: 0 }; } } },
                path, fs,
                getAllChunks: async () => [],
                getChunk: async () => null,
                cleanBookRedisKeys: async () => ({ deleted: 0 }),
                purgeAssistantForBook: async () => {},
                orchV2: { cancelBook: async () => ({ commands_cancelled: 0, jobs_cancelled: 0 }) },
                // the v4 build dir is named by manifest.build_id — no Redis chunk names it
                getBookManifest: (id) => (id === bookId ? { vbook_version: 4, build_id: build } : null),
                log: () => {},
            });
            server = app.listen(0);
            port = server.address().port;
        });
        after(() => {
            if (server) server.close();
            fs.rmSync(out, { recursive: true, force: true });
            fs.rmSync(booksDir, { recursive: true, force: true });
        });

        it('removes generated artifacts, keeps voices/ and the book text', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/book/${bookId}/cache`, { method: 'DELETE' });
            expect(res.status).to.equal(200);
            const left = fs.readdirSync(path.join(out, build)).sort();
            expect(left).to.deep.equal(['voices']);
            expect(fs.existsSync(path.join(out, build, 'voices', 'narrator.wav'))).to.equal(true);
            for (const f of ['manifest.json', 'book.json', path.join('chapters', 'ch-1.json')]) {
                expect(fs.existsSync(path.join(booksDir, bookId, f)), f).to.equal(true);
            }
            // book identity tables are never part of the cache clear
            expect(pgDeleted).to.include('scene_assets');
            for (const t of ['books', 'book_source', 'book_snapshots', 'book_events']) {
                expect(pgDeleted, t).to.not.include(t);
            }
        });
    });

    describe('DELETE /book/:id — the v2 build dir (manifest.build_id) goes too', () => {
        const { createBookDeletion } = require('../src/services/book-deletion.cjs');
        const { removeBookArtifacts } = require('../src/services/book-artifacts.cjs');
        const noRedis = { sadd: async () => 1, expire: async () => 1, del: async () => 0, get: async () => null, smembers: async () => [], scan: async () => ['0', []], keys: async () => [] };

        /** PG fake: `sharedRows` answers the shared-build check, everything else is empty. */
        const pgFake = (sharedRows = []) => ({ postgres: { query: async (sql, params) => {
            if (/SELECT DISTINCT build_id/.test(sql)) {
                return { rows: sharedRows.filter((r) => params[0].includes(r.build_id) && r.book_id !== params[1]).map((r) => ({ build_id: r.build_id })) };
            }
            return { rows: [], rowCount: 0 };
        } } });

        function deletionWith({ booksDir, outputDir, bundles, storage, removeArtifacts, order = [] }) {
            return createBookDeletion({
                book: {
                    loadBook: (id) => { order.push('load'); if (!bundles[id]) throw new Error('no bundle'); return bundles[id]; },
                    resetBook: async (id) => { order.push('reset'); fs.rmSync(path.join(booksDir, id), { recursive: true, force: true }); },
                },
                redis: noRedis,
                storage,
                config: { BOOKS_DIR: booksDir, OUTPUT_DIR: outputDir },
                getAllChunks: async () => [], // no Redis chunk names the build
                getChunk: async () => null,
                cleanBookRedisKeys: async () => {},
                log: () => {},
                agentSessionControl: { cancelSessions: async () => {} },
                purgeAssistantForBook: async () => {},
                // production wiring (backend.cjs): build-scoped voices/
                removeBookArtifacts: removeArtifacts || ((opts) => removeBookArtifacts({ ...opts, buildScoped: PRESERVED_ENTRIES })),
            });
        }

        async function runDelete(deletion, bookId) {
            const savedFetch = globalThis.fetch;
            globalThis.fetch = async () => ({ ok: true, status: 200 });
            try { await deletion.deleteBook(bookId); } finally { globalThis.fetch = savedFetch; }
        }

        let root;
        let booksDir;
        let outputDir;
        beforeEach(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-del-'));
            booksDir = path.join(root, 'books');
            outputDir = path.join(root, 'output');
            fs.mkdirSync(booksDir);
            fs.mkdirSync(outputDir);
        });
        afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

        function writeBook(id, buildId) {
            fs.mkdirSync(path.join(booksDir, id), { recursive: true });
            fs.writeFileSync(path.join(booksDir, id, 'manifest.json'), JSON.stringify({ vbook_version: 4, book_id: id, build_id: buildId }));
            return { manifest: { book_id: id, build_id: buildId }, chapters: [] };
        }
        function writeArtifact(buildId, name, data = 'x') {
            const file = path.join(outputDir, buildId, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, data);
            return file;
        }

        it('passes the bundle build id to the artifact removal, read before the bundle is reset', async () => {
            const order = [];
            let removed = null;
            const bundles = { mb_del_book: writeBook('mb_del_book', 'manual_42') };
            const deletion = deletionWith({
                booksDir, outputDir, bundles, storage: pgFake(), order,
                removeArtifacts: (opts) => { removed = { buildIds: [...opts.buildIds], shared: [...opts.sharedBuildIds] }; },
            });
            await runDelete(deletion, 'mb_del_book');
            expect(removed.buildIds).to.deep.equal(['manual_42']);
            expect(removed.shared).to.deep.equal([]);
            expect(order.indexOf('load')).to.be.lessThan(order.indexOf('reset'));
        });

        it('one book, no Redis chunks: its build dir (voices/ included) is removed', async () => {
            const A = 'mb_solo_a';
            const bundles = { [A]: writeBook(A, 'manual_solo') };
            writeArtifact('manual_solo', `${A}_ch-1_sc-1.mp3`);
            writeArtifact('manual_solo', 'voices/narrator.wav');
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake() }), A);
            expect(fs.existsSync(path.join(outputDir, 'manual_solo'))).to.equal(false);
        });

        it('two books with one build id (manifests): deleting one keeps the other book\'s dir, voices/ and files', async () => {
            const A = 'mb_twin_a';
            const B = 'mb_twin_b';
            const bundles = { [A]: writeBook(A, 'manual_twin'), [B]: writeBook(B, 'manual_twin') };
            const mine = writeArtifact('manual_twin', `${A}_ch-1_sc-1.mp3`);
            const voice = writeArtifact('manual_twin', 'voices/narrator.wav'); // B has only its voice reference here
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake() }), A);
            expect(fs.existsSync(path.join(outputDir, 'manual_twin'))).to.equal(true);
            expect(fs.existsSync(voice)).to.equal(true);
            expect(fs.existsSync(mine)).to.equal(false); // A's own entry still goes

            // B with generated files of its own in the shared dir: they stay too.
            const theirs = writeArtifact('manual_twin', `${B}_ch-1_sc-1.mp3`);
            bundles[A] = writeBook(A, 'manual_twin');
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake() }), A);
            expect(fs.existsSync(theirs)).to.equal(true);
            expect(fs.existsSync(voice)).to.equal(true);
        });

        it('a build id another book names only in PG is shared too (dir and voices/ stay)', async () => {
            const A = 'mb_pg_a';
            const bundles = { [A]: writeBook(A, 'manual_pg') };
            const mine = writeArtifact('manual_pg', `${A}_ch-1_sc-1.mp3`);
            const voice = writeArtifact('manual_pg', 'voices/narrator.wav');
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake([{ build_id: 'manual_pg', book_id: 'mb_pg_other' }]) }), A);
            expect(fs.existsSync(voice)).to.equal(true);
            expect(fs.existsSync(mine)).to.equal(false);
        });

        it('a book with build id "default": the shared default dir and voices/ stay, the book\'s files go', async () => {
            const A = 'mb_dflt_a';
            const bundles = { [A]: writeBook(A, 'default') };
            const mine = writeArtifact('default', `${A}_ch-1_sc-1.mp3`);
            const voice = writeArtifact('default', 'voices/narrator.wav');
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake() }), A);
            expect(fs.existsSync(path.join(outputDir, 'default'))).to.equal(true);
            expect(fs.existsSync(voice)).to.equal(true);
            expect(fs.existsSync(mine)).to.equal(false);
        });

        it('a book without a build id in its manifest: its files in default/ go, default/ and voices/ stay', async () => {
            const A = 'mb_nobid_a';
            fs.mkdirSync(path.join(booksDir, A), { recursive: true });
            fs.writeFileSync(path.join(booksDir, A, 'manifest.json'), JSON.stringify({ vbook_version: 4, book_id: A }));
            const bundles = { [A]: { manifest: { book_id: A }, chapters: [] } };
            const mine = writeArtifact('default', `${A}_ch-1_sc-1.mp3`);
            const voice = writeArtifact('default', 'voices/narrator.wav');
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage: pgFake() }), A);
            expect(fs.existsSync(voice)).to.equal(true);
            expect(fs.existsSync(mine)).to.equal(false);
        });

        it('a failed PG check keeps the build dir (never removed blindly)', async () => {
            const A = 'mb_pgerr_a';
            const bundles = { [A]: writeBook(A, 'manual_pgerr') };
            const voice = writeArtifact('manual_pgerr', 'voices/narrator.wav');
            writeArtifact('manual_pgerr', `${A}_ch-1_sc-1.mp3`);
            const storage = { postgres: { query: async (sql) => { if (/SELECT DISTINCT build_id/.test(sql)) throw new Error('pg down'); return { rows: [], rowCount: 0 }; } } };
            await runDelete(deletionWith({ booksDir, outputDir, bundles, storage }), A);
            expect(fs.existsSync(voice)).to.equal(true);
        });
    });

    describe('HTTP: /books, /opened, access', () => {
        const stamp = Date.now();
        const password = 'correct-horse-42';
        let server;
        let port;
        let alice;
        let bob;
        const aliceBook = `mb-alice-${stamp}`;
        const aliceBook2 = `mb-alice2-${stamp}`;
        const bobBook = `mb-bob-${stamp}`;
        const calls = { cache: 0, del: 0 };
        let tmpDir;

        async function register(username) {
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const body = await res.json();
            return { id: body.user.id, ws: body.workspace.id, cookie: cookieOf(res.headers.get('set-cookie')) };
        }
        const req = (method, p, cookie) => fetch(`http://127.0.0.1:${port}${p}`, {
            method, headers: cookie ? { Cookie: cookie } : {},
        });

        before(async () => {
            await runMigrations();
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-http-'));
            const onDisk = [aliceBook, aliceBook2, bobBook];
            const app = express();
            app.use(express.json());
            app.use(authContext);
            app.use(requireIdentityForWrites);
            registerAuthRoutes(app, null, { utils: { log: () => {} } });
            // production wiring (backend.cjs): every /api/v1/book/:bookId route behind the ownership guard
            app.use('/api/v1/book/:bookId', requireBookAccess('bookId'));
            app.delete('/api/v1/book/:bookId/cache', (q, r) => { calls.cache++; r.json({ cleared: true }); });
            app.delete('/api/v1/book/:bookId', (q, r) => { calls.del++; r.json({ deleted: true }); });
            registerRecentBooksRoutes(app, null, {
                bookSourceRepo: { listRecent: async () => [] },
                lazyBook: {
                    getBooksDir: () => tmpDir,
                    getBookStatus: (id) => (onDisk.includes(id)
                        ? { bookId: id, state: 'READY', title: `T ${id}`, parsedChapters: 1, parsedScenes: 1, updatedAt: '2026-11-01T00:00:00Z' }
                        : null),
                    loadDraftBook: (id) => ({ manifest: { build_id: `b_${id}` } }),
                },
                utils: { log: () => {} },
            });
            server = app.listen(0);
            port = server.address().port;

            alice = await register(`mb_alice_${stamp}`);
            bob = await register(`mb_bob_${stamp}`);
            await query(`INSERT INTO books (book_id, workspace_id, title, updated_at) VALUES ($1, $2, 'A1', 1000)`, [aliceBook, alice.ws]);
            await query(`INSERT INTO books (book_id, workspace_id, title, updated_at) VALUES ($1, $2, 'A2', 1000)`, [aliceBook2, alice.ws]);
            await query(`INSERT INTO books (book_id, workspace_id, title, updated_at) VALUES ($1, $2, 'B1', 1000)`, [bobBook, bob.ws]);
        });

        after(async () => {
            if (server) server.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
            for (const id of [aliceBook, aliceBook2, bobBook]) await query(`DELETE FROM books WHERE book_id = $1`, [id]);
            for (const u of [alice, bob].filter(Boolean)) {
                await query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [u.ws]);
                await query(`DELETE FROM workspaces WHERE id = $1`, [u.ws]);
                await query(`DELETE FROM users WHERE user_id = $1`, [u.id]);
            }
        });

        it('POST /opened: the owner → 200, last_opened_at set, updated_at untouched', async () => {
            const res = await req('POST', `/api/v1/book/${aliceBook2}/opened`, alice.cookie);
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.book_id).to.equal(aliceBook2);
            expect(body.last_opened_at).to.be.a('number');
            const row = (await query(`SELECT last_opened_at, updated_at FROM books WHERE book_id = $1`, [aliceBook2])).rows[0];
            expect(Number(row.last_opened_at)).to.equal(body.last_opened_at);
            expect(Number(row.updated_at)).to.equal(1000);
        });

        it('GET /books: the opened book first, list fields present, only own books', async () => {
            const res = await req('GET', '/api/v1/books?limit=200', alice.cookie);
            expect(res.status).to.equal(200);
            const { books } = await res.json();
            expect(books.map((b) => b.book_id)).to.deep.equal([aliceBook2, aliceBook]);
            expect(books[0].last_opened_at).to.be.a('number');
            expect(books[1].last_opened_at).to.equal(null);
            for (const b of books) {
                expect(b).to.have.property('vbook_version', 4);
                expect(b).to.have.property('has_generated_content');
            }
            expect(books.map((b) => b.book_id)).to.not.include(bobBook);
        });

        it('POST /opened on a stranger\'s book → 403, no row changed', async () => {
            const res = await req('POST', `/api/v1/book/${bobBook}/opened`, alice.cookie);
            expect(res.status).to.equal(403);
            const row = (await query(`SELECT last_opened_at FROM books WHERE book_id = $1`, [bobBook])).rows[0];
            expect(row.last_opened_at).to.equal(null);
        });

        it('POST /opened anonymous → 401', async () => {
            const res = await req('POST', `/api/v1/book/${aliceBook}/opened`, null);
            expect(res.status).to.equal(401);
        });

        it('POST /opened on an unknown book → 403 (nothing to learn about it)', async () => {
            const res = await req('POST', `/api/v1/book/mb-nobody-${stamp}/opened`, alice.cookie);
            expect(res.status).to.equal(403);
        });

        it('DELETE /cache and DELETE /book on a stranger\'s book → 403; anonymous → 401; handlers never run', async () => {
            expect((await req('DELETE', `/api/v1/book/${bobBook}/cache`, alice.cookie)).status).to.equal(403);
            expect((await req('DELETE', `/api/v1/book/${bobBook}`, alice.cookie)).status).to.equal(403);
            expect((await req('DELETE', `/api/v1/book/${aliceBook}/cache`, null)).status).to.equal(401);
            expect((await req('DELETE', `/api/v1/book/${aliceBook}`, null)).status).to.equal(401);
            expect(calls).to.deep.equal({ cache: 0, del: 0 });
        });

        it('DELETE /cache and DELETE /book on an own book reach the handlers', async () => {
            expect((await req('DELETE', `/api/v1/book/${aliceBook}/cache`, alice.cookie)).status).to.equal(200);
            expect((await req('DELETE', `/api/v1/book/${aliceBook}`, alice.cookie)).status).to.equal(200);
            expect(calls).to.deep.equal({ cache: 1, del: 1 });
        });

        it('GET /books anonymous → no books (no identity, no workspace)', async () => {
            const res = await req('GET', '/api/v1/books', null);
            expect(res.status).to.equal(200);
            expect((await res.json()).books).to.deep.equal([]);
        });
    });
});
