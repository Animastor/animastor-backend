'use strict';

// Scoped removal of a book's artifacts (services/book-artifacts.cjs).

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeBookArtifacts, ownerOf } = require('../src/services/book-artifacts.cjs');

describe('book artifacts — scoped removal', () => {
    let root, books, out;
    const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'book-artifacts-'));
        books = path.join(root, 'books'); out = path.join(root, 'output');
        for (const id of ['ba', 'ba_1788', 'other_book']) fs.mkdirSync(path.join(books, id), { recursive: true });
        fs.mkdirSync(out, { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('owner is the longest book-id prefix', () => {
        const ids = new Set(['ba', 'ba_1788']);
        expect(ownerOf('ba_ch-1_sc-1.mp3', ids)).to.equal('ba');
        expect(ownerOf('ba_1788_ch-1_sc-1.mp3', ids)).to.equal('ba_1788');
        expect(ownerOf('build_ba', ids)).to.equal(null);
    });

    it('removes the book’s own build dir entirely', () => {
        touch(path.join(out, 'build_ba', 'ba_ch-1_sc-1.mp3'));
        touch(path.join(out, 'build_ba', '.incoming', 'x'));
        removeBookArtifacts({ outputDir: out, booksDir: books, bookId: 'ba', buildIds: ['build_ba'] });
        expect(fs.existsSync(path.join(out, 'build_ba'))).to.equal(false);
    });

    it('never removes another book’s files from a shared build dir', () => {
        touch(path.join(out, 'build_ba_1788', 'ba_1788_ch-1_sc-1.mp3'));
        touch(path.join(out, 'build_ba_1788', 'ba_ch-9_sc-9.mp3'));
        // book "ba" claims the other book's build id
        removeBookArtifacts({ outputDir: out, booksDir: books, bookId: 'ba', buildIds: ['build_ba_1788'] });
        expect(fs.existsSync(path.join(out, 'build_ba_1788', 'ba_1788_ch-1_sc-1.mp3'))).to.equal(true);
        expect(fs.existsSync(path.join(out, 'build_ba_1788', 'ba_ch-9_sc-9.mp3'))).to.equal(false);
    });

    it('ignores build ids outside the grammar or the root', () => {
        touch(path.join(root, 'keep.txt'));
        touch(path.join(books, 'other_book', 'manifest.json'));
        for (const b of ['..', '../books', '../..', 'a/b', '.']) {
            removeBookArtifacts({ outputDir: out, booksDir: books, bookId: 'ba', buildIds: [b] });
        }
        expect(fs.existsSync(path.join(root, 'keep.txt'))).to.equal(true);
        expect(fs.existsSync(path.join(books, 'other_book', 'manifest.json'))).to.equal(true);
    });

    it('a short book id does not remove other build dirs or other books’ root files', () => {
        touch(path.join(out, 'build_ba_1788', 'ba_1788_ch-1_sc-1.mp3'));
        touch(path.join(out, 'ba_1788_ch-1_sc-1.mp3'));
        touch(path.join(out, 'ba_ch-2_sc-2.mp3'));
        fs.mkdirSync(path.join(books, 'b'));
        removeBookArtifacts({ outputDir: out, booksDir: books, bookId: 'b', buildIds: [] });
        removeBookArtifacts({ outputDir: out, booksDir: books, bookId: 'ba', buildIds: [] });
        expect(fs.existsSync(path.join(out, 'build_ba_1788', 'ba_1788_ch-1_sc-1.mp3'))).to.equal(true);
        expect(fs.existsSync(path.join(out, 'ba_1788_ch-1_sc-1.mp3'))).to.equal(true);
        expect(fs.existsSync(path.join(out, 'ba_ch-2_sc-2.mp3'))).to.equal(false);
    });

    it('invalid book id → nothing removed', () => {
        touch(path.join(out, 'build_x', 'f'));
        const r = removeBookArtifacts({ outputDir: out, booksDir: books, bookId: '..', buildIds: ['build_x'] });
        expect(r.removedDirs).to.equal(0);
        expect(fs.existsSync(path.join(out, 'build_x', 'f'))).to.equal(true);
    });
});
