// ======================================================
// Book input guard — route-level refusal tests
// ======================================================
// Import / download / book-scoped routes with invalid ids or archives are
// refused with 4xx and the disk stays unchanged; anonymous callers get 401
// and no guest identity is created for import.
//
// VBook 4 (architecture/VBOOK_FORMAT_V4.md): the fixture archive is a v4
// bundle; MiM.vbook (VBook 3.1) is refused with 422. The route-level halves of
// the step-1 acceptance criteria 1.1–1.4 and 1.6 are at the end of this file
// (the package-level halves: packages/animastor-vbook-runtime/test/
// vbook-v4-format.test.js).

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
const { authContext, requireIdentityForWrites, requireBookAccess, requireAdmin } = require('../src/middleware/auth-context');
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
const NARRATOR = { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep calm voice.', manner: 'Slow.' } };
const YURA = { schema: 'animastor.character/1', id: 'yura', name: 'Юра', passport: { appearance: 'tall', clothes: 'coat', video_tokens: ['man'] } };
const SHA = 'a'.repeat(64);
const NO_VERSION = Symbol('manifest without vbook_version');

/**
 * A VBook 4 archive. `replace` swaps the data of an entry by name, `drop`
 * removes entries, `extra` appends entries, `prefix` puts everything under a folder.
 */
function bundle({ bookId = 'guard_book_1', buildId = 'build_guard_book_1', version = 4, extra = [], replace = {}, drop = [], prefix = '' } = {}) {
    const manifest = { book_id: bookId, build_id: buildId };
    if (version !== NO_VERSION) manifest.vbook_version = version;
    const entries = [
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'book.json', data: JSON.stringify({ book_id: bookId, title: 'Guard Book', structure: { chapters_order: [`${CH}.json`], characters_order: ['narrator', 'yura'] } }) },
        { name: 'behaviour.json', data: JSON.stringify({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] }) },
        { name: 'characters/narrator.json', data: JSON.stringify(NARRATOR) },
        { name: 'characters/yura.json', data: JSON.stringify(YURA) },
        { name: `chapters/${CH}.json`, data: JSON.stringify({ chapter_id: CH, scenes: [{ scene_id: 'sc-1a2b3c4d', type: 'narration', participants: ['yura'], audio: { voice: 'narrator', full_text: 'Текст сцены.' }, units: [{ id: 'iu-1a2b3c4d', type: 'narration', text: 'Текст сцены.' }] }] }) },
    ]
        .filter((e) => !drop.includes(e.name))
        .map((e) => (Object.prototype.hasOwnProperty.call(replace, e.name) ? { ...e, data: replace[e.name] } : e));
    return rawZip([...entries, ...extra].map((e) => ({ ...e, name: prefix + e.name })));
}
const V4_BOOK_FILES = ['behaviour.json', 'book.json', 'chapters', `chapters/${CH}.json`, 'characters', 'characters/narrator.json', 'characters/yura.json', 'manifest.json'];
const LEGACY_FILES = ['characters.json', 'voices.json', 'behavior.json', 'mentions.json'];

function zipFiles(buffer) {
    const AdmZip = require('adm-zip');
    const out = {};
    for (const e of new AdmZip(buffer).getEntries()) out[e.entryName] = e.getData().toString('utf8');
    return out;
}

