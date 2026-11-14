'use strict';

// Input validation for book storage: ids, archive entries, reset.
// Every refusal case also checks that the disk did not change.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const vbook = require('../src/index');
const lazyPaths = require('../src/lazy-book/paths');
const safe = require('../src/safe-paths');
const { configureBooksRoot, getBooksRoot, isBooksRootConfigured } = require('../src/books-root');

// ── minimal raw zip writer (names are written verbatim) ──────────────────
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data: Buffer|string, mode?: number, deflate?: bool, declaredSize?: number }] */
function rawZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
        const comp = e.deflate ? zlib.deflateRawSync(data) : data;
        const method = e.deflate ? 8 : 0;
        const size = e.declaredSize !== undefined ? e.declaredSize : data.length;
        const crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22);
        lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(((e.mode !== undefined ? e.mode : 0o100644) << 16) >>> 0, 38);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += lh.length + name.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const CH = 'ch-2a7fee78';
const NARRATOR = { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep.' } };
const YURA = { schema: 'animastor.character/1', id: 'yura', name: 'Юра', passport: { appearance: 'tall', clothes: 'coat', video_tokens: ['man'] } };
function validFiles(bookId = 'safety_book_1') {
    const chapter = { chapter_id: CH, scenes: [] };
    return [
        { name: 'manifest.json', data: JSON.stringify({ vbook_version: 4, book_id: bookId, build_id: 'build_' + bookId }) },
        { name: 'book.json', data: JSON.stringify({ book_id: bookId, structure: { chapters_order: [`${CH}.json`] } }) },
        { name: 'behaviour.json', data: JSON.stringify({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] }) },
        { name: 'characters/narrator.json', data: JSON.stringify(NARRATOR) },
        { name: 'characters/yura.json', data: JSON.stringify(YURA) },
        { name: `chapters/${CH}.json`, data: JSON.stringify(chapter) },
    ];
}
const V4_NAMES = ['behaviour.json', 'book.json', `chapters/${CH}.json`, 'characters/narrator.json', 'characters/yura.json', 'manifest.json'];
const build = (entries) => vbook.buildBookFromBundle(vbook.extractBookBundle(rawZip(entries), { log: () => {} }));
function refusal(fn) {
    try { fn(); } catch (err) { return err; }
    return null;
}

function snapshot(root) {
    const out = [];
    (function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            out.push(r);
            if (e.isDirectory()) walk(path.join(d, e.name), r);
        }
    })(root, '');
    return out.sort().join('\n');
}

