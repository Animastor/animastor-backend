// ======================================================
// Book input guard — route-level refusal tests
// ======================================================
// Import / download / book-scoped routes with invalid ids or archives are
// refused with 4xx and the disk stays unchanged; anonymous callers get 401
// and no guest identity is created for import; MiM.vbook still imports.

'use strict';

require('./vbook-test-bindings.cjs');
const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const config = require('../src/config/runtime-config');
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
const book = require('@animastor/vbook-runtime');
const { query } = require('../src/storage/postgres/database');
const postgres = require('../src/storage/postgres');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerImportRoutes = require('../src/routes/book/import-routes.cjs');
const registerExportRoutes = require('../src/routes/book/export-routes.cjs');
const registerRecentBooksRoutes = require('../src/routes/book/recent-books-routes.cjs');
const { authContext, requireBookAccess, requireAdmin } = require('../src/middleware/auth-context');
const inputGuard = require('../src/middleware/input-guard');

// ── raw zip writer (entry names verbatim) ──────────────────────────────
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function rawZip(entries) {
    const locals = []; const centrals = []; let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = Buffer.from(e.data || '', 'utf8');
        const crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, data);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(((e.mode || 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += lh.length + name.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
const CH = 'ch-2a7fee78';
function bundle({ bookId = 'guard_book_1', buildId = 'build_guard_book_1', extra = [] } = {}) {
    return rawZip([
        { name: 'manifest.json', data: JSON.stringify({ vbook_version: '3.1', book_id: bookId, build_id: buildId }) },
        { name: 'book.json', data: JSON.stringify({ book_id: bookId, structure: { chapters_order: [`${CH}.json`] } }) },
        { name: `chapters/${CH}.json`, data: JSON.stringify({ chapter_id: CH, scenes: [] }) },
        ...extra,
    ]);
}

function tree(root) {
    const out = [];
    (function walk(d, rel) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            out.push(r);
            if (e.isDirectory()) walk(path.join(d, e.name), r);
        }
    })(root, '');
    return out.sort().join('\n');
}

describe('Book input guard (routes)', function () {
    this.timeout(30000);
    const stamp = Date.now();
    const uname = `guard_${stamp}`;
    let sandbox, booksDir, outputDir, server, port, userCookie;
    let savedBooks, savedOutput;
    const createdGuestCookies = [];

    async function req(method, route, { cookie, body, file } = {}) {
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        let payload;
        if (file) {
            const fd = new FormData();
            fd.append('file', new Blob([file]), 'x.vbook');
            payload = fd;
        } else if (body) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body: payload, redirect: 'manual' });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie && !cookie) createdGuestCookies.push(setCookie.split(';')[0]);
        let json = null; try { json = await res.json(); } catch (_) { /* binary */ }
        return { status: res.status, body: json, setCookie };
    }

    before(async () => {
        await postgres.initialize();
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'book-guard-'));
        booksDir = path.join(sandbox, 'data', 'books');
        outputDir = path.join(sandbox, 'data', 'output');
        fs.mkdirSync(booksDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        fs.mkdirSync(path.join(sandbox, 'data', 'sibling'));
        fs.writeFileSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), 'keep');
        savedBooks = config.BOOKS_DIR; savedOutput = config.OUTPUT_DIR;
        config.BOOKS_DIR = booksDir; config.OUTPUT_DIR = outputDir;
        configureBooksRoot(() => config.BOOKS_DIR);

        const lazyBook = require('../src/book/lazy-book');
        const deps = {
            utils: { log: () => {} }, config, state: {}, audio: null, image: null, video: null,
            book, orchestrator: null, storage: { postgres: { query } },
            txtImporter: { decodeTxtBuffer: (b) => ({ text: b.toString('utf8'), warnings: [], error: null }) },
            lazyBook,
            genSessionRepo: { markFirstWindowCompleted: async () => {} },
            bookSourceRepo: require('../src/storage/postgres/repositories/book-source-repo'),
            placeholderAudio: { ensureAllPlaceholderAudio: async () => ({ created: 0, skipped: 0 }) },
            layerConfig: null, genScope: null, activeScenes: null,
            saveChunk: async () => {}, getChunk: null, getAllChunks: async () => [],
            getBookWindowStatus: null, detectAvailableMode: null,
            recoverChunksFromDisk: async () => [], recoverAllBooksFromDisk: async () => {},
            cleanupService: null, bookDiff: null, taskHandler: null, windowGenerator: null,
            iuRepo: null, cleanBookRedisKeys: null,
        };
        const app = express();
        app.use(express.json());
        app.use(authContext);
        inputGuard.registerParamGuards(app);
        app.use('/api/v1', inputGuard.requestIdsGuard);
        registerAuthRoutes(app, null, { utils: { log: () => {} } });
        const guard = requireBookAccess('bookId');
        app.use('/api/v1/book/:bookId', inputGuard.bookIdPathGuard, (r, s, n) => (
            inputGuard.CREATE_BOOK_SUBPATHS.has(r.params.bookId) ? n() : guard(r, s, n)));
        app.use('/api/v1/scene/:bookId', inputGuard.bookIdPathGuard, requireBookAccess('bookId'));
        app.use('/api/v1/debug', requireAdmin);
        app.get('/api/v1/debug/ping', (r, s) => s.json({ ok: true }));
        registerImportRoutes(app, { get: async () => null, set: async () => {}, del: async () => {} }, deps);
        registerExportRoutes(app, null, { config, book, audio: null, utils: { log: () => {} } });
        registerRecentBooksRoutes(app, null, { bookSourceRepo: deps.bookSourceRepo, lazyBook, utils: { log: () => {} } });
        app.get('/api/v1/scene/:bookId/x', (r, s) => s.json({ ok: true }));
        app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/t', (r, s) => s.json({ ok: true }));
        await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
        port = server.address().port;

        const reg = await req('POST', '/api/v1/auth/register', { body: { username: uname, password: 'guard-pass-42', email: `${uname}@example.test` } });
        expect(reg.status, JSON.stringify(reg.body)).to.be.oneOf([200, 201]);
        userCookie = reg.setCookie.split(',').map((c) => c.trim().split(';')[0]).find((c) => c.startsWith('animastor_session=')) || reg.setCookie.split(';')[0];
        createdGuestCookies.length = 0; // the register response is the user session
    });

    after(async () => {
        if (server) server.close();
        const user = (await query('SELECT user_id FROM users WHERE username = $1', [uname])).rows[0];
        await query(`DELETE FROM books WHERE book_id IN ('guard_book_1','master_margarita_demo')`).catch(() => {});
        if (user) {
            await query('DELETE FROM sessions WHERE user_id = $1', [user.user_id]).catch(() => {});
            await query('DELETE FROM workspace_members WHERE user_id = $1', [user.user_id]).catch(() => {});
            await query('DELETE FROM workspaces WHERE owner_user_id = $1', [user.user_id]).catch(() => {});
            await query('DELETE FROM users WHERE user_id = $1', [user.user_id]).catch(() => {});
        }
        config.BOOKS_DIR = savedBooks; config.OUTPUT_DIR = savedOutput;
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    describe('anonymous callers', () => {
        for (const route of ['/api/v1/book/import', '/api/v1/book/load-vbook']) {
            it(`${route}: 401 and no guest identity minted`, async () => {
                const before = tree(sandbox);
                const r = await req('POST', route, { file: bundle() });
                expect(r.status).to.equal(401);
                expect(r.setCookie || '').to.not.match(/animastor_gid=/);
                expect(tree(sandbox)).to.equal(before);
            });
        }
        it('book-scoped GET without identity → 401', async () => {
            const r = await req('GET', '/api/v1/scene/master_margarita_demo/x');
            expect(r.status).to.equal(401);
        });
        it('book list without identity is empty', async () => {
            const r = await req('GET', '/api/v1/books');
            expect(r.status).to.equal(200);
            expect(r.body.books).to.deep.equal([]);
        });
        it('debug surface requires an admin', async () => {
            expect((await req('GET', '/api/v1/debug/ping')).status).to.equal(401);
            expect((await req('GET', '/api/v1/debug/ping', { cookie: userCookie })).status).to.equal(403);
        });
    });

    describe('signed-in import refusals (disk unchanged)', () => {
        const badIds = ['..', '../sibling', '../../x', 'a/b', '/abs', 'a\\b', 'x.y'];
        for (const route of ['/api/v1/book/import', '/api/v1/book/load-vbook']) {
            for (const id of badIds) {
                it(`${route}: book_id ${JSON.stringify(id)} → 400`, async () => {
                    const before = tree(sandbox);
                    const r = await req('POST', route, { cookie: userCookie, file: bundle({ bookId: id }) });
                    expect(r.status).to.equal(400);
                    expect(tree(sandbox)).to.equal(before);
                });
            }
            const evil = {
                'entry with ".."': { name: '../../outside.txt', data: 'E' },
                'absolute entry': { name: '/tmp/book-guard-abs.txt', data: 'E' },
                'backslash entry': { name: '..\\..\\outside.txt', data: 'E' },
                'link entry': { name: 'bible.json', data: '../../sibling/keep.txt', mode: 0o120777 },
            };
            for (const [label, e] of Object.entries(evil)) {
                it(`${route}: ${label} → 400`, async () => {
                    const before = tree(sandbox);
                    const r = await req('POST', route, { cookie: userCookie, file: bundle({ extra: [e] }) });
                    expect(r.status).to.equal(400);
                    expect(tree(sandbox)).to.equal(before);
                    expect(fs.existsSync('/tmp/book-guard-abs.txt')).to.equal(false);
                });
            }
            it(`${route}: build_id outside the grammar → 400`, async () => {
                const before = tree(sandbox);
                const r = await req('POST', route, { cookie: userCookie, file: bundle({ buildId: '../../x' }) });
                expect(r.status).to.equal(400);
                expect(tree(sandbox)).to.equal(before);
            });
        }
        it('/api/v1/book/import: a zip that is not a book → 400 (not imported as text)', async () => {
            const before = tree(sandbox);
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: rawZip([{ name: 'a.txt', data: 'x' }]) });
            expect(r.status).to.equal(400);
            expect(tree(sandbox)).to.equal(before);
        });
    });

    describe('ids in URL / query / body', () => {
        it('download with an encoded ".." segment sent verbatim → 400', async () => {
            const http = require('http');
            const status = await new Promise((resolve, reject) => {
                const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/v1/book/%2E%2E/download', headers: { Cookie: userCookie } }, (res) => { res.resume(); resolve(res.statusCode); });
                r.on('error', reject); r.end();
            });
            expect(status).to.equal(400);
        });
        for (const raw of ['..%2F..%2Fetc', '..%2Fsibling', 'a%5Cb', 'x.y']) {
            it(`download /book/${raw} → 400`, async () => {
                const r = await req('GET', `/api/v1/book/${raw}/download`, { cookie: userCookie });
                expect(r.status).to.equal(400);
            });
        }
        it('query build_id outside the grammar → 400', async () => {
            const r = await req('GET', '/api/v1/books?build_id=..%2F..%2Fx', { cookie: userCookie });
            expect(r.status).to.equal(400);
        });
        it('JSON body chapter_id / scene_id outside the grammar → 400', async () => {
            for (const body of [{ chapter_id: '../x' }, { scene_id: 'a/b' }, { unit_id: '..' }]) {
                const r = await req('POST', '/api/v1/books', { cookie: userCookie, body });
                expect(r.status, JSON.stringify(body)).to.equal(400);
            }
        });
        it('JSON body book_id outside the grammar → 400', async () => {
            const r = await req('POST', '/api/v1/books', { cookie: userCookie, body: { book_id: '../sibling' } });
            expect(r.status).to.equal(400);
        });
    });

    describe('valid use', () => {
        it('MiM.vbook imports for a signed-in user, then downloads; anonymous download → 401', async () => {
            const mim = fs.readFileSync(path.resolve(__dirname, '../../MiM.vbook'));
            const r = await req('POST', '/api/v1/book/load-vbook', { cookie: userCookie, file: mim });
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(r.body.book_id).to.equal('master_margarita_demo');
            expect(fs.readdirSync(path.join(booksDir, 'master_margarita_demo')).sort())
                .to.deep.equal(['bible.json', 'book.json', 'chapters', 'characters.json', 'locations.json', 'manifest.json', 'voices.json']);
            const d = await req('GET', '/api/v1/book/master_margarita_demo/download', { cookie: userCookie });
            expect(d.status).to.equal(200);
            const anon = await req('GET', '/api/v1/book/master_margarita_demo/download');
            expect(anon.status).to.equal(401);
            expect(fs.readFileSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), 'utf8')).to.equal('keep');
        });
        it('owned book: chapter/scene ids in the URL with separators or ".." → 400', async () => {
            for (const [ch, sc] of [['..%2F..%2Fx', 'sc-1'], ['ch-1', 'x..y'], ['ch-1', 'a%5Cb'], ['a..b', 'sc-1']]) {
                const r = await req('GET', `/api/v1/scene/master_margarita_demo/${ch}/${sc}/t`, { cookie: userCookie });
                expect(r.status, `${ch}/${sc}`).to.equal(400);
            }
        });
    });
});