/** Recursive listing with file contents — "the disk did not change" means bytes too. */
function contents(root) {
    const out = {};
    (function walk(d, rel) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r);
            else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
        }
    })(root, '');
    return out;
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
    const ownedBookIds = [];

    async function req(method, route, { cookie, body, file, fileName = 'x.vbook', lang, raw = false } = {}) {
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        if (lang) headers['Accept-Language'] = lang;
        let payload;
        if (file) {
            const fd = new FormData();
            fd.append('file', new Blob([file]), fileName);
            payload = fd;
        } else if (body) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, body: payload, redirect: 'manual' });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie && !cookie) createdGuestCookies.push(setCookie.split(';')[0]);
        if (raw && res.status === 200) {
            return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers, setCookie };
        }
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
        app.use(requireIdentityForWrites); // as backend.cjs
        inputGuard.registerParamGuards(app);
        app.use('/api/v1', inputGuard.requestIdsGuard);
        registerAuthRoutes(app, null, { utils: { log: () => {} } });
        const guard = requireBookAccess('bookId');
        app.use('/api/v1/book/:bookId', inputGuard.bookIdPathGuard, (r, s, n) => (
            inputGuard.CREATE_BOOK_SUBPATHS.has(r.params.bookId) ? n() : guard(r, s, n)));
        // VBOOK_FORMAT_V4 §9 (step 4): the version gate of backend.cjs, after the access guard
        app.use('/api/v1/book/:bookId', require('../src/middleware/vbook-version-gate').createBookVersionGate({
            getBookManifest: (id) => require('@animastor/vbook-runtime/book-model.cjs').getBookManifest(id),
            skip: inputGuard.CREATE_BOOK_SUBPATHS,
        }));
        app.use('/api/v1/scene/:bookId', inputGuard.bookIdPathGuard, requireBookAccess('bookId'));
        app.use('/api/v1/debug', requireAdmin);
        app.get('/api/v1/debug/ping', (r, s) => s.json({ ok: true }));
        registerImportRoutes(app, { get: async () => null, set: async () => {}, del: async () => {} }, deps);
        registerExportRoutes(app, null, { config, book, audio: null, utils: { log: () => {} } });
        registerRecentBooksRoutes(app, null, { bookSourceRepo: deps.bookSourceRepo, lazyBook, utils: { log: () => {} } });
        // The editor's GET /book — the route that must answer 409 for a 3.1 book.
        const editor = require('@animastor/editor');
        const bookModel = require('@animastor/vbook-runtime/book-model.cjs');
        // VBook 4 step 4: the hero API — the refusals of its host guards are below
        editor.createHeroRoutes(app, null, {
            book, bookDiff: null, storage: null,
            editorModel: editor.createEditorModel({ bookModel, persistBook: book.saveBookBundle }),
            editorPorts: { sceneAssetsRepo: {}, outputRoot: outputDir },
            utils: { log: () => {} },
        });
        editor.createEditorRoutes(app, null, {
            book, bookDiff: null, storage: null, bookDeletion: null,
            editorModel: editor.createEditorModel({ bookModel, persistBook: book.saveBookBundle }),
            editorPorts: {
                placeholderAudio: { recoverMissingPlaceholders: async () => ({ created: 0, errors: [] }) },
                recoveryCtx: { isBookRegistered: async () => false },
                sceneAssetsRepo: {}, auditCoverage: {}, promptLimit: 4000,
            },
            utils: { log: () => {} },
        });
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
        await query(`DELETE FROM book_source WHERE book_id = ANY($1)`, [ownedBookIds]).catch(() => {});
        await query(`DELETE FROM books WHERE book_id = ANY($1)`, [['guard_book_1', 'master_margarita_demo', 'old_book_31', 'other_guard_book', ...ownedBookIds]]).catch(() => {});
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
        it('a VBook 4 archive imports for a signed-in user, then downloads; anonymous download → 401', async () => {
            const r = await req('POST', '/api/v1/book/load-vbook', { cookie: userCookie, file: bundle() });
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(r.body).to.include({ book_id: 'guard_book_1', build_id: 'build_guard_book_1', chapter_count: 1, scene_count: 1, was_existing: false });
            expect(tree(path.join(booksDir, 'guard_book_1')).split('\n')).to.deep.equal(V4_BOOK_FILES);
            const d = await req('GET', '/api/v1/book/guard_book_1/download', { cookie: userCookie, raw: true });
            expect(d.status).to.equal(200);
            expect(Object.keys(zipFiles(d.buffer)).sort()).to.deep.equal(V4_BOOK_FILES.filter((f) => f.includes('.')));
            const anon = await req('GET', '/api/v1/book/guard_book_1/download');
            expect(anon.status).to.equal(401);
            expect(fs.readFileSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), 'utf8')).to.equal('keep');
        });
        it('a second import of the same book keeps the copy on disk untouched', async () => {
            const before = contents(path.join(booksDir, 'guard_book_1'));
            const edited = bundle({ replace: { 'characters/yura.json': JSON.stringify({ ...YURA, name: 'Другой' }) } });
            for (const route of ['/api/v1/book/import', '/api/v1/book/load-vbook']) {
                const r = await req('POST', route, { cookie: userCookie, file: edited });
                expect(r.status, JSON.stringify(r.body)).to.equal(200);
                expect(r.body.was_existing).to.equal(true);
            }
            expect(contents(path.join(booksDir, 'guard_book_1'))).to.deep.equal(before);
        });
        it('owned book: chapter/scene ids in the URL with separators or ".." → 400', async () => {
            for (const [ch, sc] of [['..%2F..%2Fx', 'sc-1'], ['ch-1', 'x..y'], ['ch-1', 'a%5Cb'], ['a..b', 'sc-1']]) {
                const r = await req('GET', `/api/v1/scene/guard_book_1/${ch}/${sc}/t`, { cookie: userCookie });
                expect(r.status, `${ch}/${sc}`).to.equal(400);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // VBook 4 — input refusals (after every refusal the disk is unchanged)
    // ══════════════════════════════════════════════════════════════════
    describe('VBook 4 import refusals (disk unchanged)', () => {
        const ROUTES = ['/api/v1/book/import', '/api/v1/book/load-vbook'];
        const hero = (extra) => JSON.stringify({ ...YURA, ...extra });
        const refFile = (file) => hero({ voice: { timbre: 't', reference: { file, sha256: SHA, ref_text: 'Фраза.', source: 'uploaded', locked: true } } });

        // [label, bundle options, expected status, expected error]
        const CASES = [
            ['bad hero id inside the file ("../x")', { book: 'v4_refuse', replace: { 'characters/yura.json': hero({ id: '../x' }) } }, 422, 'hero_file_broken'],
            ['bad hero id inside the file (upper case)', { replace: { 'characters/yura.json': hero({ id: 'Yura' }) } }, 422, 'hero_file_broken'],
            ['reserved hero id', { extra: [{ name: 'characters/book.json', data: hero({ id: 'book' }) }] }, 422, 'hero_file_broken'],
            ['hero file whose inner id differs from its name', { replace: { 'characters/yura.json': hero({ id: 'anna' }) } }, 422, 'hero_file_broken'],
            ['hero file that is not JSON', { replace: { 'characters/yura.json': '{oops' } }, 422, 'hero_file_broken'],
            ['entry characters/../x.json', { extra: [{ name: 'characters/../x.json', data: hero({ id: 'x' }) }] }, 400, null],
            ['entry characters/../../sibling/keep.txt', { extra: [{ name: 'characters/../../sibling/keep.txt', data: 'overwritten' }] }, 400, null],
            ['entry characters/<Cyrillic>.json', { extra: [{ name: 'characters/Юра.json', data: hero({ id: 'Юра' }) }] }, 422, 'hero_file_broken'],
            ['entry characters/<Cyrillic>.json with a valid inner id', { extra: [{ name: 'characters/Анна.json', data: hero({ id: 'anna' }) }] }, 422, 'hero_file_broken'],
            ['entry in a folder below characters/', { extra: [{ name: 'characters/sub/anna.json', data: hero({ id: 'anna' }) }] }, 422, 'hero_file_broken'],
            ['reference.file with ".."', { replace: { 'characters/yura.json': refFile('voices/yura/../../../secret.wav') } }, 422, 'hero_file_broken'],
            ['reference.file with a leading ".."', { replace: { 'characters/yura.json': refFile('../voices/yura/a.wav') } }, 422, 'hero_file_broken'],
            ['reference.file with ".." inside the file name', { replace: { 'characters/yura.json': refFile('voices/yura/a..b.wav') } }, 422, 'hero_file_broken'],
            ['absolute reference.file', { replace: { 'characters/yura.json': refFile('/etc/passwd.wav') } }, 422, 'hero_file_broken'],
            ['reference.file with a backslash', { replace: { 'characters/yura.json': refFile('voices\\yura\\a.wav') } }, 422, 'hero_file_broken'],
            ['reference.file in another hero\'s folder', { replace: { 'characters/yura.json': refFile('voices/narrator/a.wav') } }, 422, 'hero_file_broken'],
            ['reference.file that is not an audio file', { replace: { 'characters/yura.json': refFile('voices/yura/a.sh') } }, 422, 'hero_file_broken'],
            ['reference.file that is not .wav', { replace: { 'characters/yura.json': refFile('voices/yura/a.mp3') } }, 422, 'hero_file_broken'],
            ['reference without ref_text', { replace: { 'characters/yura.json': hero({ voice: { reference: { file: 'voices/yura/a.wav', sha256: SHA, source: 'uploaded', locked: true } } }) } }, 422, 'hero_file_broken'],
            ['hero id "chapters" (reserved)', { extra: [{ name: 'characters/chapters.json', data: hero({ id: 'chapters' }) }] }, 422, 'hero_file_broken'],
            ['hero id "source" (reserved)', { extra: [{ name: 'characters/source.json', data: hero({ id: 'source' }) }] }, 422, 'hero_file_broken'],
            ['archive without manifest.json in the root (prefix folder)', { prefix: 'import_1700000000/' }, 400, 'manifest_not_in_root'],
            ['archive without manifest.json at all', { drop: ['manifest.json'] }, 400, 'manifest_not_in_root'],
            ['vbook_version 3.1', { version: '3.1' }, 422, 'unsupported_vbook_version'],
            ['no vbook_version', { version: NO_VERSION }, 422, 'unsupported_vbook_version'],
            ['a newer vbook_version', { version: 5 }, 422, 'unsupported_vbook_version'],
            ['broken behaviour.json', { replace: { 'behaviour.json': JSON.stringify({ schema: 'animastor.behaviour-globals/1', rules: [{ id: 'r', scope: 'global' }] }) } }, 400, null],
            ['scene.look_patch with a foreign field', { replace: { [`chapters/${CH}.json`]: JSON.stringify({ chapter_id: CH, scenes: [{ scene_id: 'sc-1a2b3c4d', look_patch: { yura: { hat: 'x' } } }] }) } }, 400, null],
        ];
        for (const route of ROUTES) {
            for (const [label, options, status, error] of CASES) {
                it(`${route}: ${label} → ${status}${error ? ` ${error}` : ''}`, async () => {
                    const { book: bookId = 'v4_refuse', ...rest } = options;
                    const before = contents(sandbox);
                    const r = await req('POST', route, { cookie: userCookie, file: bundle({ bookId, buildId: `build_${bookId}`, ...rest }) });
                    expect(r.status, JSON.stringify(r.body)).to.equal(status);
                    if (error) expect(r.body.error).to.equal(error);
                    expect(contents(sandbox)).to.deep.equal(before);
                    expect(fs.existsSync(path.join(booksDir, bookId))).to.equal(false);
                });
            }
        }

        it('the same hero with a well-formed reference imports — the refusals above are about the path, not the fixture', async () => {
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'v4_good_ref', buildId: 'build_v4_good_ref', replace: { 'characters/yura.json': refFile('voices/yura/a.wav') } }) });
            ownedBookIds.push('v4_good_ref');
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(book.loadBook('v4_good_ref').heroes[1].voice.reference.file).to.equal('voices/yura/a.wav');
        });

        it('a refused hero file is named in the answer, without a server path', async () => {
            const r = await req('POST', '/api/v1/book/import', {
                cookie: userCookie,
                file: bundle({ bookId: 'v4_refuse', replace: { 'characters/yura.json': '{oops' }, extra: [{ name: 'characters/Юра.json', data: '{}' }] }),
            });
            expect(r.status).to.equal(422);
            expect(r.body.error).to.equal('hero_file_broken');
            expect(r.body.issues.map((i) => i.file)).to.deep.equal(['characters/Юра.json']);
            expect(JSON.stringify(r.body)).to.not.include(sandbox);
        });

        it('3.1 files in a v4 archive are outside the whitelist: the book imports, they are not on disk', async () => {
            const legacy = [
                { name: 'characters.json', data: '[{"id":"evil"}]' },
                { name: 'voices.json', data: '{"evil":{"instruction":"x"}}' },
                { name: 'behavior.json', data: '{"schema_version":2}' },
                { name: 'mentions.json', data: '{"x":"evil"}' },
                { name: `${CH}.json`, data: '{}' },
                { name: 'voices/yura/ref.wav', data: 'RIFF' },
                { name: 'README.txt', data: 'hello' },
                { name: 'characters/.hidden.json', data: '{}' },
            ];
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'v4_with_legacy', buildId: 'build_v4_with_legacy', extra: legacy }) });
            ownedBookIds.push('v4_with_legacy');
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(tree(path.join(booksDir, 'v4_with_legacy')).split('\n')).to.deep.equal(V4_BOOK_FILES);
            for (const f of LEGACY_FILES) expect(fs.existsSync(path.join(booksDir, 'v4_with_legacy', f)), f).to.equal(false);
            const loaded = book.loadBook('v4_with_legacy');
            expect(loaded.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
        });

        it('a zip is never imported as text, whatever is inside', async () => {
            const before = contents(sandbox);
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: rawZip([{ name: 'story.txt', data: 'Глава 1' }]), fileName: 'story.txt' });
            expect(r.status).to.equal(400);
            expect(r.body.error).to.equal('manifest_not_in_root');
            expect(contents(sandbox)).to.deep.equal(before);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // VBook 4 — acceptance of step 1 at route level (VBOOK_FORMAT_V4 §12)
    // ══════════════════════════════════════════════════════════════════
    describe('VBook 4 acceptance — routes', () => {
        async function ownerWorkspaceId() {
            const row = (await query('SELECT w.id FROM workspaces w JOIN users u ON u.user_id = w.owner_user_id WHERE u.username = $1 LIMIT 1', [uname])).rows[0];
            return row.id;
        }
        async function own(bookId) {
            const workspaceOwnership = require('../src/middleware/workspace-ownership');
            await workspaceOwnership.resolveWorkspaceForBook(bookId, { bookTitle: bookId, preferredWorkspaceId: await ownerWorkspaceId() });
            ownedBookIds.push(bookId);
        }

        it('1.1 TXT import creates a VBook 4 book: §3 layout, vbook_version 4, narrator file, behaviour.json, no 3.1 files', async () => {
            const text = 'Глава 1. Встреча\n\nЮра вошёл в комнату и остановился у окна. За стеклом шёл снег.\n';
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: Buffer.from(text, 'utf8'), fileName: 'zima.txt' });
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(r.body).to.include({ format: 'txt', state: 'RAW_IMPORTED' });
            const bookId = r.body.book_id;
            ownedBookIds.push(bookId);
            const dir = path.join(booksDir, bookId);
            expect(tree(dir).split('\n')).to.deep.equal(['behaviour.json', 'book.json', 'characters', 'characters/narrator.json', 'manifest.json', 'source.txt']);
            for (const f of LEGACY_FILES) expect(fs.existsSync(path.join(dir, f)), f).to.equal(false);

            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
            expect(manifest.vbook_version).to.be.a('number').and.equal(4);
            expect(manifest.import_meta.original_filename).to.equal('zima.txt');
            const narrator = JSON.parse(fs.readFileSync(path.join(dir, 'characters', 'narrator.json'), 'utf8'));
            expect(narrator).to.include({ schema: 'animastor.character/1', id: 'narrator', role: 'narrator' });
            expect(narrator.voice).to.have.all.keys('timbre', 'manner', 'timbre_source');
            expect(JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8')))
                .to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] });
            expect(fs.readFileSync(path.join(dir, 'source.txt'), 'utf8')).to.equal(text);

            // and it opens as a v4 book through the API
            const got = await req('GET', `/api/v1/book/${bookId}`, { cookie: userCookie });
            expect(got.status, JSON.stringify(got.body)).to.equal(200);
            expect(got.body.manifest.vbook_version).to.equal(4);
            expect(got.body.heroes.map((h) => h.id)).to.deep.equal(['narrator']);
            expect(got.body.hero_issues).to.deep.equal([]);
            expect(got.body.behaviour.schema).to.equal('animastor.behaviour-globals/1');
            for (const key of ['characters', 'voices', 'behaviors', 'behavior_rules', 'mentions']) expect(got.body, key).to.not.have.property(key);
        });

        it('1.2 export → import → export: the second archive equals the first in entries and content', async () => {
            const first = await req('GET', '/api/v1/book/guard_book_1/download', { cookie: userCookie, raw: true });
            expect(first.status).to.equal(200);
            const firstFiles = zipFiles(first.buffer);
            expect(Object.keys(firstFiles).sort()).to.deep.equal(V4_BOOK_FILES.filter((f) => f.includes('.')));

            fs.rmSync(path.join(booksDir, 'guard_book_1'), { recursive: true, force: true });
            const imported = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: first.buffer });
            expect(imported.status, JSON.stringify(imported.body)).to.equal(200);
            expect(imported.body).to.include({ book_id: 'guard_book_1', was_existing: false });

            const second = await req('GET', '/api/v1/book/guard_book_1/download', { cookie: userCookie, raw: true });
            expect(second.status).to.equal(200);
            expect(zipFiles(second.buffer)).to.deep.equal(firstFiles);
            // the disk holds exactly the archive: nothing more, nothing else
            expect(contents(path.join(booksDir, 'guard_book_1'))).to.deep.equal(firstFiles);
        });

        it('1.2 export goes by the whitelist: stray files in the book folder are not exported', async () => {
            const dir = path.join(booksDir, 'guard_book_1');
            fs.writeFileSync(path.join(dir, 'characters.json'), '[{"id":"legacy"}]');
            fs.writeFileSync(path.join(dir, 'notes.private'), 'secret');
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), path.join(dir, 'link.json'));
            try {
                const d = await req('GET', '/api/v1/book/guard_book_1/download', { cookie: userCookie, raw: true });
                expect(Object.keys(zipFiles(d.buffer)).sort()).to.deep.equal(V4_BOOK_FILES.filter((f) => f.includes('.')));
            } finally {
                for (const f of ['characters.json', 'notes.private', 'link.json']) fs.rmSync(path.join(dir, f), { force: true });
            }
        });

        for (const route of ['/api/v1/book/import', '/api/v1/book/load-vbook']) {
            it(`1.3 ${route}: MiM.vbook (VBook 3.1) → 422 unsupported_vbook_version, disk unchanged`, async () => {
                const mim = fs.readFileSync(path.resolve(__dirname, '../../MiM.vbook'));
                const before = contents(sandbox);
                const r = await req('POST', route, { cookie: userCookie, file: mim, lang: 'ru' });
                expect(r.status).to.equal(422);
                expect(r.body).to.deep.equal({
                    error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4,
                    message: 'Книга сохранена в формате VBook 3.1, который больше не поддерживается. Импортируйте исходный текст заново — книга будет создана в формате 4.',
                });
                expect(contents(sandbox)).to.deep.equal(before);
                expect(fs.existsSync(path.join(booksDir, 'master_margarita_demo'))).to.equal(false);
            });

            it(`1.3 ${route}: an archive without a version → 422 unsupported_vbook_version, disk unchanged`, async () => {
                const before = contents(sandbox);
                const r = await req('POST', route, { cookie: userCookie, file: bundle({ bookId: 'no_version_book', version: NO_VERSION }) });
                expect(r.status).to.equal(422);
                expect(r.body).to.include({ error: 'unsupported_vbook_version', vbook_version: null, supported: 4 });
                expect(r.body.message).to.be.a('string').and.not.equal('');
                expect(contents(sandbox)).to.deep.equal(before);
            });
        }

        it('1.3 a VBook 3.1 book folder on disk: GET /book → 409 with the same body, not one file changed', async () => {
            const dir = path.join(booksDir, 'old_book_31');
            fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ vbook_version: '3.1', book_id: 'old_book_31', build_id: 'build_old_book_31', state: 'ACTIVE' }, null, 2));
            fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ title: 'Старая книга', structure: { chapters_order: [`${CH}.json`] } }, null, 2));
            fs.writeFileSync(path.join(dir, 'characters.json'), '[{"id":"yura","passport":{"appearance":"tall"}}]');
            fs.writeFileSync(path.join(dir, 'voices.json'), '{"narrator":{"instruction":"x"}}');
            fs.writeFileSync(path.join(dir, 'behavior.json'), '{}');
            fs.writeFileSync(path.join(dir, 'mentions.json'), '{}');
            fs.writeFileSync(path.join(dir, 'chapters', `${CH}.json`), JSON.stringify({ chapter_id: CH, scenes: [] }));
            await own('old_book_31');
            const before = contents(dir);
            const stamps = () => Object.keys(before).map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
            const stampsBefore = stamps();

            const r = await req('GET', '/api/v1/book/old_book_31', { cookie: userCookie, lang: 'ru' });
            expect(r.status).to.equal(409);
            expect(r.body).to.deep.equal({
                error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4,
                message: 'Книга сохранена в формате VBook 3.1, который больше не поддерживается. Импортируйте исходный текст заново — книга будет создана в формате 4.',
            });
            // the download of such a book is refused the same way
            const d = await req('GET', '/api/v1/book/old_book_31/download', { cookie: userCookie, lang: 'ru' });
            expect(d.status).to.equal(409);
            expect(d.body).to.deep.equal(r.body);
            // importing a v4 archive over that id neither opens nor replaces it
            // (В9) the answer names the obstacle — the OLD copy — and the way out
            const again = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'old_book_31', buildId: 'build_old_book_31' }), lang: 'ru' });
            expect(again.status).to.equal(409);
            expect(again.body).to.deep.equal({
                error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4,
                existing_book_id: 'old_book_31', hint: 'delete_existing_book',
                message: 'На сервере уже есть книга с этим идентификатором (old_book_31) в формате VBook 3.1, который больше не поддерживается. Удалите старую книгу и повторите импорт.',
            });
            const againEn = await req('POST', '/api/v1/book/load-vbook', { cookie: userCookie, file: bundle({ bookId: 'old_book_31', buildId: 'build_old_book_31' }) });
            expect(againEn.status).to.equal(409);
            expect(againEn.body.hint).to.equal('delete_existing_book');
            expect(againEn.body.message).to.match(/Delete the old book and import again\.$/);

            expect(contents(dir)).to.deep.equal(before);
            expect(stamps()).to.deep.equal(stampsBefore);
        });

        it('1.3 the book list shows a 3.1 book as unsupported, with its title', async () => {
            const r = await req('GET', '/api/v1/books', { cookie: userCookie });
            expect(r.status).to.equal(200);
            const old = r.body.books.find((b) => b.book_id === 'old_book_31');
            expect(old).to.include({ unsupported: true, vbook_version: '3.1', title: 'Старая книга', build_id: 'build_old_book_31' });
            const fresh = r.body.books.find((b) => b.book_id === 'guard_book_1');
            expect(fresh).to.not.have.property('unsupported');
        });

        for (const route of ['/api/v1/book/import', '/api/v1/book/load-vbook']) {
            it(`1.4 ${route}: an archive with a prefix folder → manifest_not_in_root, nothing on disk`, async () => {
                const before = contents(sandbox);
                for (const prefix of ['import_1700000000/', 'guard_book_9/', 'a/b/']) {
                    const r = await req('POST', route, { cookie: userCookie, file: bundle({ bookId: 'guard_book_9', prefix }) });
                    expect(r.status, prefix).to.equal(400);
                    expect(r.body.error, prefix).to.equal('manifest_not_in_root');
                }
                expect(contents(sandbox)).to.deep.equal(before);
            });
        }

        it('1.4 entries outside the whitelist never reach the disk', async () => {
            const stray = [
                { name: 'evil.sh', data: '#!/bin/sh' }, { name: 'chapters/notes.txt', data: 'x' },
                { name: 'chapters/ch-zzzz.json', data: '{}' }, { name: 'extra/deep/file.json', data: '{}' },
                { name: 'cover.json', data: '{}' }, { name: 'manifest.json.bak', data: '{}' }, { name: 'notebook.json', data: '{}' },
                ...LEGACY_FILES.map((name) => ({ name, data: '{}' })),
            ];
            const r = await req('POST', '/api/v1/book/load-vbook', { cookie: userCookie, file: bundle({ bookId: 'v4_whitelist', buildId: 'build_v4_whitelist', extra: stray }) });
            ownedBookIds.push('v4_whitelist');
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(tree(path.join(booksDir, 'v4_whitelist')).split('\n')).to.deep.equal(V4_BOOK_FILES);
        });

        describe('1.6 a broken hero file', () => {
            const BROKEN = '{"schema":"animastor.character/1","id":"yura",';
            let dir;
            before(async () => {
                const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'v4_broken_hero', buildId: 'build_v4_broken_hero' }) });
                ownedBookIds.push('v4_broken_hero');
                expect(r.status, JSON.stringify(r.body)).to.equal(200);
                dir = path.join(booksDir, 'v4_broken_hero');
                fs.writeFileSync(path.join(dir, 'characters', 'yura.json'), BROKEN);
            });

            it('1.6 the book opens: GET /book 200 without the broken hero, hero_issues names the file', async () => {
                const r = await req('GET', '/api/v1/book/v4_broken_hero', { cookie: userCookie });
                expect(r.status, JSON.stringify(r.body)).to.equal(200);
                expect(r.body.heroes.map((h) => h.id)).to.deep.equal(['narrator']);
                expect(r.body.hero_issues).to.have.length(1);
                expect(r.body.hero_issues[0]).to.include({ file: 'characters/yura.json', hero_id: 'yura', code: 'invalid_json', blocking: true });
                expect(JSON.stringify(r.body.hero_issues)).to.not.include(sandbox);
                expect(r.body.chapters[0].scenes[0].participants).to.deep.equal(['yura']);
            });

            it('1.6 a write to the broken id is refused with hero_file_broken and the file keeps its bytes', async () => {
                const before = contents(dir);
                const loaded = book.loadBook('v4_broken_hero');
                let code = null;
                try { book.saveBookBundle({ ...loaded, heroes: [...loaded.heroes, YURA] }); } catch (err) { code = err.code; }
                expect(code).to.equal('hero_file_broken');
                code = null;
                try { book.characterStore.updateCharacter(dir, 'yura', (h) => h); } catch (err) { code = err.code; }
                expect(code).to.equal('hero_file_broken');
                expect(contents(dir)).to.deep.equal(before);
                expect(fs.readFileSync(path.join(dir, 'characters', 'yura.json'), 'utf8')).to.equal(BROKEN);
            });

            it('1.6 export → 409 hero_file_broken with the list; ?skip_broken=1 exports without the broken hero', async () => {
                const before = contents(dir);
                const refused = await req('GET', '/api/v1/book/v4_broken_hero/download', { cookie: userCookie });
                expect(refused.status).to.equal(409);
                expect(refused.body.error).to.equal('hero_file_broken');
                expect(refused.body.issues).to.deep.equal([{ file: 'characters/yura.json', hero_id: 'yura', code: 'invalid_json', message: refused.body.issues[0].message }]);

                const skipped = await req('GET', '/api/v1/book/v4_broken_hero/download?skip_broken=1', { cookie: userCookie, raw: true });
                expect(skipped.status).to.equal(200);
                expect(Object.keys(zipFiles(skipped.buffer)).sort())
                    .to.deep.equal(V4_BOOK_FILES.filter((f) => f.includes('.') && f !== 'characters/yura.json'));
                expect(skipped.headers.get('x-animastor-skipped-heroes')).to.equal('1');
                expect(contents(dir)).to.deep.equal(before);
            });

            it('(В5) a broken behaviour.json: GET /book 200 with default rules and a blocking problem; export 409 behaviour_file_broken; skip_broken exports', async () => {
                const r0 = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'v4_broken_behaviour', buildId: 'build_v4_broken_behaviour' }) });
                ownedBookIds.push('v4_broken_behaviour');
                expect(r0.status, JSON.stringify(r0.body)).to.equal(200);
                const bdir = path.join(booksDir, 'v4_broken_behaviour');
                fs.writeFileSync(path.join(bdir, 'behaviour.json'), '{"schema":');
                const before = contents(bdir);

                const got = await req('GET', '/api/v1/book/v4_broken_behaviour', { cookie: userCookie });
                expect(got.status, JSON.stringify(got.body)).to.equal(200);
                expect(got.body.behaviour).to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] });
                expect(got.body.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
                expect(got.body.hero_issues.map((i) => [i.file, i.code, i.blocking])).to.deep.equal([['behaviour.json', 'invalid_json', true]]);

                const refused = await req('GET', '/api/v1/book/v4_broken_behaviour/download', { cookie: userCookie });
                expect(refused.status).to.equal(409);
                expect(refused.body.error).to.equal('behaviour_file_broken');
                expect(refused.body.issues.map((i) => i.file)).to.deep.equal(['behaviour.json']);

                const skipped = await req('GET', '/api/v1/book/v4_broken_behaviour/download?skip_broken=1', { cookie: userCookie, raw: true });
                expect(skipped.status).to.equal(200);
                expect(JSON.parse(zipFiles(skipped.buffer)['behaviour.json']).rules).to.deep.equal([]);
                expect(skipped.headers.get('x-animastor-skipped-heroes')).to.equal('0');
                expect(skipped.headers.get('x-animastor-skipped-files')).to.equal('1');
                expect(contents(bdir)).to.deep.equal(before);
            });

            it('(В8) a book without a narrator exports; narrator_missing is a warning', async () => {
                const r0 = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: 'v4_no_narrator', buildId: 'build_v4_no_narrator', drop: ['characters/narrator.json'] }) });
                ownedBookIds.push('v4_no_narrator');
                expect(r0.status, JSON.stringify(r0.body)).to.equal(200);
                const got = await req('GET', '/api/v1/book/v4_no_narrator', { cookie: userCookie });
                expect(got.body.hero_issues.map((i) => [i.code, i.blocking])).to.deep.equal([['narrator_missing', false]]);
                const d = await req('GET', '/api/v1/book/v4_no_narrator/download', { cookie: userCookie, raw: true });
                expect(d.status).to.equal(200);
                expect(Object.keys(zipFiles(d.buffer))).to.not.include('characters/narrator.json');
            });

            it('1.6 an archive that carries the broken file is refused on import (422), disk unchanged', async () => {
                const before = contents(sandbox);
                const r = await req('POST', '/api/v1/book/import', {
                    cookie: userCookie,
                    file: bundle({ bookId: 'v4_broken_import', replace: { 'characters/yura.json': BROKEN } }),
                });
                expect(r.status).to.equal(422);
                expect(r.body.error).to.equal('hero_file_broken');
                expect(r.body.issues.map((i) => [i.file, i.code])).to.deep.equal([['characters/yura.json', 'invalid_json']]);
                expect(contents(sandbox)).to.deep.equal(before);
            });
        });
    });
    // ══════════════════════════════════════════════════════════════════
    // VBook 4 step 4 — hero API refusals: anonymous, a stranger's book, a bad
    // :heroId (one canonical grammar, one segment), "..", a file name that is
    // not in hero_issues; a 3.1 book → the GET /book 409 for every route
    // ══════════════════════════════════════════════════════════════════
    describe('VBook 4 step 4 — hero routes refusals (disk unchanged)', () => {
        const S4 = 'guard_heroes_s4';
        const OLD = 'old_book_31_s4';
        const strangerName = `guard_stranger_${stamp}`;
        let strangerCookie;
        let dir;
        async function ownerWorkspaceId() {
            const row = (await query('SELECT w.id FROM workspaces w JOIN users u ON u.user_id = w.owner_user_id WHERE u.username = $1 LIMIT 1', [uname])).rows[0];
            return row.id;
        }
        async function own(bookId) {
            await require('../src/middleware/workspace-ownership').resolveWorkspaceForBook(bookId, { bookTitle: bookId, preferredWorkspaceId: await ownerWorkspaceId() });
            ownedBookIds.push(bookId);
        }
        const heroRoutes = (bookId, heroId) => [
            ['GET', `/api/v1/book/${bookId}/heroes/${heroId}`],
            ['PATCH', `/api/v1/book/${bookId}/heroes/${heroId}`, { fields: { name: 'X' } }],
            ['DELETE', `/api/v1/book/${bookId}/heroes/${heroId}`],
            ['POST', `/api/v1/book/${bookId}/heroes/${heroId}/rules`, { then: { action: 'x' } }],
            ['POST', `/api/v1/book/${bookId}/heroes/${heroId}/looks`, { label: 'x', fields: { clothes: 'x' } }],
        ];

        before(async () => {
            const r = await req('POST', '/api/v1/book/import', { cookie: userCookie, file: bundle({ bookId: S4, buildId: `build_${S4}` }) });
            ownedBookIds.push(S4);
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            dir = path.join(booksDir, S4);
            fs.writeFileSync(path.join(dir, 'characters', 'Юра.json'), '{"schema":"animastor.character/1","id":"yura"}');
            const reg = await req('POST', '/api/v1/auth/register', { body: { username: strangerName, password: 'guard-pass-42', email: `${strangerName}@example.test` } });
            expect(reg.status, JSON.stringify(reg.body)).to.be.oneOf([200, 201]);
            strangerCookie = reg.setCookie.split(',').map((c) => c.trim().split(';')[0]).find((c) => c.startsWith('animastor_session=')) || reg.setCookie.split(';')[0];
            createdGuestCookies.length = 0;
            const old = path.join(booksDir, OLD);
            fs.mkdirSync(path.join(old, 'chapters'), { recursive: true });
            fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ vbook_version: '3.1', book_id: OLD, build_id: `build_${OLD}` }));
            fs.writeFileSync(path.join(old, 'book.json'), JSON.stringify({ title: 'Старая', structure: { chapters_order: [] } }));
            fs.writeFileSync(path.join(old, 'characters.json'), '[]');
            await own(OLD);
        });
        after(async () => {
            const u = (await query('SELECT user_id FROM users WHERE username = $1', [strangerName])).rows[0];
            if (u) {
                await query('DELETE FROM sessions WHERE user_id = $1', [u.user_id]).catch(() => {});
                await query('DELETE FROM workspace_members WHERE user_id = $1', [u.user_id]).catch(() => {});
                await query('DELETE FROM workspaces WHERE owner_user_id = $1', [u.user_id]).catch(() => {});
                await query('DELETE FROM users WHERE user_id = $1', [u.user_id]).catch(() => {});
            }
        });

        it('the owner reads the heroes (the mount works) and sees the broken file in hero_issues', async () => {
            const r = await req('GET', `/api/v1/book/${S4}/heroes`, { cookie: userCookie });
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            expect(r.body.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
            expect(r.body.hero_issues.map((i) => i.file)).to.include('characters/Юра.json');
        });

        // Owner's decision 18.11 (step 5): no guest is minted on any route —
        // an anonymous request to /api/v1/book/* is 401, reads and writes alike.
        it('anonymous → 401 login_required on every hero route; no guest cookie, no users/workspaces/guests rows; nothing changes', async () => {
            const before = contents(dir);
            const rows = async () => (await query(`SELECT (SELECT COUNT(*)::int FROM users) AS u,
                (SELECT COUNT(*)::int FROM workspaces) AS w, (SELECT COUNT(*)::int FROM guests) AS g`)).rows[0];
            const rowsBefore = await rows();
            for (const [m, u, body] of [...heroRoutes(S4, 'yura'), ['POST', `/api/v1/book/${S4}/heroes`, { name: 'Анна' }],
                ['DELETE', `/api/v1/book/${S4}/hero-files?file=${encodeURIComponent('Юра.json')}`], ['POST', `/api/v1/book/${S4}/looks/assign`, { hero_id: 'yura', look_id: null, chapters: [CH] }],
                ['PATCH', `/api/v1/book/${S4}/behaviour`, { fields: { 'defaults.max_per_scene': 1 } }]]) {
                const r = await req(m, u, { body });
                expect(r.status, `${m} ${u}`).to.equal(401);
                expect(r.body.code, `${m} ${u}`).to.equal('login_required');
                expect(r.setCookie || '', `${m} ${u}`).to.not.match(/animastor_gid=/);
            }
            expect(contents(dir)).to.deep.equal(before);
            expect(await rows()).to.deep.equal(rowsBefore);
        });

        it('a stranger (another user\'s book) → 403 on every hero route; nothing changes', async () => {
            const before = contents(dir);
            for (const [m, u, body] of [...heroRoutes(S4, 'yura'), ['GET', `/api/v1/book/${S4}/heroes`], ['POST', `/api/v1/book/${S4}/heroes`, { name: 'Анна' }],
                ['DELETE', `/api/v1/book/${S4}/hero-files?file=${encodeURIComponent('Юра.json')}`]]) {
                const r = await req(m, u, { cookie: strangerCookie, body });
                expect(r.status, `${m} ${u}`).to.equal(403);
            }
            expect(contents(dir)).to.deep.equal(before);
        });

        it('a :heroId outside the one canonical grammar → 400 invalid_hero_id before any handler', async () => {
            const before = contents(dir);
            for (const bad of ['Yura', 'yu.ra', 'yura_', '_yura', 'yu__ra', 'a'.repeat(65), encodeURIComponent('юра'), 'yura%20x', '..%2F..%2Fmanifest']) {
                for (const [m, u, body] of heroRoutes(S4, bad)) {
                    const r = await req(m, u, { cookie: userCookie, body });
                    expect(r.status, `${m} ${u}`).to.equal(400);
                    expect(r.body.code, `${m} ${u}`).to.equal('invalid_hero_id');
                }
            }
            expect(contents(dir)).to.deep.equal(before);
        });

        it('".." as :heroId sent verbatim (encoded) → 400; a bad :lookId → 400 invalid_look_id', async () => {
            const http = require('http');
            for (const [method, raw] of [['GET', `/api/v1/book/${S4}/heroes/%2E%2E`], ['POST', `/api/v1/book/${S4}/heroes/%2e%2e/looks`], ['DELETE', `/api/v1/book/${S4}/heroes/%2E%2E%2Fnarrator`]]) {
                const status = await new Promise((resolve, reject) => {
                    const r = http.request({ host: '127.0.0.1', port, method, path: raw, headers: { Cookie: userCookie } }, (res) => { res.resume(); resolve(res.statusCode); });
                    r.on('error', reject); r.end();
                });
                expect(status, raw).to.equal(400);
            }
            const look = await req('PATCH', `/api/v1/book/${S4}/heroes/yura/looks/Coat.x`, { cookie: userCookie, body: { fields: { label: 'x' } } });
            expect(look.status).to.equal(400);
            expect(look.body.code).to.equal('invalid_look_id');
        });

        it('hero-files: a name not in hero_issues → 404; a path or ".." → 422; the listed name → deleted', async () => {
            const before = contents(dir);
            for (const [name, status] of [['yura.json', 404], ['narrator.json', 404], ['../manifest.json', 422], ['..', 422], ['chapters', 404], [`..%2F..%2F${S4}%2Fbook.json`, 422]]) {
                const r = await req('DELETE', `/api/v1/book/${S4}/hero-files?file=${name.includes('%') ? name : encodeURIComponent(name)}`, { cookie: userCookie });
                expect(r.status, name).to.equal(status);
            }
            expect(contents(dir)).to.deep.equal(before);
            const ok = await req('DELETE', `/api/v1/book/${S4}/hero-files?file=${encodeURIComponent('Юра.json')}`, { cookie: userCookie });
            expect(ok.status, JSON.stringify(ok.body)).to.equal(200);
            expect(fs.existsSync(path.join(dir, 'characters', 'Юра.json'))).to.equal(false);
            expect(fs.existsSync(path.join(dir, 'characters', 'yura.json'))).to.equal(true);
        });

        it('a 3.1 book: generation, analysis, editor and hero routes → 409 with the GET /book body; deleting the book is let through', async () => {
            const old = path.join(booksDir, OLD);
            const before = contents(old);
            const ref = await req('GET', `/api/v1/book/${OLD}`, { cookie: userCookie, lang: 'ru' });
            expect(ref.status).to.equal(409);
            for (const [m, u, body] of [
                ['POST', `/api/v1/book/${OLD}/regenerate`, { scope: 'whole_book' }],
                ['POST', `/api/v1/book/${OLD}/generate-window`, {}],
                ['POST', `/api/v1/book/${OLD}/agent/continue`, {}],
                ['PUT', `/api/v1/book/${OLD}`, { manifest: { book_id: OLD } }],
                ['GET', `/api/v1/book/${OLD}/heroes`],
                ['POST', `/api/v1/book/${OLD}/heroes`, { name: 'Анна' }],
                ['PATCH', `/api/v1/book/${OLD}/heroes/yura`, { fields: { name: 'x' } }],
            ]) {
                const r = await req(m, u, { cookie: userCookie, body, lang: 'ru' });
                expect(r.status, `${m} ${u}`).to.equal(409);
                expect(r.body, `${m} ${u}`).to.deep.equal(ref.body);
            }
            const del = await req('DELETE', `/api/v1/book/${OLD}`, { cookie: userCookie });
            expect(del.status, 'DELETE /book passes the gate (the route itself is not mounted here)').to.not.equal(409);
            expect(contents(old)).to.deep.equal(before);
        });
    });
});