describe('vbook-runtime input safety', () => {
    let sandbox, books, previousRoot = null;
    before(() => { previousRoot = isBooksRootConfigured() ? getBooksRoot() : null; });
    after(() => { if (previousRoot) configureBooksRoot(previousRoot); });
    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-safety-'));
        books = path.join(sandbox, 'data', 'books');
        fs.mkdirSync(books, { recursive: true });
        fs.mkdirSync(path.join(sandbox, 'data', 'sibling'));
        fs.writeFileSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), 'keep');
        configureBooksRoot(books);
    });
    afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    describe('book id / build id grammar', () => {
        const bad = ['', '.', '..', '../sibling', '../../x', 'a/b', 'a\\b', '/abs', 'x\0y', 'a..b', 'a.b', ' a', '-x', 'x'.repeat(200), null, 42, {}];
        const good = ['master_margarita_demo', 'ba_1788172242081', 'import_1786345731767_1786345734345', 'мастер_и_маргарита_1786', 'ov2mwe2j41r-b043af-legacy', 'B1'];

        for (const id of bad) {
            it(`rejects book id ${JSON.stringify(id)}`, () => {
                expect(safe.isValidBookId(id)).to.equal(false);
                expect(() => vbook.getBookDir(id)).to.throw(/invalid book id/);
                expect(() => lazyPaths.getBookDir(id)).to.throw(/invalid book id/);
            });
        }
        for (const id of good) {
            it(`accepts book id ${id}`, () => {
                expect(safe.isValidBookId(id)).to.equal(true);
                expect(vbook.getBookDir(id)).to.equal(path.join(books, id));
            });
        }
        it('build ids: accepts historical forms, rejects invalid forms', () => {
            for (const id of ['default', 'demo_static_007', 'build_ba_1788172242081', 'v1.2']) expect(safe.isValidBuildId(id)).to.equal(true);
            for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a..b', '/x']) expect(safe.isValidBuildId(id)).to.equal(false);
        });
        it('assertInside / joinInside refuse paths outside the root', () => {
            expect(() => safe.assertInside(books, path.join(books, '..', 'sibling'))).to.throw(/outside/);
            expect(() => safe.joinInside(books, '..')).to.throw(/outside/);
            expect(() => safe.joinInside(books, '.')).to.throw(/outside/);
            expect(safe.joinInside(books, 'a', 'b.json')).to.equal(path.join(books, 'a', 'b.json'));
        });
        it('loadBook returns null for an invalid id without touching disk', () => {
            expect(vbook.loadBook('..')).to.equal(null);
            expect(vbook.loadBook('../sibling')).to.equal(null);
        });
    });

    describe('archive refusal (disk unchanged)', () => {
        const cases = {
            'entry with ".."': { name: '../../outside.txt', data: 'E' },
            'absolute entry': { name: '/tmp/vbook-safety-abs.txt', data: 'E' },
            'backslash entry': { name: '..\\..\\outside.txt', data: 'E' },
            'control character': { name: 'bad\u0001.json', data: 'E' },
            'link entry': { name: 'manifest-link.json', data: '../../sibling/keep.txt', mode: 0o120777 },
            'dot segment': { name: 'chapters/./x.json', data: 'E' },
        };
        for (const [label, evil] of Object.entries(cases)) {
            it(`refuses ${label}`, () => {
                const before = snapshot(sandbox);
                const buf = rawZip([...validFiles(), evil]);
                expect(() => vbook.extractBookBundle(buf, { log: () => {} })).to.throw(/invalid|link/);
                expect(snapshot(sandbox)).to.equal(before);
                expect(fs.existsSync('/tmp/vbook-safety-abs.txt')).to.equal(false);
            });
        }
        it('refuses manifest.book_id forms that are not ids', () => {
            for (const id of ['..', '../sibling', 'a/b', '/abs', 'a\\b']) {
                const files = validFiles(id);
                const extracted = vbook.extractBookBundle(rawZip(files), { log: () => {} });
                const before = snapshot(sandbox);
                expect(() => vbook.buildBookFromBundle(extracted)).to.throw(/invalid book id/);
                expect(snapshot(sandbox)).to.equal(before);
            }
        });
        it('refuses manifest.build_id outside the grammar', () => {
            const files = validFiles();
            files[0].data = JSON.stringify({ vbook_version: 4, book_id: 'safety_book_1', build_id: '../../x' });
            const extracted = vbook.extractBookBundle(rawZip(files), { log: () => {} });
            expect(() => vbook.buildBookFromBundle(extracted)).to.throw(/invalid build id/);
        });
        it('refuses chapters_order entries that are not chapter files', () => {
            const files = validFiles();
            files[1].data = JSON.stringify({ structure: { chapters_order: ['../../sibling/keep.txt'] } });
            const extracted = vbook.extractBookBundle(rawZip(files), { log: () => {} });
            expect(() => vbook.buildBookFromBundle(extracted)).to.throw(/chapter file name/);
        });
        it('skips non-format entries (never written)', () => {
            const logs = [];
            const files = vbook.extractBookBundle(rawZip([...validFiles(), { name: 'README.txt', data: 'x' }, { name: 'extra/evil.js', data: 'x' }]), { log: (m) => logs.push(m) });
            expect(Object.keys(files).sort()).to.deep.equal(V4_NAMES);
            expect(logs.join(' ')).to.match(/2 archive entries/).and.not.match(/evil|README/);
        });
        it('refuses too many entries and oversized entries (declared and actual)', () => {
            const limits = { maxEntries: 8, maxEntryBytes: 1024, maxTotalBytes: 4096 };
            const many = Array.from({ length: 9 }, (_, i) => ({ name: `chapters/ch-${String(i).padStart(8, 'a')}.json`, data: '{}' }));
            expect(() => vbook.extractBookBundle(rawZip(many), { limits })).to.throw(/too many/);
            const big = rawZip([...validFiles(), { name: 'source.txt', data: 'x'.repeat(5000) }]);
            expect(() => vbook.extractBookBundle(big, { limits, log: () => {} })).to.throw(/too large/);
            // header lies about the size: real inflate is capped
            const liar = rawZip([...validFiles(), { name: 'source.txt', data: 'y'.repeat(200000), deflate: true, declaredSize: 10 }]);
            expect(() => vbook.extractBookBundle(liar, { limits, log: () => {} })).to.throw(/too large/);
        });
        it('refuses garbage that is not an archive', () => {
            expect(() => vbook.extractBookBundle(Buffer.from('PK\u0003\u0004 not really'))).to.throw(/invalid archive/);
        });
    });

    // ── VBook 4 (VBOOK_FORMAT_V4 §3, §9, §10.3) ──────────────────────────
    describe('VBook 4 archive rules (disk unchanged after every refusal)', () => {
        it('a healthy v4 archive builds the model with heroes and no 3.1 maps', () => {
            const book = build(validFiles());
            expect(Object.keys(book).sort()).to.deep.equal(['behaviour', 'bible', 'book', 'chapters', 'hero_issues', 'heroes', 'locations', 'manifest']);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
            expect(book.hero_issues).to.deep.equal([]);
        });

        it('manifest.json under a prefix folder → MANIFEST_NOT_IN_ROOT', () => {
            const before = snapshot(sandbox);
            const prefixed = validFiles().map((e) => ({ ...e, name: `import_1700000000/${e.name}` }));
            const err = refusal(() => vbook.extractBookBundle(rawZip(prefixed), { log: () => {} }));
            expect(err && err.code).to.equal('MANIFEST_NOT_IN_ROOT');
            expect(err.status).to.equal(400);
            // nothing is searched by suffix either: notebook.json is not book.json
            const fake = [{ name: 'x/manifest.json', data: '{}' }, { name: 'notebook.json', data: '{}' }, { name: 'characters/book.json', data: '{}' }];
            expect(refusal(() => vbook.extractBookBundle(rawZip(fake), { log: () => {} })).code).to.equal('MANIFEST_NOT_IN_ROOT');
            expect(refusal(() => vbook.buildBookFromBundle({ 'import_1/manifest.json': '{}' })).code).to.equal('MANIFEST_NOT_IN_ROOT');
            expect(snapshot(sandbox)).to.equal(before);
        });

        it('book.json and chapters are taken by exact path only', () => {
            const noBook = validFiles().filter((e) => e.name !== 'book.json').concat({ name: 'notebook.json', data: '{}' }, { name: 'x/book.json', data: '{}' });
            expect(() => build(noBook)).to.throw(/book\.json not found/);
            const rootChapter = validFiles().map((e) => (e.name.startsWith('chapters/') ? { ...e, name: `${CH}.json` } : e));
            expect(() => build(rootChapter)).to.throw(/Missing chapter file/);
            const prefixedOrder = validFiles();
            prefixedOrder[1].data = JSON.stringify({ structure: { chapters_order: [`chapters/${CH}.json`] } });
            expect(() => build(prefixedOrder)).to.throw(/chapter file name/);
        });

        for (const version of ['3.1', '3.0', 3, '', null, undefined, '5', 5, '4a', 4.5, [4], { v: 4 }]) {
            it(`vbook_version ${JSON.stringify(version)} → UNSUPPORTED_VBOOK_VERSION`, () => {
                const before = snapshot(sandbox);
                const files = validFiles();
                const manifest = { book_id: 'safety_book_1', build_id: 'build_safety_book_1' };
                if (version !== undefined) manifest.vbook_version = version;
                files[0].data = JSON.stringify(manifest);
                const err = refusal(() => build(files));
                expect(err && err.code).to.equal('UNSUPPORTED_VBOOK_VERSION');
                expect(err.supported).to.equal(4);
                expect(snapshot(sandbox)).to.equal(before);
            });
        }
        for (const version of [4, '4', '4.0', '4.12']) {
            it(`vbook_version ${JSON.stringify(version)} is readable`, () => {
                const files = validFiles();
                files[0].data = JSON.stringify({ vbook_version: version, book_id: 'safety_book_1' });
                expect(build(files).manifest.vbook_version).to.equal(version);
            });
        }

        it('3.1 files inside a v4 archive are outside the whitelist: skipped, never on disk', () => {
            const logs = [];
            const legacy = [
                { name: 'characters.json', data: '[{"id":"evil"}]' }, { name: 'voices.json', data: '{"evil":{}}' },
                { name: 'behavior.json', data: '{}' }, { name: 'mentions.json', data: '{}' },
                { name: `${CH}.json`, data: '{}' }, { name: 'cover.json', data: '{}' },
                { name: 'voices/yura/ref.wav', data: 'RIFF' }, { name: 'characters/.DS_Store', data: 'x' },
            ];
            const files = vbook.extractBookBundle(rawZip([...validFiles(), ...legacy]), { log: (m) => logs.push(m) });
            expect(Object.keys(files).sort()).to.deep.equal(V4_NAMES);
            expect(logs.join(' ')).to.match(/8 archive entries/);
            const book = vbook.buildBookFromBundle(files);
            vbook.saveBookBundle(book);
            expect(snapshot(path.join(books, 'safety_book_1'))).to.equal(
                ['behaviour.json', 'book.json', 'chapters', `chapters/${CH}.json`, 'characters', 'characters/narrator.json', 'characters/yura.json', 'manifest.json'].join('\n'));
        });

        const badHeroEntries = {
            'Cyrillic file name': { name: 'characters/Юра.json', data: JSON.stringify({ ...YURA, id: 'Юра' }) },
            'upper-case file name': { name: 'characters/Anna.json', data: JSON.stringify({ ...YURA, id: 'anna' }) },
            'reserved id': { name: 'characters/book.json', data: JSON.stringify({ ...YURA, id: 'book' }) },
            'nested folder': { name: 'characters/sub/anna.json', data: JSON.stringify({ ...YURA, id: 'anna' }) },
            'not a json file': { name: 'characters/anna.txt', data: 'x' },
            'over-long id': { name: `characters/${'a'.repeat(65)}.json`, data: '{}' },
        };
        for (const [label, entry] of Object.entries(badHeroEntries)) {
            it(`hero entry with a bad id (${label}) → HERO_FILE_BROKEN 422`, () => {
                const before = snapshot(sandbox);
                const err = refusal(() => vbook.extractBookBundle(rawZip([...validFiles(), entry]), { log: () => {} }));
                expect(err && err.code).to.equal('HERO_FILE_BROKEN');
                expect(err.status).to.equal(422);
                expect(err.issues.map((i) => i.file)).to.deep.equal([entry.name]);
                expect(snapshot(sandbox)).to.equal(before);
            });
        }

        it('two entries that differ only by case are a duplicate: the whole archive is refused', () => {
            const err = refusal(() => vbook.extractBookBundle(rawZip([...validFiles(), { name: 'characters/Yura.json', data: JSON.stringify(YURA) }]), { log: () => {} }));
            expect(err && err.code).to.equal('INVALID_ARCHIVE_ENTRY');
        });

        it('characters/../x.json is an unsafe name: the whole archive is refused', () => {
            const before = snapshot(sandbox);
            for (const name of ['characters/../x.json', 'characters/../../sibling/keep.txt', 'characters/..\\x.json', 'characters//x.json']) {
                const err = refusal(() => vbook.extractBookBundle(rawZip([...validFiles(), { name, data: JSON.stringify(YURA) }]), { log: () => {} }));
                expect(err && err.code, name).to.equal('INVALID_ARCHIVE_ENTRY');
            }
            expect(snapshot(sandbox)).to.equal(before);
        });

        const brokenHeroContent = {
            'not JSON': ['{oops', 'invalid_json'],
            'inner id differs from the file name': [JSON.stringify({ ...YURA, id: 'anna' }), 'filename_mismatch'],
            'bad inner id': [JSON.stringify({ ...YURA, id: '../x' }), 'schema'],
            'no schema marker': [JSON.stringify({ id: 'yura' }), 'schema'],
            'reference.file with ".."': [JSON.stringify({ ...YURA, voice: { reference: { file: 'voices/yura/../../../etc/passwd.wav', sha256: 'a'.repeat(64) } } }), 'schema'],
            'reference.file with ".." inside the name': [JSON.stringify({ ...YURA, voice: { reference: { file: 'voices/yura/a..b.wav', sha256: 'a'.repeat(64) } } }), 'schema'],
            'absolute reference.file': [JSON.stringify({ ...YURA, voice: { reference: { file: '/etc/passwd.wav', sha256: 'a'.repeat(64) } } }), 'schema'],
            'reference.file with a backslash': [JSON.stringify({ ...YURA, voice: { reference: { file: 'voices\\yura\\ref.wav', sha256: 'a'.repeat(64) } } }), 'schema'],
            'reference.file in another hero\'s folder': [JSON.stringify({ ...YURA, voice: { reference: { file: 'voices/narrator/ref.wav', sha256: 'a'.repeat(64) } } }), 'schema'],
            'image_refs outside refs/images/<id>/': [JSON.stringify({ ...YURA, image_refs: [{ file: 'refs/images/anna/p.png', sha256: 'a'.repeat(64) }] }), 'schema'],
        };
        for (const [label, [data, code]] of Object.entries(brokenHeroContent)) {
            it(`broken hero file (${label}) → HERO_FILE_BROKEN 422 with the file listed`, () => {
                const before = snapshot(sandbox);
                const files = validFiles().map((e) => (e.name === 'characters/yura.json' ? { ...e, data } : e));
                const err = refusal(() => build(files));
                expect(err && err.code).to.equal('HERO_FILE_BROKEN');
                expect(err.status).to.equal(422);
                expect(err.issues.map((i) => [i.file, i.code])).to.deep.equal([['characters/yura.json', code]]);
                expect(snapshot(sandbox)).to.equal(before);
            });
        }

        it('a 3.1 archive is told "unsupported version" even when it also carries a bad hero entry', () => {
            const files = validFiles();
            files[0].data = JSON.stringify({ vbook_version: '3.1', book_id: 'safety_book_1' });
            files.push({ name: 'characters/Юра.json', data: '{}' });
            expect(refusal(() => vbook.extractBookBundle(rawZip(files), { log: () => {} })).code).to.equal('UNSUPPORTED_VBOOK_VERSION');
        });

        it('a broken behaviour.json refuses the archive', () => {
            const files = validFiles().map((e) => (e.name === 'behaviour.json' ? { ...e, data: JSON.stringify({ rules: [{ id: 'r', scope: 'global' }] }) } : e));
            expect(refusal(() => build(files)).code).to.equal('INVALID_BUNDLE');
        });
    });

    describe('saveBookBundle writes the object only', () => {
        it('the raw-files mode is gone: a files map is refused and nothing is written', () => {
            const book = build(validFiles());
            const before = snapshot(sandbox);
            const files = { 'manifest.json': '{}', '../../outside.txt': 'E' };
            expect(() => vbook.saveBookBundle(book, files)).to.throw(/saves the book object only/);
            expect(fs.existsSync(path.join(sandbox, 'data', 'outside.txt'))).to.equal(false);
            expect(snapshot(sandbox)).to.equal(before);
        });
        it('does not write through a link inside the book dir', () => {
            const book = build(validFiles());
            const dir = path.join(books, 'safety_book_1');
            const keep = path.join(sandbox, 'data', 'sibling', 'keep.txt');
            for (const name of ['manifest.json', 'book.json', 'behaviour.json']) {
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir);
                fs.symlinkSync(keep, path.join(dir, name));
                expect(() => vbook.saveBookBundle(book), name).to.throw();
                expect(fs.readFileSync(keep, 'utf8')).to.equal('keep');
            }
            for (const name of ['characters', 'chapters']) {
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir);
                fs.symlinkSync(path.join(sandbox, 'data', 'sibling'), path.join(dir, name));
                expect(() => vbook.saveBookBundle(book), name).to.throw();
                expect(fs.readdirSync(path.join(sandbox, 'data', 'sibling'))).to.deep.equal(['keep.txt']);
            }
        });
        it('a book that is not VBook 4, or still carries a 3.1 map, is refused before the first write', () => {
            const book = build(validFiles());
            const before = snapshot(sandbox);
            expect(refusal(() => vbook.saveBookBundle({ ...book, manifest: { ...book.manifest, vbook_version: '3.1' } })).code).to.equal('UNSUPPORTED_VBOOK_VERSION');
            for (const key of ['characters', 'voices', 'behaviors', 'mentions']) {
                expect(() => vbook.saveBookBundle({ ...book, [key]: {} }), key).to.throw(/not part of VBook 4/);
            }
            const badHero = { ...YURA, id: '../x' };
            expect(() => vbook.saveBookBundle({ ...book, heroes: [badHero] })).to.throw(/invalid hero id/);
            expect(() => vbook.saveBookBundle({ ...book, heroes: [NARRATOR, YURA, YURA] })).to.throw(/duplicate hero id/);
            expect(() => vbook.saveBookBundle({ ...book, heroes: [{ ...YURA, voice: { reference: { file: 'voices/yura/../x.wav', sha256: 'a'.repeat(64) } } }] })).to.throw(/voice\.reference\.file/);
            expect(snapshot(sandbox)).to.equal(before);
        });
    });

    describe('resetBook', () => {
        it('refuses ids that leave the books root; nothing removed', async () => {
            const before = snapshot(sandbox);
            for (const id of ['..', '../sibling', '../..', 'a/b']) {
                let err = null;
                try { await vbook.resetBook(id); } catch (e) { err = e; }
                expect(err, id).to.be.an('error');
            }
            expect(snapshot(sandbox)).to.equal(before);
        });
        it('refuses a non-book directory inside the root', async () => {
            fs.mkdirSync(path.join(books, 'not_a_book'));
            fs.writeFileSync(path.join(books, 'not_a_book', 'data.bin'), 'x');
            let err = null;
            try { await vbook.resetBook('not_a_book'); } catch (e) { err = e; }
            expect(err && err.code).to.equal('NOT_A_BOOK_DIR');
            expect(fs.existsSync(path.join(books, 'not_a_book', 'data.bin'))).to.equal(true);
        });
        it('refuses a link named like a book', async () => {
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling'), path.join(books, 'linked_book'));
            let err = null;
            try { await vbook.resetBook('linked_book'); } catch (e) { err = e; }
            expect(err && err.code).to.equal('PATH_IS_LINK');
            expect(fs.existsSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'))).to.equal(true);
        });
        it('removes a real book directory', async () => {
            vbook.saveBookBundle(build(validFiles()));
            expect(fs.existsSync(path.join(books, 'safety_book_1', 'manifest.json'))).to.equal(true);
            await vbook.resetBook('safety_book_1');
            expect(fs.existsSync(path.join(books, 'safety_book_1'))).to.equal(false);
        });
    });

    describe('export', () => {
        it('exports the format whitelist only — stray files, links and build output never leave the server', () => {
            const AdmZip = require('adm-zip');
            vbook.saveBookBundle(build(validFiles()));
            const dir = path.join(books, 'safety_book_1');
            fs.writeFileSync(path.join(dir, 'characters.json'), '[{"id":"legacy"}]');
            fs.writeFileSync(path.join(dir, 'voices.json'), '{}');
            fs.writeFileSync(path.join(dir, 'secrets.env'), 'TOKEN=x');
            fs.writeFileSync(path.join(dir, 'characters', '.yura.json.tmp-1-ab'), '{');
            fs.mkdirSync(path.join(dir, 'voices', 'yura'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'voices', 'yura', 'ref.wav'), 'RIFF');
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling'), path.join(dir, 'link'));
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), path.join(dir, 'source.txt'));
            const out = vbook.exportBookBundle('safety_book_1');
            const names = new AdmZip(out.buffer).getEntries().map((e) => e.entryName).sort();
            expect(names).to.deep.equal(V4_NAMES);
            expect(out.files.slice().sort()).to.deep.equal(V4_NAMES);
            expect(vbook.exportBookBundle('no_such_book')).to.equal(null);
        });
    });

    describe('MiM.vbook (VBook 3.1) is refused', () => {
        const mim = path.resolve(__dirname, '../../../MiM.vbook');
        (fs.existsSync(mim) ? it : it.skip)('extract → build fails with UNSUPPORTED_VBOOK_VERSION 3.1, disk unchanged', () => {
            const before = snapshot(sandbox);
            const err = refusal(() => vbook.buildBookFromBundle(vbook.extractBookBundle(fs.readFileSync(mim), { log: () => {} })));
            expect(err && err.code).to.equal('UNSUPPORTED_VBOOK_VERSION');
            expect(err.vbookVersion).to.equal('3.1');
            expect(vbook.vbookVersion.unsupportedVersionBody(err, 'en')).to.include({ error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4 });
            expect(snapshot(sandbox)).to.equal(before);
        });
    });
});
