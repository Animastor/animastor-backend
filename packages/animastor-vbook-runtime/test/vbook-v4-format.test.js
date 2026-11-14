// ======================================================
// VBook 4 on disk — приёмка шага 1 на уровне пакета (VBOOK_FORMAT_V4 §12)
// ======================================================
// 1.1 layout of a new book, 1.2 export → import → export, 1.3 a 3.1 book on
// disk, 1.4 archive root, 1.6 a broken hero file. The route-level halves of the
// same criteria (HTTP codes and bodies) live in backend/tests/vbook-v4-step1.test.js.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const vbook = require('../src/index');
const bookModel = require('../src/book-model.cjs');
const lazyBook = require('../src/lazy-book');
const { configureBooksRoot, getBooksRoot, isBooksRootConfigured } = require('../src/books-root');

const LEGACY_FILES = ['characters.json', 'voices.json', 'behavior.json', 'mentions.json'];

function tree(root) {
    const out = [];
    (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(dir, e.name), r); } else out.push(r);
        }
    })(root, '');
    return out.sort();
}
function contents(root) {
    const out = {};
    for (const rel of tree(root)) {
        if (!rel.endsWith('/')) out[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    }
    return out;
}
function zipContents(buffer) {
    const out = {};
    for (const e of new AdmZip(buffer).getEntries()) out[e.entryName] = e.getData().toString('utf8');
    return out;
}
function refusal(fn) {
    try { fn(); } catch (err) { return err; }
    return null;
}

const SOURCE = [
    'Глава 1. Встреча', '',
    'Юра вошёл в комнату и остановился у окна. За стеклом шёл снег.', '',
    '— Ты опоздал, — сказала Анна.', '',
    '— Знаю, — ответил Юра.',
].join('\n');

function analysisWindow() {
    return {
        structure: { title: 'Зима', author: 'А. Автор', chapters: [{ type: 'chapter', number: 1, title: 'Встреча' }] },
        characters: [
            { id: 'yura', name: 'Юра', role: 'protagonist', appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket', video_tokens: ['man', 'dark hair'], voice: 'A warm low male voice. When angry, it hardens.' },
            { id: 'anna', name: 'Анна', appearance: 'tall woman, red hair', clothes: 'green dress', video_tokens: ['woman', 'red hair'], voice: { timbre: 'A clear female voice.', manner: 'Speaks quickly.' } },
            { id: 'Анна-2', name: 'Двойник', appearance: 'a woman who looks like Anna', clothes: 'grey coat' },
            { id: 'ghost', name: 'Голос', appearance: null },
        ],
        locations: [{ id: 'room', name: 'Комната', description: 'a small room' }],
        mentions: { 'Юрий': 'yura' },
        scenes: [{
            title: 'У окна',
            text: 'Юра вошёл в комнату и остановился у окна.',
            characters_present: ['yura', 'anna'],
            passport: { yura: { video_tokens: ['man', 'snow on shoulders'], appearance: '' }, stranger: { clothes: 'x' } },
            units: [{ type: 'perception', text: 'Юра вошёл в комнату и остановился у окна.' }],
        }],
    };
}

describe('VBook 4 format — acceptance of step 1 (package level)', () => {
    let sandbox, books, previousRoot = null;
    before(() => { previousRoot = isBooksRootConfigured() ? getBooksRoot() : null; });
    after(() => { if (previousRoot) configureBooksRoot(previousRoot); });
    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-v4-'));
        books = path.join(sandbox, 'books');
        fs.mkdirSync(books);
        configureBooksRoot(books);
    });
    afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    function newBook() {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
        lazyBook.createFromAnalysis(bookId, analysisWindow());
        return bookId;
    }

    describe('1.1 a book created from TXT has the §3 layout', () => {
        it('1.1 a fresh draft is born with manifest v4, the narrator file and behaviour.json; no 3.1 files', () => {
            const { bookId, manifest } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
            const dir = path.join(books, bookId);
            expect(tree(dir)).to.deep.equal(['behaviour.json', 'book.json', 'characters/', 'characters/narrator.json', 'manifest.json', 'source.txt']);
            expect(manifest.vbook_version).to.equal(4);
            const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
            expect(onDisk.vbook_version).to.be.a('number').and.equal(4);
            const narrator = JSON.parse(fs.readFileSync(path.join(dir, 'characters', 'narrator.json'), 'utf8'));
            expect(narrator).to.include({ schema: 'animastor.character/1', id: 'narrator', role: 'narrator' });
            expect(narrator.voice.timbre).to.be.a('string').and.not.equal('');
            expect(narrator.voice).to.not.have.property('instruction');
            expect(JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8')))
                .to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] });
            const meta = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
            expect(meta).to.not.have.property('version');
            expect(meta.structure.characters_order).to.deep.equal(['narrator']);
        });

        it('1.1 after the first analysis window: one file per hero, chapters, and still no 3.1 files', () => {
            const bookId = newBook();
            const dir = path.join(books, bookId);
            const files = tree(dir);
            expect(files.filter((f) => !f.startsWith('chapters/'))).to.deep.equal([
                'behaviour.json', 'bible.json', 'book.json', 'characters/', 'characters/anna.json',
                'characters/narrator.json', 'characters/yura.json', 'locations.json', 'manifest.json', 'source.txt',
            ]);
            for (const legacy of LEGACY_FILES) expect(files, legacy).to.not.include(legacy);
            const chapterFiles = files.filter((f) => /^chapters\/ch-[a-f0-9]+\.json$/.test(f));
            expect(chapterFiles.length).to.be.greaterThan(0);
            expect(files.filter((f) => f.startsWith('chapters/') && f !== 'chapters/')).to.deep.equal(chapterFiles);

            const book = vbook.loadBook(bookId);
            expect(book.manifest.vbook_version).to.equal(4);
            expect(Object.keys(book).sort()).to.deep.equal(['behaviour', 'bible', 'book', 'chapters', 'hero_issues', 'heroes', 'locations', 'manifest']);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna']);
            expect(book.book.structure.characters_order).to.deep.equal(['narrator', 'yura', 'anna']);
            expect(book.hero_issues).to.deep.equal([]);
        });

        it('1.1 a hero file carries passport and voice {timbre, manner}; no instruction, no plain voice string', () => {
            const book = vbook.loadBook(newBook());
            const yura = vbook.heroes.findHero(book, 'yura');
            expect(yura).to.deep.equal({
                schema: 'animastor.character/1', id: 'yura', name: 'Юра', role: 'protagonist',
                passport: { appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket', video_tokens: ['man', 'dark hair'] },
                voice: { timbre: 'A warm low male voice.', manner: '', timbre_source: 'cleaned' },
            });
            expect(vbook.heroes.findHero(book, 'anna').voice).to.deep.equal({ timbre: 'A clear female voice.', manner: 'Speaks quickly.', timbre_source: 'analysis' });
            expect(vbook.heroes.voiceInstruct(vbook.heroes.findHero(book, 'anna'))).to.equal('A clear female voice. Speaks quickly.');
            expect(vbook.voice.getCharacterVoice(book, 'narrator').timbre).to.not.equal('');
        });

        it('1.1 a character without a described appearance or with a non-canonical id gets no file', () => {
            const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
            const result = lazyBook.createFromAnalysis(bookId, analysisWindow());
            expect(fs.readdirSync(path.join(books, bookId, 'characters')).sort()).to.deep.equal(['anna.json', 'narrator.json', 'yura.json']);
            expect(result.skippedHeroes.map((s) => s.reason)).to.deep.equal(['invalid_hero_id']);
            expect(result.heroes).to.equal(3);
        });

        it('1.1 the scene keeps a one-scene override as look_patch; scene.passport is not written', () => {
            const book = vbook.loadBook(newBook());
            const scene = book.chapters.flatMap((c) => c.scenes).find((s) => s.scene_title === 'У окна');
            expect(scene).to.not.have.property('passport');
            expect(scene.look_patch).to.deep.equal({ yura: { video_tokens: ['man', 'snow on shoulders'] } });
            expect(vbook.looks.resolveHeroLook(book, book.chapters[0], scene, 'yura').video_tokens).to.deep.equal(['man', 'snow on shoulders']);
        });

        it('1.1 a second window adds heroes and never replaces an existing hero\'s voice or reference', () => {
            const bookId = newBook();
            const dir = path.join(books, bookId);
            const reference = { file: 'voices/yura/c1.wav', ref_text: 'Фраза.', source: 'uploaded', sha256: 'a'.repeat(64), verification: 'passed', locked: true };
            vbook.characterStore.updateCharacter(dir, 'yura', (h) => ({ ...h, voice: { timbre: 'Edited by hand.', manner: 'Slow.', timbre_source: 'user', reference } }));
            const second = analysisWindow();
            second.characters = [
                { id: 'yura', name: 'Юра', appearance: 'man', clothes: 'jacket', voice: 'A completely different voice.' },
                { id: 'boris', name: 'Борис', appearance: 'old man, grey beard', clothes: 'fur coat', video_tokens: ['old man'] },
            ];
            lazyBook.appendToBook(bookId, second, { chapterIndex: 1, chapterTitle: 'Вторая' });
            const book = vbook.loadBook(bookId);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna', 'boris']);
            expect(vbook.heroes.findHero(book, 'yura').voice).to.deep.equal({ timbre: 'Edited by hand.', manner: 'Slow.', timbre_source: 'user', reference });
            for (const legacy of LEGACY_FILES) expect(fs.existsSync(path.join(dir, legacy)), legacy).to.equal(false);
        });
    });

    describe('1.2 export → import → export', () => {
        it('1.2 the second archive equals the first: same entries, same bytes', async () => {
            const bookId = newBook();
            const dir = path.join(books, bookId);
            // make the book less trivial: a look, an assignment, a global rule, an unknown key
            vbook.characterStore.updateCharacter(dir, 'yura', (h) => ({ ...h, aliases: ['Юрий'], looks: [{ id: 'coat', label: 'В пальто', fields: { clothes: 'grey coat' } }], future_key: { keep: true } }));
            const book = vbook.loadBook(bookId);
            book.behaviour.rules.push({ id: 'g1', when: { emotion: ['proud'] }, then: { action: 'nods' } });
            book.chapters[0].looks = { yura: 'coat' };
            vbook.saveBookBundle(book);

            const first = vbook.exportBookBundle(bookId);
            const firstFiles = zipContents(first.buffer);
            expect(Object.keys(firstFiles).filter((n) => !n.startsWith('chapters/')).sort()).to.deep.equal([
                'behaviour.json', 'bible.json', 'book.json', 'characters/anna.json', 'characters/narrator.json',
                'characters/yura.json', 'locations.json', 'manifest.json', 'source.txt',
            ]);
            expect(firstFiles['source.txt']).to.equal(SOURCE);

            await vbook.resetBook(bookId);
            expect(fs.existsSync(dir)).to.equal(false);
            const imported = vbook.buildBookFromBundle(vbook.extractBookBundle(first.buffer, { log: () => {} }));
            vbook.saveBookBundle(imported);

            const second = vbook.exportBookBundle(bookId);
            expect(zipContents(second.buffer)).to.deep.equal(firstFiles);
            // and what is on disk is exactly what the archive holds — nothing more
            expect(contents(dir)).to.deep.equal(firstFiles);
        });

        it('1.2 the archive is flat: manifest.json in the root, no top-level folder', () => {
            const out = vbook.exportBookBundle(newBook());
            const names = new AdmZip(out.buffer).getEntries().map((e) => e.entryName);
            expect(names).to.include('manifest.json');
            for (const name of names) expect(name).to.match(/^(manifest|book|bible|locations|behaviour)\.json$|^source\.txt$|^characters\/[a-z0-9_]+\.json$|^chapters\/ch-[a-f0-9]+\.json$/);
        });

        it('1.2 a save that changes nothing rewrites no hero file', () => {
            const bookId = newBook();
            const dir = path.join(books, bookId, 'characters');
            const stamp = () => fs.readdirSync(dir).sort().map((n) => [n, fs.statSync(path.join(dir, n)).ino]);
            const before = stamp();
            vbook.saveBookBundle(vbook.loadBook(bookId));
            expect(stamp()).to.deep.equal(before); // an atomic write would have replaced the inode
        });

        it('saving a book without `heroes` leaves the cast alone; a hero dropped from `heroes` is removed, the narrator never', () => {
            const bookId = newBook();
            const dir = path.join(books, bookId, 'characters');
            const book = vbook.loadBook(bookId);
            const { heroes: _omitted, ...withoutHeroes } = book;
            vbook.saveBookBundle(withoutHeroes);
            expect(fs.readdirSync(dir).sort()).to.deep.equal(['anna.json', 'narrator.json', 'yura.json']);
            vbook.saveBookBundle({ ...book, heroes: book.heroes.filter((h) => h.id === 'yura') });
            expect(fs.readdirSync(dir).sort()).to.deep.equal(['narrator.json', 'yura.json']);
        });
    });

    describe('1.3 a VBook 3.1 book on disk', () => {
        function plant31(version) {
            const dir = path.join(books, 'old_book');
            fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
            const manifest = { book_id: 'old_book', build_id: 'build_old_book', state: 'ACTIVE' };
            if (version !== undefined) manifest.vbook_version = version;
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ title: 'Старая', structure: { chapters_order: ['ch-aaaaaa.json'] } }));
            fs.writeFileSync(path.join(dir, 'characters.json'), '[{"id":"yura","passport":{}}]');
            fs.writeFileSync(path.join(dir, 'voices.json'), '{"narrator":{"instruction":"x"}}');
            fs.writeFileSync(path.join(dir, 'behavior.json'), '{}');
            fs.writeFileSync(path.join(dir, 'source.txt'), SOURCE);
            fs.writeFileSync(path.join(dir, 'chapters', 'ch-aaaaaa.json'), JSON.stringify({ chapter_id: 'ch-aaaaaa', scenes: [] }));
            return dir;
        }

        for (const [label, version, stated] of [['3.1', '3.1', '3.1'], ['no version', undefined, null], ['a newer version', 5, '5']]) {
            it(`1.3 ${label}: every loader throws UNSUPPORTED_VBOOK_VERSION and not one file changes`, () => {
                const dir = plant31(version);
                const before = contents(dir);
                const mtimes = () => tree(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
                const stamps = mtimes();
                const attempts = [
                    () => vbook.loadBook('old_book'),
                    () => bookModel.loadBook('old_book'),
                    () => bookModel.loadBook('old_book', { mode: 'lazy' }),
                    () => lazyBook.loadDraftBook('old_book'),
                    () => lazyBook.getBookStatus('old_book'),
                    () => lazyBook.updateBookState('old_book', 'ACTIVE'),
                    () => lazyBook.createFromAnalysis('old_book', analysisWindow()),
                    () => vbook.exportBookBundle('old_book'),
                ];
                for (const attempt of attempts) {
                    const err = refusal(attempt);
                    expect(err, attempt.toString()).to.be.instanceOf(bookModel.BookModelError);
                    expect(err.code).to.equal('UNSUPPORTED_VBOOK_VERSION');
                    expect(err.vbookVersion).to.equal(stated);
                    expect(err.supported).to.equal(4);
                }
                expect(contents(dir)).to.deep.equal(before);
                expect(mtimes()).to.deep.equal(stamps);
            });
        }

        it('1.3 the error turns into one response body, in the language of the request', () => {
            plant31('3.1');
            const err = refusal(() => vbook.loadBook('old_book'));
            const ru = vbook.vbookVersion.unsupportedVersionBody(err, 'ru');
            expect(ru).to.deep.equal({
                error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4,
                message: 'Книга сохранена в формате VBook 3.1, который больше не поддерживается. Импортируйте исходный текст заново — книга будет создана в формате 4.',
            });
            expect(vbook.vbookVersion.unsupportedVersionBody(err, 'en-US').message).to.match(/^This book is saved in VBook 3\.1/);
            plant31(5);
            expect(vbook.vbookVersion.unsupportedVersionBody(refusal(() => vbook.loadBook('old_book')), 'ru').message)
                .to.equal('Книга создана более новой версией Animastor.');
        });

        it('1.3 "no such book" is still null, not an error; the identity of a 3.1 book stays readable', () => {
            expect(vbook.loadBook('missing_book')).to.equal(null);
            expect(bookModel.loadBook('missing_book', { mode: 'lazy' })).to.equal(null);
            plant31('3.1');
            expect(bookModel.getBookIdentity('old_book')).to.include({ canonicalBookId: 'old_book', vbookVersion: '3.1' });
        });

        it('1.3 a 3.1 book can still be deleted', async () => {
            const dir = plant31('3.1');
            await vbook.resetBook('old_book');
            expect(fs.existsSync(dir)).to.equal(false);
        });
    });

    describe('1.6 a broken hero file', () => {
        function bookWithBrokenAnna() {
            const bookId = newBook();
            const dir = path.join(books, bookId);
            fs.writeFileSync(path.join(dir, 'characters', 'anna.json'), '{"schema":"animastor.character/1","id":"anna",');
            return { bookId, dir };
        }

        it('1.6 the book opens without the broken hero and reports it in hero_issues', () => {
            const { bookId } = bookWithBrokenAnna();
            for (const book of [vbook.loadBook(bookId), lazyBook.loadDraftBook(bookId), bookModel.loadBook(bookId, { mode: 'lazy' })]) {
                expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
                expect(book.hero_issues).to.have.length(1);
                expect(book.hero_issues[0]).to.include({ file: 'characters/anna.json', hero_id: 'anna', code: 'invalid_json', blocking: true });
                expect(book.chapters.length).to.be.greaterThan(0);
            }
            // scenes keep the id of the broken hero in participants
            const scene = vbook.loadBook(bookId).chapters.flatMap((c) => c.scenes).find((s) => s.scene_title === 'У окна');
            expect(scene.participants).to.include('anna');
        });

        it('1.6 a write aimed at the broken id is refused (hero_file_broken) and the file keeps its bytes', () => {
            const { bookId, dir } = bookWithBrokenAnna();
            const before = contents(dir);
            const anna = { schema: 'animastor.character/1', id: 'anna', name: 'Анна' };
            const book = vbook.loadBook(bookId);
            const attempts = [
                () => vbook.characterStore.writeCharacter(dir, anna),
                () => vbook.characterStore.updateCharacter(dir, 'anna', (h) => h),
                () => vbook.characterStore.removeCharacter(dir, 'anna'),
                () => vbook.saveBookBundle({ ...book, heroes: [...book.heroes, anna] }),
            ];
            for (const attempt of attempts) {
                const err = refusal(attempt);
                expect(err && err.code, attempt.toString()).to.equal('hero_file_broken');
            }
            expect(contents(dir)).to.deep.equal(before);
        });

        it('1.6 saving the book as it was loaded neither repairs nor deletes the broken file', () => {
            const { bookId, dir } = bookWithBrokenAnna();
            const broken = fs.readFileSync(path.join(dir, 'characters', 'anna.json'), 'utf8');
            const book = vbook.loadBook(bookId);
            book.heroes[1].notes = 'edited while anna is broken';
            vbook.saveBookBundle(book);
            expect(fs.readFileSync(path.join(dir, 'characters', 'anna.json'), 'utf8')).to.equal(broken);
            expect(vbook.loadBook(bookId).heroes[1].notes).to.equal('edited while anna is broken');
            expect(vbook.loadBook(bookId).hero_issues.map((i) => i.code)).to.deep.equal(['invalid_json']);
        });

        it('1.6 export is refused with the list of broken files; skipBroken exports without them', () => {
            const { bookId, dir } = bookWithBrokenAnna();
            const before = contents(dir);
            const err = refusal(() => vbook.exportBookBundle(bookId));
            expect(err && err.code).to.equal('hero_file_broken');
            expect(err.details.issues.map((i) => [i.file, i.code])).to.deep.equal([['characters/anna.json', 'invalid_json']]);

            const out = vbook.exportBookBundle(bookId, { skipBroken: true });
            const names = Object.keys(zipContents(out.buffer));
            expect(names).to.include('characters/yura.json').and.include('characters/narrator.json');
            expect(names).to.not.include('characters/anna.json');
            expect(out.skipped.map((i) => i.file)).to.deep.equal(['characters/anna.json']);
            expect(contents(dir)).to.deep.equal(before);
            // the exported archive is importable as it is
            expect(vbook.buildBookFromBundle(vbook.extractBookBundle(out.buffer, { log: () => {} })).heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura']);
        });

        it('1.6 a missing or broken narrator.json: the book opens and reports narrator_missing', () => {
            const bookId = newBook();
            const file = path.join(books, bookId, 'characters', 'narrator.json');
            fs.writeFileSync(file, 'not json');
            let book = vbook.loadBook(bookId);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['yura', 'anna']);
            expect(book.hero_issues.map((i) => [i.code, i.blocking])).to.deep.equal([['invalid_json', true], ['narrator_missing', true]]);
            expect(vbook.voice.getCharacterVoice(book, 'narrator')).to.equal(null);
            fs.unlinkSync(file);
            book = vbook.loadBook(bookId);
            expect(book.hero_issues.map((i) => i.code)).to.deep.equal(['narrator_missing']);
            // a missing narrator is not a broken file: the export goes through
            expect(vbook.exportBookBundle(bookId).files).to.not.include('characters/narrator.json');
        });

        it('1.6 book-level warnings are non-blocking: duplicate rule id, ambiguous alias, unknown key', () => {
            const bookId = newBook();
            const dir = path.join(books, bookId);
            vbook.characterStore.updateCharacter(dir, 'yura', (h) => ({ ...h, aliases: ['Он'], behaviour: { rules: [{ id: 'r1' }] }, odd: 1 }));
            vbook.characterStore.updateCharacter(dir, 'anna', (h) => ({ ...h, aliases: ['он'], behaviour: { rules: [{ id: 'r1' }] } }));
            const book = vbook.loadBook(bookId);
            expect(book.heroes).to.have.length(3);
            expect(book.hero_issues.map((i) => [i.code, i.blocking]).sort()).to.deep.equal([
                ['ambiguous_alias', false], ['duplicate_rule_id', false], ['unknown_key', false],
            ]);
            expect(vbook.exportBookBundle(bookId).files).to.include('characters/anna.json');
        });
    });
});
