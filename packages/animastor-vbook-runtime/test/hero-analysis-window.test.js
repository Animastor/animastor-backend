// ======================================================
// The analysis writes heroes — VBOOK_FORMAT_V4 §12, шаг 2
// ======================================================
// What reaches the hero files when analysis windows are written one after
// another (lazy-book createFromAnalysis / appendToBook), and the pure rules
// behind it (hero-analysis.cjs, voiceFromAnalysis).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vbook = require('../src/index');
const lazyBook = require('../src/lazy-book');
const voice = require('../src/voice');
const heroAnalysis = require('../src/hero-analysis.cjs');
const { validateCharacterFile } = require('../src/bundle-validator.cjs');
const { configureBooksRoot, getBooksRoot, isBooksRootConfigured } = require('../src/books-root');

const SOURCE = 'Глава 1. Встреча\n\nЮра вошёл в комнату и остановился у окна.\n\n— Ты опоздал, — сказала Анна.\n';
const SHA = 'a'.repeat(64);
const LEGACY = ['characters.json', 'voices.json', 'behavior.json', 'mentions.json'];

function scene(title, extra = {}) {
    return {
        title,
        text: `${title}. Юра вошёл в комнату.`,
        units: [{ type: 'perception', text: `${title}. Юра вошёл в комнату.` }],
        ...extra,
    };
}

