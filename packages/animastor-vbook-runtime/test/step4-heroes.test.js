// ======================================================
// VBook 4 step 4 — what the runtime adds for the hero API
// ======================================================
//   - removeCharacterEntry: a broken file by its name (owner's decision В14)
//   - possible duplicates of the analysis: kept in book.json, shown as
//     non-blocking hero_issues (owner's decision 18.11)
//   - unknown scene participants: non-blocking hero_issues (owner, 18.11)
//   - voice.reference.source_timbre_sha256 and isReferenceOutdated (owner, 18.11)

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const vbook = require('../src/index');
const lazyBook = require('../src/lazy-book');
const store = require('../src/character-store.cjs');
const heroes = require('../src/heroes.cjs');
const voice = require('../src/voice');
const { validateCharacterFile } = require('../src/bundle-validator.cjs');
const { configureBooksRoot, getBooksRoot, isBooksRootConfigured } = require('../src/books-root');

const SHA = 'a'.repeat(64);
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('VBook 4 step 4 — runtime', () => {
    let sandbox;
    let previousRoot = null;
    before(() => { previousRoot = isBooksRootConfigured() ? getBooksRoot() : null; });
    after(() => { if (previousRoot) configureBooksRoot(previousRoot); });
    beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-step4-')); });
    afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    describe('removeCharacterEntry (В14)', () => {
        let bookDir;
        beforeEach(() => {
            bookDir = path.join(sandbox, 'b');
            fs.mkdirSync(path.join(bookDir, 'characters'), { recursive: true });
        });
        it('deletes one plain entry of characters/ — any Unicode name', () => {
            fs.writeFileSync(path.join(bookDir, 'characters', 'Юра.json'), '{}');
            expect(store.removeCharacterEntry(bookDir, 'Юра.json')).to.equal(true);
            expect(fs.existsSync(path.join(bookDir, 'characters', 'Юра.json'))).to.equal(false);
            expect(store.removeCharacterEntry(bookDir, 'Юра.json')).to.equal(false);
        });
        it('refuses separators, "..", NUL, dot files — invalid_file_name; never leaves characters/', () => {
            fs.writeFileSync(path.join(bookDir, 'book.json'), '{}');
            for (const bad of ['../book.json', '..', '.', 'a/b.json', 'a\\b.json', '.tmp', '', 'x\u0000.json', 'x'.repeat(256), null, 7]) {
                let code = null;
                try { store.removeCharacterEntry(bookDir, bad); } catch (err) { code = err.code; }
                expect(code, JSON.stringify(bad)).to.equal('invalid_file_name');
            }
            expect(fs.existsSync(path.join(bookDir, 'book.json'))).to.equal(true);
        });
        it('a symbolic link goes as a link (its target stays); a directory is refused', () => {
            const target = path.join(sandbox, 'target.json');
            fs.writeFileSync(target, 'T');
            fs.symlinkSync(target, path.join(bookDir, 'characters', 'link.json'));
            expect(store.removeCharacterEntry(bookDir, 'link.json')).to.equal(true);
            expect(fs.readFileSync(target, 'utf8')).to.equal('T');
            fs.mkdirSync(path.join(bookDir, 'characters', 'dir.json'));
            expect(() => store.removeCharacterEntry(bookDir, 'dir.json')).to.throw().with.property('code', 'path_is_link');
        });
        it('a characters/ that is a link is refused', () => {
            const other = path.join(sandbox, 'other');
            fs.mkdirSync(other);
            fs.writeFileSync(path.join(other, 'x.json'), '{}');
            fs.rmSync(path.join(bookDir, 'characters'), { recursive: true });
            fs.symlinkSync(other, path.join(bookDir, 'characters'));
            expect(() => store.removeCharacterEntry(bookDir, 'x.json')).to.throw().with.property('code', 'path_is_link');
            expect(fs.existsSync(path.join(other, 'x.json'))).to.equal(true);
        });
    });

    describe('possible duplicates (book.json analysis.possible_duplicates → hero_issues)', () => {
        const H = (id) => ({ schema: 'animastor.character/1', id, name: id });
        it('addPossibleDuplicates keeps a pair once, unites evidence, drops bad ids', () => {
            const meta = {};
            expect(heroes.addPossibleDuplicates(meta, [{ hero_id: 'koroviev', of: 'voland', evidence: ['клетчатый'] }, { hero_id: 'Bad Id', of: 'voland' }, { hero_id: 'x', of: 'x' }])).to.equal(1);
            expect(heroes.addPossibleDuplicates(meta, [{ hero_id: 'koroviev', of: 'voland', evidence: ['клетчатый', 'длинный'] }])).to.equal(0);
            expect(meta.analysis.possible_duplicates).to.deep.equal([{ hero_id: 'koroviev', of: 'voland', evidence: ['клетчатый', 'длинный'] }]);
        });
        it('a warning only while both heroes exist; never blocking', () => {
            const book = { book: { analysis: { possible_duplicates: [{ hero_id: 'koroviev', of: 'voland', evidence: ['клетчатый'] }, { hero_id: 'gone', of: 'voland', evidence: [] }] } }, heroes: [H('narrator'), H('voland'), H('koroviev')] };
            const issues = heroes.collectBookHeroIssues(book).filter((i) => i.code === 'possible_duplicate');
            expect(issues).to.have.length(1);
            expect(issues[0]).to.include({ hero_id: 'koroviev', of: 'voland', blocking: false });
        });
        it('the analysis writes them into book.json (createFromAnalysis → possibleDuplicates) and GET-side loaders show them', () => {
            const books = path.join(sandbox, 'books');
            fs.mkdirSync(books);
            configureBooksRoot(books);
            const { bookId } = lazyBook.createDraftBook('Глава 1.\n\nВоланд и Коровьев.\n', lazyBook.SourceType.TXT, 'm.txt');
            const result = lazyBook.createFromAnalysis(bookId, {
                characters: [
                    { id: 'voland', name: 'Воланд', appearance: 'tall man', clothes: 'grey suit', video_tokens: ['man'] },
                    { id: 'koroviev', name: 'Коровьев', appearance: 'long thin man', clothes: 'checked jacket', video_tokens: ['thin man'] },
                ],
                locations: [], mentions: {},
                scenes: [{ title: 'S', text: 'Воланд и Коровьев.', characters_present: ['voland', 'koroviev'], units: [{ type: 'perception', text: 'Воланд и Коровьев.' }] }],
                possibleDuplicates: [{ id: 'koroviev', of: 'voland', evidence: ['клетчатый'] }],
            });
            expect(result.possibleDuplicates).to.equal(1);
            const meta = JSON.parse(fs.readFileSync(path.join(books, bookId, 'book.json'), 'utf8'));
            expect(meta.analysis.possible_duplicates).to.deep.equal([{ hero_id: 'koroviev', of: 'voland', evidence: ['клетчатый'] }]);
            for (const loaded of [vbook.loadBook(bookId), lazyBook.loadDraftBook(bookId)]) {
                const dup = loaded.hero_issues.find((i) => i.code === 'possible_duplicate');
                expect(dup).to.include({ hero_id: 'koroviev', of: 'voland', blocking: false });
            }
        });
    });

    describe('unknown scene participants (collectSceneHeroIssues)', () => {
        it('an id that names no hero is a non-blocking warning with its scenes; a broken hero file is not "unknown"', () => {
            const book = {
                heroes: [{ id: 'yura' }],
                hero_issues: [{ file: 'characters/anna.json', hero_id: 'anna', code: 'invalid_json', blocking: true }],
                chapters: [{ chapter_id: 'c1', scenes: [{ scene_id: 's1', participants: ['yura', 'berlioz', 'anna'] }, { scene_id: 's2', participants: ['berlioz'] }] }],
            };
            expect(heroes.collectSceneHeroIssues(book)).to.deep.equal([{
                code: 'unknown_participant', participant: 'berlioz',
                scenes: [{ chapter_id: 'c1', scene_id: 's1' }, { chapter_id: 'c1', scene_id: 's2' }],
                message: 'participant "berlioz" is not a hero of this book (2 scenes); image and video leave it out',
                blocking: false,
            }]);
        });
    });

    describe('voice.reference.source_timbre_sha256 (owner, 18.11)', () => {
        const ref = (extra = {}) => ({ file: 'voices/yura/c1.wav', sha256: SHA, ref_text: 'Фраза.', source: 'designed', verification: 'passed', locked: true, ...extra });
        it('the schema and the validator know the key (no unknown_key warning)', () => {
            const doc = { schema: 'animastor.character/1', id: 'yura', voice: { timbre: 'Warm.', reference: ref({ source_timbre_sha256: sha('Warm.') }) } };
            const check = validateCharacterFile(doc, { filename: 'yura.json' });
            expect(check.valid).to.equal(true);
            expect(check.warnings).to.deep.equal([]);
            expect(validateCharacterFile({ ...doc, voice: { reference: ref({ source_timbre_sha256: 'nope' }) } }).valid).to.equal(false);
        });
        it('timbreSha256 hashes the trimmed timbre; isReferenceOutdated compares it; no hash → not outdated', () => {
            expect(voice.timbreSha256('  Warm. ')).to.equal(sha('Warm.'));
            expect(voice.isReferenceOutdated({ timbre: 'Warm.', reference: ref({ source_timbre_sha256: sha('Warm.') }) })).to.equal(false);
            expect(voice.isReferenceOutdated({ timbre: 'Cold.', reference: ref({ source_timbre_sha256: sha('Warm.') }) })).to.equal(true);
            expect(voice.isReferenceOutdated({ timbre: 'Cold.', reference: ref() })).to.equal(false);
            expect(voice.isReferenceOutdated({ timbre: 'Cold.' })).to.equal(false);
        });
        it('the voice port keeps the key through setCharacterVoiceReference; a malformed value is refused', () => {
            const book = { heroes: [{ schema: 'animastor.character/1', id: 'yura', voice: { timbre: 'Warm.' } }] };
            voice.setCharacterVoiceReference(book, 'yura', ref({ source_timbre_sha256: sha('Warm.') }));
            expect(book.heroes[0].voice.reference.source_timbre_sha256).to.equal(sha('Warm.'));
            expect(voice.getCharacterVoice(book, 'yura').reference.source_timbre_sha256).to.equal(sha('Warm.'));
            expect(() => voice.setCharacterVoiceReference(book, 'yura', ref({ source_timbre_sha256: 'x' }))).to.throw().with.property('code', 'bad_reference');
        });
    });
});
