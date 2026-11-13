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
function validFiles(bookId = 'safety_book_1') {
    const chapter = { chapter_id: CH, scenes: [] };
    return [
        { name: 'manifest.json', data: JSON.stringify({ vbook_version: '3.1', book_id: bookId, build_id: 'build_' + bookId }) },
        { name: 'book.json', data: JSON.stringify({ book_id: bookId, structure: { chapters_order: [`${CH}.json`] } }) },
        { name: `chapters/${CH}.json`, data: JSON.stringify(chapter) },
    ];
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
            files[0].data = JSON.stringify({ book_id: 'safety_book_1', build_id: '../../x' });
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
            expect(Object.keys(files).sort()).to.deep.equal(['book.json', `chapters/${CH}.json`, 'manifest.json']);
            expect(logs.join(' ')).to.match(/2 archive entries/).and.not.match(/evil|README/);
        });
        it('refuses too many entries and oversized entries (declared and actual)', () => {
            const limits = { maxEntries: 5, maxEntryBytes: 1024, maxTotalBytes: 4096 };
            const many = Array.from({ length: 6 }, (_, i) => ({ name: `ch-${String(i).padStart(8, 'a')}.json`, data: '{}' }));
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

    describe('saveBookBundle raw mode', () => {
        it('refuses a files map with an escaping name and writes nothing', () => {
            const book = vbook.buildBookFromBundle(vbook.extractBookBundle(rawZip(validFiles()), { log: () => {} }));
            const before = snapshot(sandbox);
            const files = { 'manifest.json': '{}', '../../outside.txt': 'E' };
            expect(() => vbook.saveBookBundle(book, files)).to.throw(/invalid entry/);
            expect(fs.existsSync(path.join(sandbox, 'data', 'outside.txt'))).to.equal(false);
            // the book dir may have been created empty before validation; nothing else
            const after = snapshot(sandbox).split('\n').filter((l) => !l.startsWith('data/books/safety_book_1'));
            expect(after.join('\n')).to.equal(before);
        });
        it('does not write through a link inside the book dir', () => {
            const book = vbook.buildBookFromBundle(vbook.extractBookBundle(rawZip(validFiles()), { log: () => {} }));
            const dir = path.join(books, 'safety_book_1');
            fs.mkdirSync(dir);
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), path.join(dir, 'bible.json'));
            expect(() => vbook.saveBookBundle(book, { 'bible.json': 'overwritten' })).to.throw(/linked path/);
            expect(fs.readFileSync(path.join(sandbox, 'data', 'sibling', 'keep.txt'), 'utf8')).to.equal('keep');
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
            const book = vbook.buildBookFromBundle(vbook.extractBookBundle(rawZip(validFiles()), { log: () => {} }));
            vbook.saveBookBundle(book, vbook.extractBookBundle(rawZip(validFiles()), { log: () => {} }));
            expect(fs.existsSync(path.join(books, 'safety_book_1', 'manifest.json'))).to.equal(true);
            await vbook.resetBook('safety_book_1');
            expect(fs.existsSync(path.join(books, 'safety_book_1'))).to.equal(false);
        });
    });

    describe('export', () => {
        it('addDirToZip skips links', () => {
            const AdmZip = require('adm-zip');
            const dir = path.join(books, 'exp_book');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
            fs.symlinkSync(path.join(sandbox, 'data', 'sibling'), path.join(dir, 'link'));
            const zip = new AdmZip();
            vbook.addDirToZip(zip, dir, '');
            expect(zip.getEntries().map((e) => e.entryName)).to.deep.equal(['manifest.json']);
        });
    });

    describe('MiM.vbook still imports', () => {
        const mim = path.resolve(__dirname, '../../../MiM.vbook');
        (fs.existsSync(mim) ? it : it.skip)('extract → build → save → load', () => {
            const files = vbook.extractBookBundle(fs.readFileSync(mim));
            const book = vbook.buildBookFromBundle(files);
            expect(book.manifest.book_id).to.equal('master_margarita_demo');
            vbook.saveBookBundle(book, files);
            const loaded = vbook.loadBook('master_margarita_demo');
            expect(loaded.chapters).to.have.length(3);
            expect(fs.readdirSync(path.join(books, 'master_margarita_demo')).sort())
                .to.deep.equal(['bible.json', 'book.json', 'chapters', 'characters.json', 'locations.json', 'manifest.json', 'voices.json']);
        });
    });
});
