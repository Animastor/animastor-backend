// ======================================================
// Bootstrap idempotency — one chapter file per chapter_index
// ======================================================
// ba_1795695606197 (2026-11-26): two bootstrap runs of the same book each
// called createFromAnalysis → two «Пролог» files with chapter_index 0 and
// random ids, both in chapters_order. The first window now reuses the chapter
// with its chapter_index and replaces its scenes; chapters_order refuses two
// files with one chapter_index.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lazyBook = require('../src/lazy-book');
const chapterUtils = require('../src/lazy-book/chapter-utils');
const { configureBooksRoot, getBooksRoot, isBooksRootConfigured } = require('../src/books-root');

const SOURCE = 'Пролог. Мир на переломе эпох\n\nЮра вошёл в комнату.\n\nГлава 1. Земля\n\nАнна ждала.\n';

function windowZero(tag) {
    return {
        structure: {
            title: 'BA', author: null,
            chapters: [
                { type: 'prologue', label: 'Пролог', title: 'Мир на переломе эпох', number: null },
                { type: 'chapter', number: 1, title: 'Земля' },
            ],
        },
        characters: [{ id: 'yura', name: 'Юра', appearance: 'man', clothes: 'jacket' }],
        locations: [],
        scenes: [{
            title: `Комната ${tag}`,
            text: 'Юра вошёл в комнату.',
            source_start: 30, source_end: 52,
            units: [{ type: 'perception', text: 'Юра вошёл в комнату.' }],
        }],
    };
}

describe('bootstrap idempotency (one chapter per chapter_index)', () => {
    let sandbox, books, previousRoot = null;
    before(() => { previousRoot = isBooksRootConfigured() ? getBooksRoot() : null; });
    after(() => { if (previousRoot) configureBooksRoot(previousRoot); });
    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-idem-'));
        books = path.join(sandbox, 'books');
        fs.mkdirSync(books);
        configureBooksRoot(books);
    });
    afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    const chDir = (bookId) => path.join(books, bookId, 'chapters');
    const nonCover = (bookId) => chapterUtils.readChapterFiles(chDir(bookId)).filter(e => e.ch && e.ch.type !== 'cover');
    const bookJson = (bookId) => JSON.parse(fs.readFileSync(path.join(books, bookId, 'book.json'), 'utf8'));

    it('two createFromAnalysis calls on one book → one chapter-0 file, same chapter_id', () => {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'BA.txt');
        const first = lazyBook.createFromAnalysis(bookId, windowZero('A'));
        const second = lazyBook.createFromAnalysis(bookId, windowZero('B'));

        const files = nonCover(bookId);
        expect(files).to.have.length(1);
        expect(files[0].ch.chapter_index).to.equal(0);
        expect(second.chapter.chapter_id).to.equal(first.chapter.chapter_id);

        // scenes of the window are REPLACED, not appended: intro + 1 narration
        const narration = files[0].ch.scenes.filter(s => s.type !== 'chapter_intro');
        expect(narration.map(s => s.scene_title)).to.deep.equal(['Комната B']);
        expect(files[0].ch.scenes.filter(s => s.type === 'chapter_intro')).to.have.length(1);

        // chapters_order: cover + one prologue, no duplicates
        const order = bookJson(bookId).structure.chapters_order;
        expect(order).to.have.length(new Set(order).size);
        expect(order.filter(f => f === `${first.chapter.chapter_id}.json`)).to.have.length(1);
        expect(order.length).to.equal(chapterUtils.readChapterFiles(chDir(bookId)).length);
    });

    it('two files with one chapter_index → clear error, nothing rewritten', () => {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'BA.txt');
        const first = lazyBook.createFromAnalysis(bookId, windowZero('A'));
        // Reproduce the broken state of ba_1795695606197: a second chapter-0 file.
        const dupe = { ...first.chapter, chapter_id: 'ch-deadbeef' };
        fs.writeFileSync(path.join(chDir(bookId), 'ch-deadbeef.json'), JSON.stringify(dupe));
        const orderBefore = bookJson(bookId).structure.chapters_order;

        expect(() => lazyBook.createFromAnalysis(bookId, windowZero('B')))
            .to.throw(chapterUtils.DuplicateChapterIndexError, /chapter_index=0.*ch-deadbeef\.json/);
        expect(() => chapterUtils.buildChaptersOrder(chDir(bookId)))
            .to.throw(/два файла главы с chapter_index=0/);
        expect(bookJson(bookId).structure.chapters_order).to.deep.equal(orderBefore);
    });

    it('appendToBook into the same chapter_index still appends (window 2 of a long chapter)', () => {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'BA.txt');
        const first = lazyBook.createFromAnalysis(bookId, windowZero('A'));
        const second = lazyBook.appendToBook(bookId, windowZero('C'), { chapterIndex: 0 });
        expect(second.chapter.chapter_id).to.equal(first.chapter.chapter_id);
        const narration = nonCover(bookId)[0].ch.scenes.filter(s => s.type !== 'chapter_intro');
        expect(narration.map(s => s.scene_title)).to.deep.equal(['Комната A', 'Комната C']);
    });
});