// What the model returns for the first window: ids as it likes to write them.
function windowOne() {
    return {
        structure: { title: 'Зима', author: 'А. Автор', chapters: [{ type: 'chapter', number: 1, title: 'Встреча' }, { type: 'chapter', number: 2, title: 'Дорога' }] },
        characters: [
            { id: 'Юра', name: 'Юра', role: 'protagonist', appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket', video_tokens: ['man', 'dark hair'],
              voice: { timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.', manner: 'Speaks unhurriedly, with pauses.' } },
            { id: 'Анна Сергеевна', name: 'Анна Сергеевна', alias: 'Анна', appearance: 'tall woman, red hair', clothes: 'green dress', video_tokens: ['woman', 'red hair'],
              voice: { timbre: 'A clear female alto. Native Russian pronunciation.', manner: 'Speaks quickly. Cheerful inflection on the word «поехали».' } },
            { id: 'Женщина в будочке', name: 'Женщина в будочке', appearance: 'stout woman in a kiosk window', clothes: 'white apron', voice: 'A sharp middle-aged female voice. When annoyed, she snaps.' },
            { id: 'book', name: 'Книжник', appearance: 'old man with a grey beard', clothes: 'worn coat' },
            { id: 'Голос', name: 'Голос из трубки', appearance: null, voice: { timbre: 'A tinny voice.' } },
        ],
        locations: [{ id: 'room', name: 'Комната', description: 'a small room' }],
        mentions: { 'Юрий': 'Юра', 'Юрка': 'yura', 'доктор': 'Юра', 'Аня': 'Анна Сергеевна', 'незнакомец': 'stranger_at_the_door' },
        scenes: [
            scene('У окна', {
                characters_present: ['Юра', 'Анна Сергеевна', 'book'],
                passport: { 'Юра': { video_tokens: ['man', 'snow on shoulders'] }, 'Анна Сергеевна': { video_tokens: ['woman', 'red hair'] } },
                units: [
                    { type: 'perception', text: 'Юра вошёл в комнату и остановился у окна.' },
                    { type: 'dialogue', text: '— Ты опоздал.', audio: { speaker: 'Анна Сергеевна' } },
                    { type: 'dialogue', text: '— Знаю.', audio: { speaker: 'Юра' } },
                ],
            }),
        ],
    };
}

// The second window: the same people under other spellings, one new hero.
function windowTwo() {
    return {
        characters: [
            { id: 'yuriy', name: 'Юрий', appearance: 'a tired man', clothes: 'grey coat', video_tokens: ['man', 'grey coat'],
              voice: { timbre: 'A COMPLETELY different voice.', manner: 'Shouts.' } },
            { id: 'anna_sergeevna', name: 'Анна Сергеевна', appearance: 'tall woman', clothes: 'coat', voice: { timbre: 'Another voice.', manner: 'Whispers.' } },
            { id: 'kiosk_woman', name: 'Женщина в будочке', appearance: 'stout woman', voice: { timbre: 'Yet another voice.', manner: 'Slow.' } },
            { id: 'Борис', name: 'Борис', appearance: 'old man, grey beard', clothes: 'fur coat', video_tokens: ['old man'],
              voice: { timbre: 'A hoarse old male voice. Native Russian pronunciation.' } },
            // the model gives a second, different person the same id in the same window
            { id: 'БОРИС', name: 'Савелий Кузьмич', appearance: 'a boy of ten', clothes: 'school uniform' },
        ],
        locations: [],
        mentions: { 'Живаго': 'yuriy', 'дед': 'Борис', 'доктор': 'Борис', 'Аня': 'anna_sergeevna' },
        scenes: [scene('В дороге', {
            characters_present: ['yuriy', 'Борис', 'kiosk_woman', 'БОРИС'],
            units: [
                { type: 'perception', text: 'Они ехали молча.' },
                { type: 'dialogue', text: '— Далеко ещё?', audio: { speaker: 'yuriy' } },
            ],
        })],
    };
}

describe('the analysis writes heroes (step 2)', () => {
    let sandbox, books, previousRoot = null;
    before(() => { previousRoot = isBooksRootConfigured() ? getBooksRoot() : null; });
    after(() => { if (previousRoot) configureBooksRoot(previousRoot); });
    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-step2-'));
        books = path.join(sandbox, 'books');
        fs.mkdirSync(books);
        configureBooksRoot(books);
    });
    afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    const hero = (bookId, id) => vbook.heroes.findHero(vbook.loadBook(bookId), id);
    const heroFiles = (bookId) => fs.readdirSync(path.join(books, bookId, 'characters')).sort();
    function firstWindow() {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
        const result = lazyBook.createFromAnalysis(bookId, windowOne());
        return { bookId, result, dir: path.join(books, bookId) };
    }
    const sceneByTitle = (bookId, title) => vbook.loadBook(bookId).chapters.flatMap((c) => c.scenes).find((s) => s.scene_title === title);

    describe('window 1 — ids, names, aliases', () => {
        it('ids from the model become canonical; a reserved id gets a suffix; nobody is skipped for its id', () => {
            const { bookId, result } = firstWindow();
            expect(heroFiles(bookId)).to.deep.equal(['anna_sergeevna.json', 'book_2.json', 'narrator.json', 'yura.json', 'zhenshchina_v_budochke.json']);
            expect(result.newHeroes).to.deep.equal(['yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2']);
            expect(result.skippedHeroes).to.deep.equal([]);
            expect(result.heroIdMap).to.deep.equal({
                'Юра': 'yura', 'Анна Сергеевна': 'anna_sergeevna', 'Женщина в будочке': 'zhenshchina_v_budochke', book: 'book_2',
            });
            const book = vbook.loadBook(bookId);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2']);
            expect(book.hero_issues).to.deep.equal([]);
            for (const h of book.heroes) expect(validateCharacterFile(h, { filename: `${h.id}.json` }).errors, h.id).to.deep.equal([]);
            for (const legacy of LEGACY) expect(fs.existsSync(path.join(books, bookId, legacy)), legacy).to.equal(false);
        });

        it('the original name stays in `name`; other spellings and the mentions of the window go to `aliases`', () => {
            const { bookId } = firstWindow();
            expect(hero(bookId, 'yura')).to.include({ name: 'Юра', role: 'protagonist' });
            expect(hero(bookId, 'yura').aliases).to.deep.equal(['Юрий', 'Юрка', 'доктор']);
            expect(hero(bookId, 'anna_sergeevna').name).to.equal('Анна Сергеевна');
            expect(hero(bookId, 'anna_sergeevna').aliases).to.deep.equal(['Анна', 'Аня']);
            expect(hero(bookId, 'book_2')).to.include({ name: 'Книжник' });
            expect(hero(bookId, 'book_2')).to.not.have.property('aliases');
            // a hero's own name is never its alias
            expect(hero(bookId, 'zhenshchina_v_budochke')).to.not.have.property('aliases');
        });

        it('a mention whose target is not a hero is written nowhere; mentions.json is not created', () => {
            const { bookId, dir } = firstWindow();
            const all = JSON.stringify(vbook.loadBook(bookId).heroes);
            expect(all).to.not.include('незнакомец');
            expect(fs.existsSync(path.join(dir, 'mentions.json'))).to.equal(false);
            const index = vbook.heroes.buildAliasIndex(vbook.loadBook(bookId).heroes);
            expect(index.index['Юрий']).to.equal('yura');
            expect(index.ambiguous).to.deep.equal([]);
        });

        it('a character without a described appearance gets no file and no voice', () => {
            const { bookId } = firstWindow();
            expect(heroFiles(bookId)).to.not.include('golos.json');
            expect(hero(bookId, 'golos')).to.equal(null);
        });

        it('participants and speakers written with the model\'s ids point at the final hero ids', () => {
            const { bookId } = firstWindow();
            const sc = sceneByTitle(bookId, 'У окна');
            expect(sc.participants).to.deep.equal(['yura', 'anna_sergeevna', 'book_2']);
            expect(sc.units.filter((u) => u.type === 'dialogue').map((u) => u.audio.speaker)).to.deep.equal(['anna_sergeevna', 'yura']);
            expect(sc).to.not.have.property('passport');
        });
    });

    describe('window 1 — voices {timbre, manner}', () => {
        it('timbre and manner are stored separately for every speaking hero; the narrator has both', () => {
            const { bookId } = firstWindow();
            expect(hero(bookId, 'yura').voice).to.deep.equal({
                timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.',
                manner: 'Speaks unhurriedly, with pauses.',
                timbre_source: 'analysis',
            });
            const narrator = hero(bookId, 'narrator').voice;
            expect(narrator.timbre).to.be.a('string').and.not.equal('');
            expect(narrator.manner).to.be.a('string').and.not.equal('');
            for (const h of vbook.loadBook(bookId).heroes) {
                expect(JSON.stringify(h), h.id).to.not.include('instruction');
                if (h.voice) expect(h.voice, h.id).to.have.all.keys('timbre', 'manner', 'timbre_source');
            }
        });

        it('a plot-bound sentence reaches neither field; the voice is marked as cleaned', () => {
            const { bookId } = firstWindow();
            expect(hero(bookId, 'anna_sergeevna').voice).to.deep.equal({
                timbre: 'A clear female alto. Native Russian pronunciation.',
                manner: 'Speaks quickly.',
                timbre_source: 'cleaned',
            });
        });

        it('a voice returned as one string is taken as timbre and cleaned by the rules', () => {
            const { bookId } = firstWindow();
            expect(hero(bookId, 'zhenshchina_v_budochke').voice).to.deep.equal({
                timbre: 'A sharp middle-aged female voice.', manner: '', timbre_source: 'cleaned',
            });
        });

        it('a hero the model gave no voice has no voice block (it speaks with the narrator)', () => {
            const { bookId } = firstWindow();
            expect(hero(bookId, 'book_2')).to.not.have.property('voice');
            expect(voice.getCharacterVoice(vbook.loadBook(bookId), 'book_2')).to.equal(null);
        });

        const SHAPES = [
            ['{timbre, manner}', { timbre: ' Low male bass. ', manner: ' Slow. ' }, { timbre: 'Low male bass.', manner: 'Slow.', timbre_source: 'analysis' }],
            ['without manner', { timbre: 'Low male bass.' }, { timbre: 'Low male bass.', manner: '', timbre_source: 'analysis' }],
            ['manner null', { timbre: 'Low male bass.', manner: null }, { timbre: 'Low male bass.', manner: '', timbre_source: 'analysis' }],
            ['a plain string', 'Low male bass. Slow.', { timbre: 'Low male bass. Slow.', manner: '', timbre_source: 'cleaned' }],
            ['{instruction} of the old contract', { instruction: 'Low male bass.' }, { timbre: 'Low male bass.', manner: '', timbre_source: 'cleaned' }],
            ['a conditional sentence in timbre', { timbre: 'Low male bass. If he is angry, the voice breaks.', manner: 'Slow.' }, { timbre: 'Low male bass.', manner: 'Slow.', timbre_source: 'cleaned' }],
            ['a quoted line in manner', { timbre: 'Low male bass.', manner: 'Slow. Stresses "never" every time.' }, { timbre: 'Low male bass.', manner: 'Slow.', timbre_source: 'cleaned' }],
            ['"on the word" without quotes', { timbre: 'Low male bass.', manner: 'Rising tone on the word poyekhali. Slow.' }, { timbre: 'Low male bass.', manner: 'Slow.', timbre_source: 'cleaned' }],
            ['«на слове» in Russian', { timbre: 'Низкий мужской бас.', manner: 'Повышает тон на слове поехали. Говорит медленно.' }, { timbre: 'Низкий мужской бас.', manner: 'Говорит медленно.', timbre_source: 'cleaned' }],
            ['manner made only of plot text', { timbre: 'Low male bass.', manner: 'When he sees Anna, he whispers.' }, { timbre: 'Low male bass.', manner: '', timbre_source: 'cleaned' }],
        ];
        for (const [label, raw, expected] of SHAPES) {
            it(`the model returned ${label} → a valid voice block`, () => {
                const result = voice.voiceFromAnalysis(raw);
                expect(result.voice).to.deep.equal(expected);
                expect(result.reason).to.equal(null);
                expect(validateCharacterFile({ schema: 'animastor.character/1', id: 'yura', voice: result.voice }).errors).to.deep.equal([]);
            });
        }

        const REFUSED = [
            ['nothing', undefined, 'empty'], ['null', null, 'empty'], ['an empty object', {}, 'empty'], ['blank strings', { timbre: '  ', manner: '' }, 'empty'],
            ['a manner without a timbre', { manner: 'Slow.' }, 'timbre_empty'],
            ['a timbre made only of plot text', { timbre: 'When angry, he shouts.', manner: 'Slow.' }, 'timbre_empty'],
            ['a string made only of plot text', 'If asked, answers «нет».', 'timbre_empty'],
            ['a number', 42, 'bad_shape'], ['an array', ['Low.'], 'bad_shape'], ['true', true, 'bad_shape'],
            ['non-string fields', { timbre: 5, manner: {} }, 'empty'],
        ];
        for (const [label, raw, reason] of REFUSED) {
            it(`the model returned ${label} → no voice is written (${reason})`, () => {
                const result = voice.voiceFromAnalysis(raw);
                expect(result.voice).to.equal(null);
                expect(result.reason).to.equal(reason);
            });
        }

        it('parsing twice is stable: a block marked cleaned / user stays so; new plot text still marks it cleaned', () => {
            const once = voice.voiceFromAnalysis({ timbre: 'Low male bass.', manner: 'Slow. If asked, he shouts.' }).voice;
            expect(once.timbre_source).to.equal('cleaned');
            expect(voice.voiceFromAnalysis(once).voice).to.deep.equal(once);
            expect(voice.voiceFromAnalysis({ timbre: 'Low.', manner: '', timbre_source: 'user' }).voice.timbre_source).to.equal('user');
            expect(voice.voiceFromAnalysis({ timbre: 'Low. When angry, loud.', timbre_source: 'analysis' }).voice.timbre_source).to.equal('cleaned');
            expect(voice.voiceFromAnalysis({ timbre: 'Low.', timbre_source: 'llm' }).voice.timbre_source).to.equal('analysis');
        });

        it('a refused voice never blocks the hero: the file is written without a voice block', () => {
            const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
            const w = windowOne();
            w.characters[0].voice = { manner: 'Only a manner.' };
            w.characters[1].voice = 42;
            lazyBook.createFromAnalysis(bookId, w);
            expect(hero(bookId, 'yura')).to.not.have.property('voice');
            expect(hero(bookId, 'anna_sergeevna')).to.not.have.property('voice');
            expect(hero(bookId, 'yura').passport.appearance).to.equal('man in his thirties, short dark hair');
        });

        it('a very long description is cut to the 2000 characters the format allows', () => {
            const long = `${'Deep resonant voice with a slow pace and a dry texture. '.repeat(60)}`;
            const result = voice.voiceFromAnalysis({ timbre: long, manner: long });
            expect(result.voice.timbre.length).to.be.at.most(2000);
            expect(result.voice.manner.length).to.be.at.most(2000);
            expect(validateCharacterFile({ schema: 'animastor.character/1', id: 'yura', voice: result.voice }).valid).to.equal(true);
        });
    });

    describe('two windows in a row', () => {
        const reference = { file: 'voices/yura/c1.wav', sha256: SHA, ref_text: 'Фраза.', source: 'designed', verification: 'passed', locked: true };
        const coat = { id: 'coat', label: 'В пальто', fields: { clothes: 'long grey coat' } };

        function twoWindows({ between } = {}) {
            const first = firstWindow();
            if (between) between(first);
            const second = lazyBook.appendToBook(first.bookId, windowTwo(), { chapterIndex: 1, chapterTitle: 'Дорога' });
            return { ...first, second };
        }

        it('the cast after two windows: the same people keep their ids, one hero is added, nobody is duplicated', () => {
            const { bookId, second } = twoWindows();
            expect(heroFiles(bookId)).to.deep.equal([
                'anna_sergeevna.json', 'book_2.json', 'boris.json', 'boris_2.json', 'narrator.json', 'yura.json', 'zhenshchina_v_budochke.json',
            ]);
            // "Юрий" is an alias of yura → the same hero under the id the model invented this time;
            // "Женщина в будочке" is matched by name; "Савелий Кузьмич" is somebody else whose id
            // collides with Борис inside this window → suffix.
            expect(second.heroIdMap).to.deep.equal({ yuriy: 'yura', kiosk_woman: 'zhenshchina_v_budochke', 'Борис': 'boris', 'БОРИС': 'boris_2' });
            expect(second.newHeroes).to.deep.equal(['boris', 'boris_2']);
            const book = vbook.loadBook(bookId);
            expect(book.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2', 'boris', 'boris_2']);
            expect(book.book.structure.characters_order).to.deep.equal(book.heroes.map((h) => h.id));
            expect(book.hero_issues).to.deep.equal([]);
            expect(hero(bookId, 'boris_2')).to.include({ name: 'Савелий Кузьмич' });
            // the id the model wrote names Борис, not this hero — it is not kept as an alias
            expect(hero(bookId, 'boris_2')).to.not.have.property('aliases');
            expect(vbook.heroes.buildAliasIndex(book.heroes).ambiguous).to.deep.equal([]);
            for (const legacy of LEGACY) expect(fs.existsSync(path.join(books, bookId, legacy)), legacy).to.equal(false);
        });

        it('a later window never replaces the voice or the passport of an existing hero', () => {
            const { bookId } = twoWindows();
            expect(hero(bookId, 'yura').voice).to.deep.equal({
                timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.',
                manner: 'Speaks unhurriedly, with pauses.',
                timbre_source: 'analysis',
            });
            expect(hero(bookId, 'yura').passport).to.deep.equal({
                appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket', video_tokens: ['man', 'dark hair'],
            });
            expect(hero(bookId, 'anna_sergeevna').voice.timbre).to.equal('A clear female alto. Native Russian pronunciation.');
            expect(hero(bookId, 'zhenshchina_v_budochke').voice.timbre).to.equal('A sharp middle-aged female voice.');
            expect(hero(bookId, 'anna_sergeevna').passport.clothes).to.equal('green dress');
        });

        it('…it only adds what was missing: new aliases, a voice for a hero that had none', () => {
            const { bookId, second } = twoWindows();
            expect(hero(bookId, 'yura').aliases).to.deep.equal(['Юрий', 'Юрка', 'доктор', 'Живаго']);
            // "Аня" was there already — not repeated
            expect(hero(bookId, 'anna_sergeevna').aliases).to.deep.equal(['Анна', 'Аня']);
            expect(hero(bookId, 'boris').aliases).to.deep.equal(['дед']);
            expect(hero(bookId, 'boris').voice).to.deep.equal({ timbre: 'A hoarse old male voice. Native Russian pronunciation.', manner: '', timbre_source: 'analysis' });
            // the kiosk woman's voice came as one string in window 1 — no manner; it is filled now
            expect(hero(bookId, 'zhenshchina_v_budochke').voice).to.deep.equal({ timbre: 'A sharp middle-aged female voice.', manner: 'Slow.', timbre_source: 'cleaned' });
            expect(second.updatedHeroes).to.deep.equal(['yura', 'zhenshchina_v_budochke']);
        });

        it('a fuller name of the same person becomes an alias, not a second hero (identity heuristic, as before v4)', () => {
            const first = firstWindow();
            const w = windowTwo();
            w.characters = [{ id: 'Юра', name: 'Юра Живаго', appearance: 'a tired man', clothes: 'grey coat' }];
            w.mentions = {};
            w.scenes[0].characters_present = ['Юра'];
            const second = lazyBook.appendToBook(first.bookId, w, { chapterIndex: 1, chapterTitle: 'Дорога' });
            expect(second.newHeroes).to.deep.equal([]);
            expect(heroFiles(first.bookId)).to.not.include('yura_2.json');
            expect(hero(first.bookId, 'yura').aliases).to.deep.equal(['Юрий', 'Юрка', 'доктор', 'Юра Живаго']);
            expect(sceneByTitle(first.bookId, 'В дороге').participants).to.deep.equal(['yura']);
        });

        it('an alias that already names another hero is not written to a second one', () => {
            const { bookId } = twoWindows();
            // "доктор" belongs to yura since window 1; window 2 claimed it for boris
            expect(hero(bookId, 'boris').aliases).to.not.include('доктор');
            const { index, ambiguous } = vbook.heroes.buildAliasIndex(vbook.loadBook(bookId).heroes);
            expect(ambiguous).to.deep.equal([]);
            expect(index['доктор']).to.equal('yura');
        });

        it('a locked reference, the user\'s voice edits and the looks survive the second window untouched', () => {
            const { bookId } = twoWindows({
                between: ({ dir }) => {
                    vbook.characterStore.updateCharacter(dir, 'yura', (h) => ({
                        ...h,
                        voice: { timbre: 'Edited by hand.', manner: '', timbre_source: 'user', reference },
                        looks: [coat],
                        notes: 'заметка автора',
                    }));
                    // locked reference on an analysis voice whose manner is empty
                    vbook.characterStore.updateCharacter(dir, 'zhenshchina_v_budochke', (h) => ({
                        ...h, voice: { ...h.voice, reference: { ...reference, file: 'voices/zhenshchina_v_budochke/c1.wav' } },
                    }));
                },
            });
            const yura = hero(bookId, 'yura');
            expect(yura.voice).to.deep.equal({ timbre: 'Edited by hand.', manner: '', timbre_source: 'user', reference });
            expect(yura.looks).to.deep.equal([coat]);
            expect(yura.notes).to.equal('заметка автора');
            expect(yura.passport.clothes).to.equal('brown leather jacket');
            // a locked voice is not completed either: its empty manner stays empty
            expect(hero(bookId, 'zhenshchina_v_budochke').voice).to.deep.equal({
                timbre: 'A sharp middle-aged female voice.', manner: '', timbre_source: 'cleaned',
                reference: { ...reference, file: 'voices/zhenshchina_v_budochke/c1.wav' },
            });
            const v = voice.getCharacterVoice(vbook.loadBook(bookId), 'yura');
            expect(v.reference).to.include({ locked: true, sha256: SHA });
            expect(v.reference_problem).to.equal(null);
        });

        it('a hero file that the second window does not change is not rewritten', () => {
            const first = firstWindow();
            const dir = path.join(first.dir, 'characters');
            const inode = (name) => fs.statSync(path.join(dir, name)).ino;
            const before = { anna: inode('anna_sergeevna.json'), book: inode('book_2.json'), narrator: inode('narrator.json') };
            lazyBook.appendToBook(first.bookId, windowTwo(), { chapterIndex: 1, chapterTitle: 'Дорога' });
            // an atomic write replaces the inode — these three were not written at all
            expect({ anna: inode('anna_sergeevna.json'), book: inode('book_2.json'), narrator: inode('narrator.json') }).to.deep.equal(before);
        });

        it('a voice that is missing is added; an empty timbre of an unprotected voice is filled; a present one is kept', () => {
            const { bookId } = twoWindows({
                between: ({ dir }) => {
                    vbook.characterStore.updateCharacter(dir, 'anna_sergeevna', (h) => ({ ...h, voice: { timbre: '', manner: '' } }));
                    vbook.characterStore.updateCharacter(dir, 'zhenshchina_v_budochke', (h) => { const { voice: _gone, ...rest } = h; return rest; });
                },
            });
            expect(hero(bookId, 'anna_sergeevna').voice).to.deep.equal({ timbre: 'Another voice.', manner: 'Whispers.', timbre_source: 'analysis' });
            expect(hero(bookId, 'zhenshchina_v_budochke').voice).to.deep.equal({ timbre: 'Yet another voice.', manner: 'Slow.', timbre_source: 'analysis' });
            expect(hero(bookId, 'yura').voice.timbre).to.equal('A warm low male baritone, early thirties. Native Russian pronunciation.');
        });

        it('a hero a person deleted between the windows is created again only if the text describes it again', () => {
            const { bookId } = twoWindows({ between: ({ dir }) => { vbook.characterStore.removeCharacter(dir, 'book_2'); vbook.characterStore.removeCharacter(dir, 'anna_sergeevna'); } });
            expect(heroFiles(bookId)).to.not.include('book_2.json');
            // window 2 describes Анна Сергеевна again → the file is back, under the same id
            expect(heroFiles(bookId)).to.include('anna_sergeevna.json');
            expect(hero(bookId, 'anna_sergeevna').voice.timbre).to.equal('Another voice.');
        });

        it('a voice-only hero made by a person gains a passport when the text describes it; its voice stays', () => {
            const { bookId } = twoWindows({
                between: ({ dir }) => {
                    vbook.characterStore.writeCharacter(dir, { schema: 'animastor.character/1', id: 'boris', name: 'Борис', voice: { timbre: 'My own Boris.', manner: '', timbre_source: 'user' } });
                },
            });
            const boris = hero(bookId, 'boris');
            expect(boris.voice).to.deep.equal({ timbre: 'My own Boris.', manner: '', timbre_source: 'user' });
            expect(boris.passport).to.deep.equal({ appearance: 'old man, grey beard', clothes: 'fur coat', video_tokens: ['old man'] });
        });

        it('scenes of the second window refer to the final ids', () => {
            const { bookId } = twoWindows();
            const sc = sceneByTitle(bookId, 'В дороге');
            expect(sc.participants).to.deep.equal(['yura', 'boris', 'zhenshchina_v_budochke', 'boris_2']);
            expect(sc.units.find((u) => u.type === 'dialogue').audio.speaker).to.equal('yura');
        });

        it('writing the same window twice changes no hero: same ids, same files', () => {
            const first = firstWindow();
            const snapshot = () => heroFiles(first.bookId).map((n) => [n, fs.readFileSync(path.join(first.dir, 'characters', n), 'utf8')]);
            const before = snapshot();
            const again = lazyBook.appendToBook(first.bookId, windowOne(), { chapterIndex: 1, chapterTitle: 'Повтор' });
            expect(snapshot()).to.deep.equal(before);
            expect(again.newHeroes).to.deep.equal([]);
            expect(again.heroIdMap).to.deep.equal({ 'Юра': 'yura', 'Анна Сергеевна': 'anna_sergeevna', 'Женщина в будочке': 'zhenshchina_v_budochke', book: 'book_2' });
        });
    });

    describe('reconciliation → scene.look_patch only where it differs', () => {
        it('tokens equal to the hero\'s current look leave no look_patch; different tokens are written', () => {
            const { bookId } = firstWindow();
            const sc = sceneByTitle(bookId, 'У окна');
            // yura: reconciled tokens differ → written; anna: the same as her passport → nothing
            expect(sc.look_patch).to.deep.equal({ yura: { video_tokens: ['man', 'snow on shoulders'] } });
        });

        it('a scene where every participant keeps its tokens has no look_patch key at all', () => {
            const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
            const w = windowOne();
            w.scenes[0].passport = { 'Юра': { video_tokens: ['man', 'dark hair'] }, 'Анна Сергеевна': { video_tokens: [' woman ', 'red hair'] } };
            lazyBook.createFromAnalysis(bookId, w);
            expect(sceneByTitle(bookId, 'У окна')).to.not.have.property('look_patch');
        });

        it('the comparison is with the RESOLVED look: under a chapter look the look\'s tokens are "current"', () => {
            const first = firstWindow();
            const book = vbook.loadBook(first.bookId);
            const chapter = book.chapters.find((c) => c.chapter_index === 0);
            vbook.characterStore.updateCharacter(first.dir, 'yura', (h) => ({ ...h, looks: [{ id: 'coat', label: 'В пальто', fields: { video_tokens: ['man', 'grey coat'] } }] }));
            chapter.looks = { yura: 'coat' };
            vbook.saveBookBundle({ ...vbook.loadBook(first.bookId), chapters: book.chapters.map((c) => (c.chapter_id === chapter.chapter_id ? chapter : c)) });

            const w = windowTwo();
            w.scenes = [
                scene('Тот же облик', { characters_present: ['yura'], look_patch: { yura: { video_tokens: ['man', 'grey coat'] } } }),
                scene('Базовые токены поверх облика', { characters_present: ['yura'], look_patch: { yura: { video_tokens: ['man', 'dark hair'] } } }),
            ];
            lazyBook.appendToBook(first.bookId, w, { chapterIndex: 0 });
            expect(sceneByTitle(first.bookId, 'Тот же облик')).to.not.have.property('look_patch');
            // the base tokens DIFFER from what the chapter look gives → they are a real override here
            expect(sceneByTitle(first.bookId, 'Базовые токены поверх облика').look_patch).to.deep.equal({ yura: { video_tokens: ['man', 'dark hair'] } });
        });

        it('look_patch for somebody who is not a hero, foreign fields and empty values are dropped', () => {
            const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
            const w = windowOne();
            w.scenes[0].passport = undefined;
            w.scenes[0].look_patch = {
                'Юра': { clothes: 'bathrobe', appearance: '', hat: 'x', video_tokens: [] },
                stranger: { clothes: 'cloak' },
                'Голос': { clothes: 'cloak' },
            };
            lazyBook.createFromAnalysis(bookId, w);
            expect(sceneByTitle(bookId, 'У окна').look_patch).to.deep.equal({ yura: { clothes: 'bathrobe' } });
        });
    });

    describe('the registry of the next window comes from the hero files', () => {
        it('registryFromBook: heroes with a passport in book order, working fields ride along, the narrator is not a character', () => {
            const { bookId } = firstWindow();
            const book = vbook.loadBook(bookId);
            const working = [
                { id: 'yura', name: 'stale name', description: 'the doctor', traits: ['calm'], appearance: 'STALE' },
                { id: 'golos', name: 'Голос из трубки' },                                           // never a file: no appearance
                { id: 'deleted_hero', name: 'Удалённый', appearance: 'tall man with a scar' },    // described, no file → deleted by a person
            ];
            const registry = heroAnalysis.registryFromBook(book, working);
            expect(registry.map((c) => c.id)).to.deep.equal(['yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2', 'golos']);
            expect(registry[0]).to.deep.include({
                id: 'yura', name: 'Юра', role: 'protagonist', description: 'the doctor', traits: ['calm'],
                appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket',
            });
            expect(registry[0].aliases).to.deep.equal(['Юрий', 'Юрка', 'доктор']);
            expect(registry[0].voice).to.deep.equal({ timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.', manner: 'Speaks unhurriedly, with pauses.' });
            expect(registry[0].passport.video_tokens).to.deep.equal(['man', 'dark hair']);
            expect(registry[3]).to.not.have.property('voice');
        });

        it('what a person changed in a hero file is what the next window sees', () => {
            const { bookId, dir } = firstWindow();
            vbook.characterStore.updateCharacter(dir, 'yura', (h) => ({ ...h, name: 'Юрий Живаго', passport: { ...h.passport, clothes: 'white coat' }, aliases: ['Юра'] }));
            const registry = heroAnalysis.registryFromBook(vbook.loadBook(bookId), [{ id: 'yura', name: 'Юра', clothes: 'brown leather jacket' }]);
            expect(registry[0]).to.deep.include({ name: 'Юрий Живаго', clothes: 'white coat' });
            expect(registry[0].aliases).to.deep.equal(['Юра']);
        });

        it('mentionsFromBook: aliases of heroes from the files, non-hero mentions from the working map, ambiguous ones for nobody', () => {
            const { bookId, dir } = firstWindow();
            vbook.characterStore.updateCharacter(dir, 'book_2', (h) => ({ ...h, aliases: ['старик', 'Аня'] }));
            const mentions = heroAnalysis.mentionsFromBook(vbook.loadBook(bookId), {
                'незнакомец': 'stranger_at_the_door',   // not a hero → kept from the working map
                'Юрий': 'somebody_else',                 // contradicts the file → the file wins
                'Аня': 'anna_sergeevna',                 // two heroes claim it in the files → for nobody
                'устаревший': 'yura',                    // a hero target that is not in the file → not resurrected
            });
            expect(mentions).to.deep.equal({
                'незнакомец': 'stranger_at_the_door', 'Юрий': 'yura', 'Юрка': 'yura', 'доктор': 'yura', 'Анна': 'anna_sergeevna', 'старик': 'book_2',
            });
        });

        it('normalizeWindowCharacters gives the pipeline canonical ids before anything refers to them', () => {
            const { bookId } = firstWindow();
            const registry = heroAnalysis.registryFromBook(vbook.loadBook(bookId), []);
            const out = heroAnalysis.normalizeWindowCharacters([
                { id: 'Юрий', name: 'Юрий', appearance: 'x' },
                { id: 'Новый Герой', name: 'Новый Герой', alias: 'Новичок' },
                { id: '!!!', name: '' },
            ], registry);
            expect(out.characters.map((c) => [c.id, c.name])).to.deep.equal([['yura', 'Юрий'], ['novyy_geroy', 'Новый Герой']]);
            expect(out.characters[1].aliases).to.deep.equal(['Новичок']);
            expect(out.characters[1]).to.not.have.property('alias');
            expect(Object.fromEntries(out.idMap)).to.deep.equal({ 'Юрий': 'yura', 'Новый Герой': 'novyy_geroy' });
            expect(out.skipped).to.deep.equal([{ id: '!!!', name: null, reason: 'empty_id' }]);
            expect(heroAnalysis.remapMentions({ 'дядя': 'Юрий', 'x': 'unknown' }, out.idMap)).to.deep.equal({ 'дядя': 'yura', 'x': 'unknown' });
        });
    });

    describe('an id with a collision suffix is not evidence of identity', () => {
        const { mergeCharacterLists, findCanonicalCharacter } = require('../src/character-identity');
        it('boris_2 "Савелий Кузьмич" is not merged into boris "Борис" when the working lists are merged', () => {
            const existing = [{ id: 'yura', name: 'Юра', appearance: 'a man' }];
            const incoming = [
                { id: 'boris', name: 'Борис', appearance: 'old man, grey beard' },
                { id: 'boris_2', name: 'Савелий Кузьмич', appearance: 'a boy of ten' },
            ];
            const out = mergeCharacterLists(existing, incoming, { skipGeneric: true });
            expect(out.characters.map((c) => c.id)).to.deep.equal(['yura', 'boris', 'boris_2']);
            expect(out.added).to.equal(2);
            expect(findCanonicalCharacter(incoming[1], [incoming[0]])).to.equal(null);
        });
        it('…while a fuller name of the same person still is', () => {
            const out = mergeCharacterLists([{ id: 'boris', name: 'Борис', appearance: 'old man' }], [{ id: 'boris_petrovich', name: 'Борис Петрович', appearance: 'old man' }]);
            expect(out.characters.map((c) => c.id)).to.deep.equal(['boris']);
        });
        it('the same id is always the same character, suffix or not', () => {
            const list = [{ id: 'boris_2', name: 'Савелий Кузьмич', appearance: 'a boy' }];
            expect(findCanonicalCharacter({ id: 'boris_2', name: 'Савелий' }, list)).to.equal(list[0]);
        });
        it('working lists merge voices and aliases without replacing what is there', () => {
            const voiceBlock = { timbre: 'Kept.', manner: '' };
            const out = mergeCharacterLists(
                [{ id: 'yura', name: 'Юра', appearance: 'a man', aliases: ['Юрий'], voice: voiceBlock }],
                [{ id: 'yura', name: 'Юра', appearance: 'a man', aliases: ['юрий', 'Юрка', 'Юра'], voice: { timbre: 'A much longer and different description.', manner: 'x' } }],
            );
            expect(out.characters[0].voice).to.equal(voiceBlock);
            expect(out.characters[0].aliases).to.deep.equal(['Юрий', 'Юрка']);
        });
    });

    describe('mergeWindowIntoHero — add what is missing, never replace', () => {
        const base = { schema: 'animastor.character/1', id: 'yura', name: 'Юра', aliases: ['Юрий'], passport: { appearance: 'a', clothes: 'c', video_tokens: ['t'] } };
        const proposed = { timbre: 'New timbre.', manner: 'New manner.', timbre_source: 'analysis' };

        it('returns the same object when there is nothing to add', () => {
            expect(heroAnalysis.mergeWindowIntoHero(base, {})).to.equal(base);
            expect(heroAnalysis.mergeWindowIntoHero(base, { aliases: ['Юрий', ' юрий ', 'Юра'] })).to.equal(base);
            expect(heroAnalysis.mergeWindowIntoHero(base, { passport: { appearance: 'other' } })).to.equal(base);
            const voiced = { ...base, voice: { timbre: 'Kept.', manner: 'Kept too.', timbre_source: 'analysis' } };
            expect(heroAnalysis.mergeWindowIntoHero(voiced, { voice: proposed })).to.equal(voiced);
            expect(heroAnalysis.mergeWindowIntoHero(base, { voice: { timbre: '', manner: 'x' } })).to.equal(base);
        });

        const PROTECTED = [
            ['edited by a person', { timbre: '', manner: '', timbre_source: 'user' }],
            ['with a locked reference', { timbre: '', manner: '', timbre_source: 'cleaned', reference: { file: 'voices/yura/c1.wav', sha256: SHA, ref_text: 'x', source: 'uploaded', locked: true } }],
        ];
        for (const [label, voiceBlock] of PROTECTED) {
            it(`a voice ${label} is never touched, even where it is empty`, () => {
                const hero = { ...base, voice: voiceBlock };
                expect(heroAnalysis.mergeWindowIntoHero(hero, { voice: proposed })).to.equal(hero);
                expect(voice.isVoiceProtected(voiceBlock)).to.equal(true);
            });
        }

        it('an unlocked reference does not protect: the empty parts are filled, the reference stays', () => {
            const ref = { file: 'voices/yura/c1.wav', sha256: SHA, ref_text: 'x', source: 'uploaded', locked: false };
            const hero = { ...base, voice: { timbre: 'Kept.', manner: '', timbre_source: 'cleaned', reference: ref } };
            const next = heroAnalysis.mergeWindowIntoHero(hero, { voice: proposed });
            expect(next.voice).to.deep.equal({ timbre: 'Kept.', manner: 'New manner.', timbre_source: 'cleaned', reference: ref });
            expect(hero.voice.manner).to.equal(''); // input not mutated
        });

        it('adds aliases, a missing voice and a missing passport in one go', () => {
            const voiceOnly = { schema: 'animastor.character/1', id: 'boris', name: 'Борис' };
            const next = heroAnalysis.mergeWindowIntoHero(voiceOnly, { aliases: ['дед', 'Борис', 'Дед'], voice: proposed, passport: { appearance: 'old', clothes: '', video_tokens: ['old man'] } });
            expect(next).to.deep.equal({ ...voiceOnly, aliases: ['дед'], passport: { appearance: 'old', clothes: '', video_tokens: ['old man'] }, voice: proposed });
            expect(voiceOnly).to.deep.equal({ schema: 'animastor.character/1', id: 'boris', name: 'Борис' });
        });
    });

    describe('aliasAdditions — which mentions become aliases', () => {
        const heroes = [
            { id: 'yura', name: 'Юра', aliases: ['Юрий'] },
            { id: 'boris', name: 'Борис' },
            { id: 'anna', name: 'Анна' },
        ];
        it('adds new spellings, skips what the hero already has, rejects non-heroes and anything that would be ambiguous', () => {
            const { additions, rejected } = heroAnalysis.aliasAdditions(heroes, {
                'Юрка': 'yura', 'юрий': 'yura', 'Юра': 'yura',      // new / already an alias / the hero's own name
                'дед': 'boris',
                'Юрий': 'boris',                                     // an alias of yura
                'Анна': 'boris',                                     // the NAME of another hero
                'сосед': 'yura', 'Сосед': 'anna',                    // two heroes claim it in this window
                'незнакомец': 'stranger',
            });
            expect(Object.fromEntries(additions)).to.deep.equal({ yura: ['Юрка'], boris: ['дед'] });
            expect(rejected).to.deep.equal([
                { alias: 'Юрий', target: 'boris', reason: 'ambiguous_alias' },
                { alias: 'Анна', target: 'boris', reason: 'ambiguous_alias' },
                { alias: 'сосед', target: 'yura', reason: 'ambiguous_alias' },
                { alias: 'Сосед', target: 'anna', reason: 'ambiguous_alias' },
                { alias: 'незнакомец', target: 'stranger', reason: 'not_a_hero' },
            ]);
        });
        it('does not mutate the heroes', () => {
            const before = JSON.stringify(heroes);
            heroAnalysis.aliasAdditions(heroes, { 'дед': 'boris' });
            expect(JSON.stringify(heroes)).to.equal(before);
        });
    });
});
