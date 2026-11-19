// ======================================================
// VBook 4, step 2 — the analysis writes heroes (backend level)
// ======================================================
// VBOOK_FORMAT_V4 §12 «Шаг 2». The real pipeline-runner and the real
// lazy-book writer, with the LLM steps replaced by scripted answers:
//   - hero ids the model returns are canonical before a scene refers to them;
//   - two windows in a row on a fixture: the cast, timbre / manner, aliases,
//     a locked reference and a person's edits survive the second window;
//   - the voice step accepts { timbre, manner }, repairs a string, drops plot
//     text, refuses what has no timbre;
//   - passport reconciliation writes scene.look_patch only where it differs;
//   - the registry of a window is read from the hero files, not from memory.
// The package-level halves: packages/animastor-vbook-runtime/test/
// hero-id.test.js and hero-analysis-window.test.js.

'use strict';

require('./vbook-test-bindings.cjs');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config/runtime-config');
const book = require('@animastor/vbook-runtime');
const lazyBook = require('@animastor/vbook-runtime/lazy-book');
const heroAnalysis = require('@animastor/vbook-runtime/hero-analysis.cjs');
const voicePort = require('@animastor/vbook-runtime/voice');
const { generateVoices } = require('@animastor/ai-analysis/tasks/character-analyzer');
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');

const SOURCE = 'Глава 1. Встреча\n\nЮра вошёл в комнату и остановился у окна.\n\n— Ты опоздал, — сказала Анна.\n\nГлава 2. Дорога\n\nОни ехали молча.\n';
const SHA = 'b'.repeat(64);
const LEGACY = ['characters.json', 'voices.json', 'behavior.json', 'mentions.json'];

// ── the model, scripted ────────────────────────────────────────────────
// Each window: what the character step, the voice step, the scene step and
// the reconciliation step "return".
const WINDOW_ONE = {
    characters: [
        { id: 'Юра', name: 'Юра', role: 'protagonist', appearance: 'man in his thirties, short dark hair', clothes: 'brown leather jacket', video_tokens: ['man', 'dark hair'] },
        { id: 'Анна Сергеевна', name: 'Анна Сергеевна', alias: 'Анна', appearance: 'tall woman, red hair', clothes: 'green dress', video_tokens: ['woman', 'red hair'] },
        { id: 'Женщина в будочке', name: 'Женщина в будочке', appearance: 'stout woman in a kiosk window', clothes: 'white apron', video_tokens: ['stout woman'] },
        { id: 'book', name: 'Книжник', appearance: 'old man with a grey beard', clothes: 'worn coat', video_tokens: ['old man'] },
    ],
    mentions: { 'Юрий': 'Юра', 'доктор': 'Юра', 'Аня': 'Анна Сергеевна', 'незнакомец': 'stranger_at_the_door' },
    // keyed by the ids the PIPELINE shows the model (canonical)
    voices: {
        yura: { timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.', manner: 'Speaks unhurriedly, with pauses.' },
        anna_sergeevna: { timbre: 'A clear female alto. Native Russian pronunciation.', manner: 'Speaks quickly. Cheerful inflection on the word «поехали».' },
        zhenshchina_v_budochke: 'A sharp middle-aged female voice. When annoyed, she snaps.',
        book_2: { manner: 'Mumbles.' },
    },
    scenes: (ids) => [
        { title: 'У окна', text: 'Юра вошёл в комнату и остановился у окна.', characters_present: [ids.yura, ids.anna], location: { id: 'room' } },
        { title: 'У будочки', text: 'Женщина в будочке молчала.', characters_present: [ids.kiosk, ids.book], location: { id: 'street' } },
    ],
    // reconciliation: scene 0 — yura changes, anna keeps her tokens; scene 1 — nobody changes
    videoTokens: (ids) => [
        { scene_index: 0, tokens: { [ids.yura]: ['man', 'snow on shoulders'], [ids.anna]: ['woman', 'red hair'] } },
        { scene_index: 1, tokens: { [ids.kiosk]: ['stout woman'], [ids.book]: ['old man'] } },
    ],
};

const WINDOW_TWO = {
    characters: [
        { id: 'yuriy', name: 'Юрий', appearance: 'a tired man', clothes: 'grey coat', video_tokens: ['man', 'grey coat'] },
        { id: 'anna_sergeevna', name: 'Анна Сергеевна', appearance: 'tall woman', clothes: 'coat' },
        { id: 'Борис', name: 'Борис', appearance: 'old man, grey beard', clothes: 'fur coat', video_tokens: ['old man', 'fur coat'] },
        { id: 'БОРИС', name: 'Савелий Кузьмич', appearance: 'a boy of ten', clothes: 'school uniform', video_tokens: ['boy'] },
    ],
    mentions: { 'Живаго': 'yuriy', 'дед': 'Борис', 'доктор': 'Борис' },
    voices: {
        yura: { timbre: 'A COMPLETELY different voice.', manner: 'Shouts.' },
        anna_sergeevna: { timbre: 'Another voice.', manner: 'Whispers.' },
        boris: { timbre: 'A hoarse old male voice. Native Russian pronunciation.' },
        boris_2: { timbre: 'A thin boyish voice. Native Russian pronunciation.', manner: 'Fast.' },
    },
    scenes: (ids) => [
        { title: 'В дороге', text: 'Они ехали молча.', characters_present: [ids.yura, ids.boris, ids.boris2], location: { id: 'road' } },
    ],
    videoTokens: (ids) => [
        { scene_index: 0, tokens: { [ids.yura]: ['man', 'dark hair'], [ids.boris]: ['old man', 'grey beard'], [ids.boris2]: ['boy'] } },
    ],
};

function makePipeline(script, seen = {}) {
    const callAI = async () => ({ voices: script.voices });
    const pipelineSteps = {
        stepExtractCharacters: async (...args) => {
            seen.knownHeroes = args[5];
            return { characters: JSON.parse(JSON.stringify(script.characters)), mentions: { ...script.mentions } };
        },
        // the REAL voice step of @animastor/ai-analysis; only the LLM call is scripted
        stepGenerateVoices: async (sessionId, text, characters) => generateVoices(
            { windowText: text, characters, promptProfiles: {}, language: 'ru', sessionId, stepIndex: 0 },
            {
                callAI,
                logConversation: async () => {}, updateSession: async () => {},
                createStep: async () => ({ step_id: 'st' }), completeStep: async () => {}, failStep: async () => {},
                voiceGenerationMessage: 'voices', prompt: () => 'PROMPT %CHARACTERS%', fillLang: (t) => t, buildSkill: () => null,
            },
        ),
        stepExtractLocations: async () => [{ id: 'room', name: 'Комната' }],
        stepCreateScenes: async (sessionId, text, characters) => {
            seen.sceneStepCharacters = characters.map((c) => c.id);
            const id = (name) => (characters.find((c) => c.name === name) || {}).id;
            seen.ids = {
                yura: id('Юра'), anna: id('Анна Сергеевна'), kiosk: id('Женщина в будочке'), book: id('Книжник'),
                boris: id('Борис'), boris2: id('Савелий Кузьмич'),
                // step 2b scenario (Мастер и Маргарита): by id
                berlioz: characters.some((c) => c.id === 'mikhail_berlioz') ? 'mikhail_berlioz' : undefined,
                ivan: characters.some((c) => c.id === 'ivan_ponyrev') ? 'ivan_ponyrev' : undefined,
                voland: characters.some((c) => c.id === 'voland') ? 'voland' : undefined,
            };
            return script.scenes(seen.ids);
        },
        stepCreateUnits: async (sessionId, scene) => [{ type: 'narration', text: scene.text }],
        stepCreateVisuals: async (sessionId, scene) => [{ type: 'narration', text: scene.text, image: { shot: 'wide', prompt: 'a wide shot' }, video: { action: 'slow pan' } }],
        stepReconcilePassports: async (sessionId, units, characters, stepIndex, progress, scenes) => {
            seen.reconcileScenes = scenes.map((s) => ({ participants: s.participants }));
            return { units, videoTokens: script.videoTokens(seen.ids) };
        },
        stepReconcileVideoActions: async (sid, units) => units,
        stepPolishStoryboard: async (sid, units) => units,
        stepPolishVideoActions: async (sid, units) => units,
        stepRepairFantasyIds: async () => ({ units: [] }),
        applyRepairToScenes: () => {},
        needsVideoActionReconciliation: () => false,
    };
    const mod = proxyquire('../src/services/agent/pipeline-runner', {
        '@animastor/parser/source-coverage': {
            computeSceneCoverage: () => ({ ok: true, next_offset: 100, covered_end_offset: 100, scene_spans: [{ source_start: 0, source_end: 50 }, { source_start: 50, source_end: 100 }] }),
            findLastSceneEndOffset: () => ({ ok: true, source_end: 100, method: 'test' }),
            findNarrativeStartOffset: () => 0,
        },
        '../../book/lazy-book': { injectChapterMarkers: (t) => t, splitIntoChapters: () => [], firstMeaningfulChapter: null },
        '../../config/runtime-config': {},
        '../agent-session': { updateSession: async () => {}, createSession: async () => ({ session_id: 's' }), isSessionCancelled: async () => false, isBookCancelled: async () => false },
        '../agent-prompts': {
            PROGRESS_STAGES: { extracting_chars: 'c', analyzing_structure: 'a', creating_scenes: 's', creating_units: (i) => `u${i}`, creating_visuals: (i) => `v${i}` },
            MAX_WINDOW_CHARS: 100000, MAX_SCENES_PER_CHUNK: 5, computeWindowChars: () => 100000,
        },
        './pipeline-steps': pipelineSteps,
        './unit-splitter': { splitLongUnits: async (sid, scene, units) => units },
        './text-utils': { buildFallbackScenes: () => [] },
    });
    return { mod, seen };
}

async function runWindow(script, registry, mentions) {
    const { mod, seen } = makePipeline(script);
    const result = await mod.runPipeline('sess', 'Window text.', registry, [], 0, () => {}, 0, {
        rawWindowText: 'Window text.', chunkSize: 5, existingMentions: mentions,
    });
    return { result, seen };
}

describe('VBook 4 step 2 — the analysis writes heroes (backend)', function () {
    this.timeout(20000);
    let sandbox, savedBooks, quiet;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-step2-'));
        savedBooks = config.BOOKS_DIR;
        config.BOOKS_DIR = path.join(sandbox, 'books');
        fs.mkdirSync(config.BOOKS_DIR);
        configureBooksRoot(() => config.BOOKS_DIR);
        quiet = { log: console.log, warn: console.warn };
        console.log = () => {}; console.warn = () => {};
    });
    afterEach(() => {
        console.log = quiet.log; console.warn = quiet.warn;
        config.BOOKS_DIR = savedBooks;
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const structure = { title: 'Зима', author: 'А. Автор', chapters: [{ type: 'chapter', number: 1, title: 'Встреча' }, { type: 'chapter', number: 2, title: 'Дорога' }] };
    const hero = (bookId, id) => book.heroes.findHero(book.loadBook(bookId), id);
    // scenes of the analysis, without cover / title-card scenes
    const narrative = (bookId) => book.loadBook(bookId).chapters.flatMap((c) => c.scenes).filter((s) => ['У окна', 'У будочки', 'В дороге'].includes(s.scene_title));
    const heroFiles = (bookId) => fs.readdirSync(path.join(config.BOOKS_DIR, bookId, 'characters')).sort();

    /** Window 1 the way bootstrap does it: registry from the book → pipeline → createFromAnalysis. */
    async function firstWindow() {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'zima.txt');
        const draft = lazyBook.loadDraftBook(bookId);
        const { result, seen } = await runWindow(WINDOW_ONE, heroAnalysis.registryFromBook(draft, []), heroAnalysis.mentionsFromBook(draft, {}));
        const written = lazyBook.createFromAnalysis(bookId, {
            characters: result.characters, locations: result.locations, mentions: result.mentions, scenes: result.scenes, structure, maxScenes: 5,
        });
        return { bookId, dir: path.join(config.BOOKS_DIR, bookId), result, seen, written };
    }

    /** Window 2 the way bootstrapNextWindow does it: registry and mentions come from the hero files. */
    async function secondWindow(first, pgWindowData = null) {
        const draft = lazyBook.loadDraftBook(first.bookId);
        const working = pgWindowData || { all_characters: first.result.characters, all_mentions: first.result.mentions };
        const registry = heroAnalysis.registryFromBook(draft, working.all_characters);
        const mentions = heroAnalysis.mentionsFromBook(draft, working.all_mentions);
        // (the pipeline adds the mentions of the window to the map it is given)
        const { result, seen } = await runWindow(WINDOW_TWO, registry, { ...mentions });
        const written = lazyBook.appendToBook(first.bookId, {
            characters: result.characters, locations: result.locations, mentions: result.mentions, scenes: result.scenes, structure, maxScenes: 5, chapterIndex: 1,
        });
        return { result, seen, written, registry, mentions };
    }

    describe('hero ids are canonical before anything refers to them', () => {
        it('Russian ids from the model → canonical ids in the character list the scene step receives', async () => {
            const { seen, result } = await firstWindow();
            expect(seen.sceneStepCharacters).to.deep.equal(['yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2']);
            expect(result.characters.map((c) => [c.id, c.name])).to.deep.equal([
                ['yura', 'Юра'], ['anna_sergeevna', 'Анна Сергеевна'], ['zhenshchina_v_budochke', 'Женщина в будочке'], ['book_2', 'Книжник'],
            ]);
            for (const c of result.characters) expect(c.id).to.match(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
        });

        it('mentions of the window point at the final ids; a non-hero target is left as it is', async () => {
            const { result } = await firstWindow();
            expect(result.mentions).to.deep.equal({ 'Юрий': 'yura', 'доктор': 'yura', 'Аня': 'anna_sergeevna', 'незнакомец': 'stranger_at_the_door' });
        });

        it('scenes of the window carry the final ids as participants', async () => {
            const { bookId } = await firstWindow();
            expect(narrative(bookId).map((s) => s.participants)).to.deep.equal([['yura', 'anna_sergeevna'], ['zhenshchina_v_budochke', 'book_2']]);
        });

        it('the same hero keeps its id in the next window whatever the model calls it; a collision inside a window gets a suffix', async () => {
            const first = await firstWindow();
            const second = await secondWindow(first);
            // "Юрий" is an alias of yura (from the mentions of window 1); "Савелий Кузьмич" shares the raw id of Борис
            expect(second.seen.sceneStepCharacters).to.deep.equal(['yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2', 'boris', 'boris_2']);
            expect(heroFiles(first.bookId)).to.deep.equal([
                'anna_sergeevna.json', 'book_2.json', 'boris.json', 'boris_2.json', 'narrator.json', 'yura.json', 'zhenshchina_v_budochke.json',
            ]);
            expect(second.written.newHeroes).to.deep.equal(['boris', 'boris_2']);
            expect(hero(first.bookId, 'boris_2').name).to.equal('Савелий Кузьмич');
        });

        it('running the second window again changes nothing: same ids, no new files', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            const before = heroFiles(first.bookId).map((n) => [n, fs.readFileSync(path.join(first.dir, 'characters', n), 'utf8')]);
            const again = await secondWindow(first);
            expect(again.written.newHeroes).to.deep.equal([]);
            expect(heroFiles(first.bookId).map((n) => [n, fs.readFileSync(path.join(first.dir, 'characters', n), 'utf8')])).to.deep.equal(before);
        });

        it('an ambiguous alias does not merge heroes', async () => {
            const first = await firstWindow();
            // a person gives two heroes the same alias
            book.characterStore.updateCharacter(first.dir, 'book_2', (h) => ({ ...h, aliases: ['Старик'] }));
            book.characterStore.updateCharacter(first.dir, 'zhenshchina_v_budochke', (h) => ({ ...h, aliases: ['старик'] }));
            const draft = lazyBook.loadDraftBook(first.bookId);
            const registry = heroAnalysis.registryFromBook(draft, []);
            const out = heroAnalysis.normalizeWindowCharacters([{ id: 'Старик', name: 'Старик', appearance: 'an old man' }], registry);
            expect(out.characters.map((c) => c.id)).to.deep.equal(['starik']);
            expect(out.assignments[0].existing).to.equal(false);
            // and the alias index of the book leaves it out
            expect(heroAnalysis.mentionsFromBook(draft, {})).to.not.have.any.keys('Старик', 'старик');
        });
    });

    describe('two windows in a row', () => {
        it('the cast: one file per hero, no 3.1 files, valid, in book order', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            const loaded = book.loadBook(first.bookId);
            expect(loaded.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'book_2', 'boris', 'boris_2']);
            expect(loaded.hero_issues).to.deep.equal([]);
            for (const legacy of LEGACY) expect(fs.existsSync(path.join(first.dir, legacy)), legacy).to.equal(false);
            expect(loaded.manifest.vbook_version).to.equal(4);
        });

        it('every speaking hero has timbre and manner as separate fields; nothing is called instruction', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            expect(hero(first.bookId, 'yura').voice).to.deep.equal({
                timbre: 'A warm low male baritone, early thirties. Native Russian pronunciation.',
                manner: 'Speaks unhurriedly, with pauses.',
                timbre_source: 'analysis',
            });
            expect(hero(first.bookId, 'boris_2').voice).to.deep.equal({ timbre: 'A thin boyish voice. Native Russian pronunciation.', manner: 'Fast.', timbre_source: 'analysis' });
            expect(hero(first.bookId, 'boris').voice).to.deep.equal({ timbre: 'A hoarse old male voice. Native Russian pronunciation.', manner: '', timbre_source: 'analysis' });
            const narrator = hero(first.bookId, 'narrator').voice;
            expect(narrator.timbre).to.not.equal('');
            expect(narrator.manner).to.not.equal('');
            expect(JSON.stringify(book.loadBook(first.bookId).heroes)).to.not.include('instruction');
            // the one text for TTS is join(timbre, manner)
            expect(book.heroes.voiceInstruct(hero(first.bookId, 'yura')))
                .to.equal('A warm low male baritone, early thirties. Native Russian pronunciation. Speaks unhurriedly, with pauses.');
        });

        it('the LLM returned a plot-bound phrase → it is in neither field; a string → repaired; no timbre → no voice', async () => {
            const { bookId } = await firstWindow();
            expect(hero(bookId, 'anna_sergeevna').voice).to.deep.equal({ timbre: 'A clear female alto. Native Russian pronunciation.', manner: 'Speaks quickly.', timbre_source: 'cleaned' });
            // rules v3 (step 2b): the pronunciation suffix of the book language is added to timbre
            expect(hero(bookId, 'zhenshchina_v_budochke').voice).to.deep.equal({ timbre: 'A sharp middle-aged female voice. Native Russian pronunciation.', manner: '', timbre_source: 'cleaned' });
            // { manner } without a timbre is refused: the hero exists, without a voice block
            expect(hero(bookId, 'book_2')).to.not.have.property('voice');
            expect(voicePort.getCharacterVoice(book.loadBook(bookId), 'book_2')).to.equal(null);
        });

        it('aliases come from the mentions; mentions.json is never created; a non-hero mention is in no file', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            expect(hero(first.bookId, 'yura').aliases).to.deep.equal(['Юрий', 'доктор', 'Живаго']);
            expect(hero(first.bookId, 'anna_sergeevna').aliases).to.deep.equal(['Анна', 'Аня']);
            expect(hero(first.bookId, 'boris').aliases).to.deep.equal(['дед']);   // "доктор" is yura's — not written twice
            expect(fs.existsSync(path.join(first.dir, 'mentions.json'))).to.equal(false);
            expect(JSON.stringify(book.loadBook(first.bookId).heroes)).to.not.include('незнакомец');
            expect(book.heroes.buildAliasIndex(book.loadBook(first.bookId).heroes).ambiguous).to.deep.equal([]);
        });

        it('the second window does not replace a voice, a passport or looks of an existing hero', async () => {
            const first = await firstWindow();
            const before = JSON.parse(JSON.stringify(hero(first.bookId, 'anna_sergeevna')));
            await secondWindow(first);
            expect(hero(first.bookId, 'anna_sergeevna')).to.deep.equal(before);
            expect(hero(first.bookId, 'yura').voice.timbre).to.equal('A warm low male baritone, early thirties. Native Russian pronunciation.');
            expect(hero(first.bookId, 'yura').passport.clothes).to.equal('brown leather jacket');
        });

        it('a locked reference and locked: true survive the second window', async () => {
            const first = await firstWindow();
            const reference = { file: 'voices/yura/c1.wav', sha256: SHA, ref_text: 'Фраза.', source: 'designed', verification: 'passed', locked: true };
            const loaded = book.loadBook(first.bookId);
            voicePort.setCharacterVoiceReference(loaded, 'yura', reference);
            book.saveBookBundle(loaded);
            await secondWindow(first);
            const voice = hero(first.bookId, 'yura').voice;
            expect(voice.reference).to.deep.equal(reference);
            expect(voice.timbre).to.equal('A warm low male baritone, early thirties. Native Russian pronunciation.');
            const read = voicePort.getCharacterVoice(book.loadBook(first.bookId), 'yura');
            expect(read.reference).to.include({ locked: true, sha256: SHA, verification: 'passed' });
            expect(read.reference_problem).to.equal(null);
        });

        it('a person\'s edits (timbre_source: user, looks, notes, name) are not touched by the second window', async () => {
            const first = await firstWindow();
            const edited = {
                voice: { timbre: 'Edited by hand.', manner: '', timbre_source: 'user' },
                looks: [{ id: 'coat', label: 'В пальто', fields: { clothes: 'long grey coat' } }],
                notes: 'заметка автора',
            };
            book.characterStore.updateCharacter(first.dir, 'yura', (h) => ({ ...h, ...edited, name: 'Юрий Андреевич Живаго' }));
            const second = await secondWindow(first);
            const yura = hero(first.bookId, 'yura');
            expect(yura.voice).to.deep.equal(edited.voice);       // the empty manner is NOT filled either
            expect(yura.looks).to.deep.equal(edited.looks);
            expect(yura.notes).to.equal('заметка автора');
            expect(yura.name).to.equal('Юрий Андреевич Живаго');
            // the voice step was not even shown yura as a character without a voice;
            // the working copy is marked protected, so its empty manner is not asked for (step 2b rest)
            expect(second.result.characters.find((c) => c.id === 'yura').voice).to.deep.equal({ timbre: 'Edited by hand.', manner: '', protected: true });
        });

        it('the registry of the second window is the BOOK: a person\'s change is seen, a deleted hero is not brought back from memory', async () => {
            const first = await firstWindow();
            book.characterStore.updateCharacter(first.dir, 'anna_sergeevna', (h) => ({ ...h, passport: { ...h.passport, clothes: 'white coat' } }));
            book.characterStore.removeCharacter(first.dir, 'zhenshchina_v_budochke');
            const second = await secondWindow(first);
            expect(second.registry.map((c) => c.id)).to.deep.equal(['yura', 'anna_sergeevna', 'book_2']);
            expect(second.registry.find((c) => c.id === 'anna_sergeevna').clothes).to.equal('white coat');
            expect(heroFiles(first.bookId)).to.not.include('zhenshchina_v_budochke.json');
            // mentions for the prompts: aliases from the files + non-hero targets from the working map
            expect(second.mentions).to.deep.equal({ 'Юрий': 'yura', 'доктор': 'yura', 'Анна': 'anna_sergeevna', 'Аня': 'anna_sergeevna', 'незнакомец': 'stranger_at_the_door' });
        });
    });

    describe('passport reconciliation → scene.look_patch only where it differs', () => {
        it('the reconciliation step sees participants by final ids; a changed token set is written, an equal one is not', async () => {
            const { bookId, seen } = await firstWindow();
            expect(seen.reconcileScenes.map((s) => s.participants)).to.deep.equal([['yura', 'anna_sergeevna'], ['zhenshchina_v_budochke', 'book_2']]);
            const scenes = narrative(bookId);
            expect(scenes[0].look_patch).to.deep.equal({ yura: { video_tokens: ['man', 'snow on shoulders'] } });
            expect(scenes[1]).to.not.have.property('look_patch');
            for (const s of scenes) expect(s).to.not.have.property('passport');
        });

        it('the result of the pipeline carries look_patch, never scene.passport', async () => {
            const { result } = await firstWindow();
            expect(result.scenes[0].look_patch).to.deep.equal({ yura: { video_tokens: ['man', 'snow on shoulders'] } });
            expect(result.scenes[1]).to.not.have.property('look_patch');
            for (const s of result.scenes) expect(s).to.not.have.property('passport');
        });

        it('window 2: tokens equal to the passport are not written; different ones are; the resolver gives the result', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            const loaded = book.loadBook(first.bookId);
            const chapter = loaded.chapters.find((c) => c.scenes.some((s) => s.scene_title === 'В дороге'));
            const scene = chapter.scenes.find((s) => s.scene_title === 'В дороге');
            // yura: ['man','dark hair'] = his passport → nothing; boris: differs → written; boris_2: ['boy'] = passport → nothing
            expect(scene.look_patch).to.deep.equal({ boris: { video_tokens: ['old man', 'grey beard'] } });
            expect(book.looks.resolveHeroLook(loaded, chapter, scene, 'boris')).to.deep.include({ source: 'base', patched: ['video_tokens'] });
            expect(book.looks.resolveHeroLook(loaded, chapter, scene, 'yura').patched).to.deep.equal([]);
        });
    });

    describe('the analysis modules read heroes through the helpers, not through 3.1 maps', () => {
        const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent', rel), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const FILES = ['bootstrap.js', 'pipeline-runner.js', 'pipeline-steps.js', 'parallel-analysis-orchestrator.js', 'hero-looks.js'];

        it('no module reads or writes scene.passport, book.voices / book.characters, or a 3.1 file', () => {
            for (const f of FILES) {
                const code = read(f);
                expect(code, `${f}: scene.passport written`).to.not.match(/\.passport\s*=(?!=)/);
                expect(code, `${f}: scene.passport read`).to.not.match(/scene\??\.passport\b(?!\s*===\s*undefined)/.test(code) && f !== 'hero-looks.js' ? /scene\??\.passport\b/ : /a^/);
                expect(code, `${f}: 3.1 map`).to.not.match(/\b(draft|book|loadedBook)\.(characters|voices|behaviors|mentions)\b/);
                expect(code, `${f}: 3.1 file`).to.not.match(/(characters|voices|mentions)\.json|behavior\.json/);
                expect(code, `${f}: instruction`).to.not.match(/\.instruction\b/);
            }
        });

        it('bootstrap takes the registry and the mentions of a window from the book', () => {
            const code = read('bootstrap.js');
            expect(code).to.match(/heroAnalysis\.registryFromBook\(draft, windowData\?\.all_characters\)/);
            expect(code).to.match(/heroAnalysis\.mentionsFromBook\(draft, windowData\?\.all_mentions\)/);
            expect(code).to.match(/heroAnalysis\.registryFromBook\(draft, \[\]\)/);
            expect(code).to.not.match(/windowData\?\.all_characters \|\| \[\]/);
            expect(code).to.not.match(/windowData\?\.all_mentions \|\| \{\}/);
        });

        it('the reconciliation reads and writes through resolveHeroLook', () => {
            expect(read('hero-looks.js')).to.match(/resolveHeroLook\(book, chapter, adoptLegacyScenePassport\(scene\), heroId\)/);
            expect(read('pipeline-runner.js')).to.match(/heroLooks\.applyReconciledTokens\(book, scene, row\.tokens\)/);
            expect(read('pipeline-steps.js')).to.match(/heroLooks\.currentSceneTokens\(/);
        });
    });

    // Acceptance 2.6 itself needs a real LLM (two windows of «Мастер и Маргарита»)
    // and is run by the owner; what is tested here is the CHECKER that gives the
    // verdict on the book such a run produces (scripts/check-vbook-v4-step2.cjs).
    describe('2.6 the acceptance checker (the LLM run itself is the owner\'s)', () => {
        const { checkBook, main } = require('../scripts/check-vbook-v4-step2.cjs');
        const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vbook-v4', 'mim-baseline.json'), 'utf8'));
        const voice = (t = 'A low male voice. Native Russian pronunciation.', m = 'Speaks slowly.') => ({ timbre: t, manner: m, timbre_source: 'analysis' });
        const passport = { appearance: 'a man', clothes: 'a suit', video_tokens: ['man'] };
        const goodBook = () => ({
            manifest: { vbook_version: 4, book_id: 'mim' },
            hero_issues: [],
            heroes: [
                { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: voice() },
                { schema: 'animastor.character/1', id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз', aliases: ['Берлиоз', 'редактор'], passport, voice: voice() },
                { schema: 'animastor.character/1', id: 'ivan_bezdomnyy', name: 'Иван Бездомный', aliases: ['Иван Николаевич', 'поэт'], passport, voice: voice() },
                { schema: 'animastor.character/1', id: 'voland', name: 'Воланд', aliases: ['иностранец', 'профессор'], passport, voice: voice() },
                { schema: 'animastor.character/1', id: 'annushka', name: 'Аннушка', passport },
            ],
        });
        const failed = (report) => report.checks.filter((c) => !c.ok).map((c) => c.name);

        it('a book with the three heroes of the baseline, voices filled, passes', () => {
            const report = checkBook(goodBook(), baseline);
            expect(report.ok, JSON.stringify(report.checks)).to.equal(true);
            expect(report.mapping).to.deep.equal({ berlioz: ['mikhail_berlioz'], bezdomny: ['ivan_bezdomnyy'], woland: ['voland'] });
        });

        it('a missing hero of the baseline fails "не хуже эталона"', () => {
            const b = goodBook(); b.heroes = b.heroes.filter((h) => h.id !== 'voland');
            expect(failed(checkBook(b, baseline))).to.deep.equal(['набор героев с паспортом не хуже эталона']);
            // a hero that lost its passport does not count either
            const c = goodBook(); delete c.heroes[3].passport;
            expect(failed(checkBook(c, baseline))).to.include('набор героев с паспортом не хуже эталона');
        });

        it('a false merge — two heroes of the baseline in one hero of the book — fails', () => {
            const b = goodBook();
            b.heroes = b.heroes.filter((h) => h.id !== 'ivan_bezdomnyy');
            b.heroes[1].aliases.push('Бездомный');
            const report = checkBook(b, baseline);
            expect(failed(report)).to.deep.equal(['ложных слияний и дубликатов нет']);
            expect(report.checks.find((c) => !c.ok).details[0]).to.match(/mikhail_berlioz.*berlioz, bezdomny.*ложное слияние/);
        });

        it('a duplicate — one hero of the baseline as two heroes — and an ambiguous alias fail', () => {
            const b = goodBook();
            b.heroes.push({ schema: 'animastor.character/1', id: 'berlioz', name: 'Берлиоз', passport, voice: voice() });
            expect(failed(checkBook(b, baseline))).to.deep.equal(['ложных слияний и дубликатов нет']);
            const c = goodBook(); c.heroes[4].aliases = ['Поэт'];
            expect(checkBook(c, baseline).checks.find((x) => !x.ok).details).to.deep.equal(['алиас «поэт» объявлен двумя героями']);
        });

        it('В4: an empty manner of a speaking hero or of the narrator is a warning, the book passes; an empty timbre fails', () => {
            const VOICE_CHECK = 'у диктора и говорящих героев заполнен timbre (пустая manner — предупреждение)';
            const b = goodBook(); b.heroes[2].voice = voice('A voice.', ''); b.heroes[0].voice.manner = '';
            const report = checkBook(b, baseline);
            expect(report.ok).to.equal(true);
            expect(report.warnings).to.have.length(2);
            expect(report.warnings.every((w) => w.endsWith('manner пустая'))).to.equal(true);
            const c = goodBook(); delete c.heroes[3].voice;
            expect(failed(checkBook(c, baseline))).to.deep.equal([VOICE_CHECK]);
            const e = goodBook(); e.heroes[0].voice.timbre = ' ';
            expect(checkBook(e, baseline).checks.find((x) => !x.ok).details).to.deep.equal(['диктор (narrator): timbre не заполнен']);
            const d = goodBook(); d.heroes[4].voice = { instruction: 'legacy' };
            expect(checkBook(d, baseline).checks.find((x) => !x.ok).details).to.deep.equal(['annushka: в голосе осталось поле instruction']);
        });

        it('the command line: WARN lines and exit 0 for an empty manner; the --allow-empty-manner flag is gone (exit 2)', () => {
            const { main } = require('../scripts/check-vbook-v4-step2.cjs');
            const lines = [];
            const saved = { log: console.log, error: console.error };
            console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
            try {
                expect(main(['/nonexistent-dir', '--allow-empty-manner'])).to.equal(2);
                expect(lines.join('\n')).to.include('Неизвестный флаг: --allow-empty-manner');
            } finally { console.log = saved.log; console.error = saved.error; }
        });

        it('a 3.1 book, a broken hero file, a non-canonical id fail their own checks', () => {
            const b = goodBook(); b.manifest.vbook_version = '3.1';
            expect(failed(checkBook(b, baseline, { legacyFiles: ['voices.json'] }))).to.deep.equal(['книга в формате VBook 4, файлов 3.1 нет']);
            const c = goodBook(); c.hero_issues = [{ file: 'characters/x.json', code: 'invalid_json', message: 'm', blocking: true }, { code: 'narrator_missing', message: 'm', blocking: false }];
            expect(failed(checkBook(c, baseline))).to.deep.equal(['файлы героев читаются (нет блокирующих проблем)']);
            const d = goodBook(); d.heroes[4].id = 'Аннушка';
            expect(failed(checkBook(d, baseline))).to.deep.equal(['id героев канонические']);
        });

        it('the command reads a book directory written by the analysis and exits 0 / 1 / 2', async () => {
            const first = await firstWindow();
            await secondWindow(first);
            const ownBaseline = path.join(sandbox, 'baseline.json');
            fs.writeFileSync(ownBaseline, JSON.stringify({ characters: [
                { id: 'yura', name: 'Юра', keys: ['юра', 'живаго'], speaks: true },
                { id: 'anna', name: 'Анна Сергеевна', keys: ['анна'], speaks: true },
            ] }));
            const out = []; const savedLog = console.log; const savedErr = console.error;
            console.log = (m) => out.push(String(m)); console.error = (m) => out.push(String(m));
            let ok, strict, missingBook;
            try {
                ok = main([first.dir, ownBaseline]);
                strict = main([first.dir]);                    // the MiM baseline: these heroes are not in this book
                missingBook = main([path.join(sandbox, 'books', 'no_such_book'), ownBaseline]);
            } finally { console.log = () => {}; console.error = savedErr; savedLog; }
            configureBooksRoot(() => config.BOOKS_DIR);
            expect(ok, out.join('\n')).to.equal(0);
            expect(strict).to.equal(1);
            expect(missingBook).to.equal(2);
            expect(out.join('\n')).to.include('ИТОГ: приёмка 2.6 пройдена').and.include('ИТОГ: приёмка 2.6 НЕ пройдена');

            // В4: an empty manner of a speaking hero → a WARN line, exit 0
            book.characterStore.updateCharacter(first.dir, 'yura', (h) => ({ ...h, voice: { ...h.voice, manner: '' } }));
            const warnOut = [];
            console.log = (m) => warnOut.push(String(m));
            let warned;
            try { warned = main([first.dir, ownBaseline]); } finally { console.log = () => {}; }
            configureBooksRoot(() => config.BOOKS_DIR);
            expect(warned, warnOut.join('\n')).to.equal(0);
            expect(warnOut).to.include('WARN  Юра (yura): manner пустая');
            expect(warnOut).to.include('ИТОГ: приёмка 2.6 пройдена (предупреждений: 1)');
        });
    });

    describe('examples for the model are a VBook 4 book', () => {
        it('ai/examples builds as a v4 bundle: one file per hero with timbre and manner, behaviour.json, no 3.1 files', () => {
            const dir = path.join(__dirname, '..', 'ai', 'examples');
            const files = {};
            (function walk(d, rel) {
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const r = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isDirectory()) walk(path.join(d, e.name), r);
                    else if (!/^behaviour-rules(\.[\w-]+)?\.json$/.test(e.name)) files[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
                }
            })(dir, '');
            for (const legacy of LEGACY) expect(Object.keys(files), legacy).to.not.include(legacy);
            const built = book.buildBookFromBundle(files);
            expect(built.manifest.vbook_version).to.equal(4);
            expect(built.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'anna_smirnova', 'boris_volkov', 'dmitry_orekhov']);
            expect(built.hero_issues).to.deep.equal([]);
            for (const h of built.heroes) {
                expect(h.voice.timbre, h.id).to.be.a('string').and.not.equal('');
                expect(h.voice.manner, h.id).to.be.a('string').and.not.equal('');
                expect(JSON.stringify(h), h.id).to.not.include('instruction');
            }
            expect(built.behaviour.schema).to.equal('animastor.behaviour-globals/1');
            expect(built.chapters).to.have.length(3);
        });
    });
});

// ── Step 2b: the acceptance 2.6 scenario (reports/2026-11-17/vbook-v4-acceptance-2.6.md) ──
const MIM_ONE = {
    characters: [
        { id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз', appearance: 'small plump bald man', clothes: 'grey summer suit', video_tokens: ['bald head'] },
        { id: 'ivan_ponyrev', name: 'Иван Николаевич Понырев (Бездомный)', appearance: 'broad-shouldered red-haired young man', clothes: 'checked cap', video_tokens: ['checked cap'] },
        { id: 'voland', name: 'Иностранец', appearance: 'tall man over forty, different eyes', clothes: 'expensive grey suit', video_tokens: ['grey suit'] },
    ],
    mentions: { 'поэт Бездомный': 'ivan_ponyrev', 'Иван Николаевич': 'ivan_ponyrev', 'немец': 'voland', 'англичанин': 'voland', 'редактор': 'mikhail_berlioz' },
    voices: {
        mikhail_berlioz: { timbre: 'A high bright male tenor. Native Russian pronunciation.', manner: 'Lecturing.' },
        ivan_ponyrev: { timbre: 'A hoarse young male voice. Native Russian pronunciation.', manner: '' },
        voland: { timbre: 'A low male voice. Native Russian pronunciation.', manner: '' },
    },
    scenes: (ids) => [{ title: 'У окна', text: 'Юра вошёл в комнату и остановился у окна.', characters_present: [ids.berlioz, ids.ivan], location: { id: 'room' } }],
    videoTokens: () => [],
};
// window 2 exactly as the model answered in the acceptance run
const MIM_TWO = {
    characters: [
        { id: 'mikhail_aleksandrovich_berlioz', name: 'Михаил Александрович Берлиоз', appearance: 'small plump man', clothes: 'grey suit' },
        { id: 'ivan_nikolayevich_bezdomny', name: 'Иван Николаевич Бездомный', appearance: 'young man', clothes: 'cowboy shirt' },
        { id: 'foreign_man_gray_suit', name: 'Иностранец в сером костюме', appearance: 'tall man', clothes: 'grey suit' },
    ],
    mentions: {
        'редактор': 'mikhail_aleksandrovich_berlioz', 'Михаил Александрович': 'mikhail_aleksandrovich_berlioz', 'Берлиоз': 'mikhail_aleksandrovich_berlioz',
        'поэт': 'ivan_nikolayevich_bezdomny', 'Иван Николаевич': 'ivan_nikolayevich_bezdomny', 'Бездомный': 'ivan_nikolayevich_bezdomny',
        'незнакомец': 'foreign_man_gray_suit', 'иностранец': 'foreign_man_gray_suit', 'немец': 'foreign_man_gray_suit',
        'англичанин': 'foreign_man_gray_suit', 'француз': 'foreign_man_gray_suit', 'интурист': 'foreign_man_gray_suit',
    },
    voices: {
        ivan_ponyrev: { timbre: 'A clear male tenor of a young man. Native Russian pronunciation.', manner: 'Impulsive and irritable, with abrupt interruptions.' },
        voland: { timbre: 'A low male voice with a foreign accent.', manner: 'Polite and inquisitive.' },
    },
    scenes: (ids) => [{ title: 'В дороге', text: 'Они ехали молча.', characters_present: [ids.berlioz, ids.ivan, ids.voland], location: { id: 'road' } }],
    videoTokens: () => [],
};

describe('VBook 4 step 2b — heroes of the book are recognised in the next window (acceptance 2.6)', function () {
    this.timeout(20000);
    let sandbox, savedBooks, quiet, logged;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-step2b-'));
        savedBooks = config.BOOKS_DIR;
        config.BOOKS_DIR = path.join(sandbox, 'books');
        fs.mkdirSync(config.BOOKS_DIR);
        configureBooksRoot(() => config.BOOKS_DIR);
        quiet = { log: console.log, warn: console.warn };
        logged = [];
        console.log = (...a) => logged.push(a.join(' ')); console.warn = (...a) => logged.push(a.join(' '));
    });
    afterEach(() => {
        console.log = quiet.log; console.warn = quiet.warn;
        config.BOOKS_DIR = savedBooks;
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const structure = { title: 'Мастер и Маргарита', author: 'М. Булгаков', chapters: [{ type: 'chapter', number: 1, title: 'Глава 1' }, { type: 'chapter', number: 2, title: 'Глава 2' }] };
    async function run(script, registry, mentions) {
        const seen = {};
        const { mod } = makePipeline(script, seen);
        const result = await mod.runPipeline('sess', 'Window text.', registry, [], 0, () => {}, 0, {
            rawWindowText: 'Window text.', chunkSize: 5, existingMentions: mentions,
        });
        return { result, seen };
    }

    async function twoWindows(second = MIM_TWO, between = null) {
        const { bookId } = lazyBook.createDraftBook(SOURCE, lazyBook.SourceType.TXT, 'mim.txt');
        let draft = lazyBook.loadDraftBook(bookId);
        const one = await run(MIM_ONE, heroAnalysis.registryFromBook(draft, []), heroAnalysis.mentionsFromBook(draft, {}));
        lazyBook.createFromAnalysis(bookId, { characters: one.result.characters, locations: one.result.locations, mentions: one.result.mentions, scenes: one.result.scenes, structure, maxScenes: 5 });
        if (between) { between(bookId); }
        draft = lazyBook.loadDraftBook(bookId);
        const registry = heroAnalysis.registryFromBook(draft, one.result.characters);
        const mentions = heroAnalysis.mentionsFromBook(draft, one.result.mentions);
        logged.length = 0;
        const two = await run(second, registry, { ...mentions });
        const written = lazyBook.appendToBook(bookId, { characters: two.result.characters, locations: two.result.locations, mentions: two.result.mentions, scenes: two.result.scenes, structure, maxScenes: 5, chapterIndex: 1 });
        return { bookId, dir: path.join(config.BOOKS_DIR, bookId), one, two, written, registry };
    }
    const heroFiles = (dir) => fs.readdirSync(path.join(dir, 'characters')).sort();
    const hero = (bookId, id) => book.heroes.findHero(book.loadBook(bookId), id);

    it('the character step of window 2 receives the registry of the book (id, name, aliases); window 1 an empty one', async () => {
        const { one, two } = await twoWindows();
        expect(one.seen.knownHeroes).to.deep.equal([]);
        expect(two.seen.knownHeroes.map((h) => h.id)).to.deep.equal(['mikhail_berlioz', 'ivan_ponyrev', 'voland']);
        const voland = two.seen.knownHeroes.find((h) => h.id === 'voland');
        expect(voland.name).to.equal('Иностранец');
        expect(voland.aliases).to.include.members(['немец', 'англичанин']);
    });

    // The model of the acceptance run IGNORED the registry and renamed both
    // heroes. Safety net by mentions (owner's decision 17.11): a merge needs
    // ≥ 2 different clues. Woland has six, Bezdomny ONE («Иван Николаевич»;
    // «поэт» and «Бездомный» are not aliases of ivan_ponyrev) → Woland is
    // merged, Bezdomny stays a new hero with a "possible duplicate" line.
    it('model ignored the registry: Woland (≥ 2 clues) is merged, Bezdomny (1 clue) is a new hero, not merged', async () => {
        const { dir, written } = await twoWindows();
        expect(written.newHeroes).to.deep.equal(['ivan_nikolayevich_bezdomny']);
        expect(heroFiles(dir)).to.deep.equal(['ivan_nikolayevich_bezdomny.json', 'ivan_ponyrev.json', 'mikhail_berlioz.json', 'narrator.json', 'voland.json']);
    });

    it('scenes of window 2 refer to the known ids where the evidence is enough', async () => {
        const { two } = await twoWindows();
        // the cast the scene step sees: the registry plus the one new hero
        expect(two.seen.sceneStepCharacters).to.deep.equal(['mikhail_berlioz', 'ivan_ponyrev', 'voland', 'ivan_nikolayevich_bezdomny']);
        expect(two.result.mentions).to.include({ 'француз': 'voland' });
    });

    it('the new spellings become aliases of the known hero; the name is never replaced', async () => {
        const { bookId } = await twoWindows();
        const voland = hero(bookId, 'voland');
        expect(voland.name).to.equal('Иностранец');
        expect(voland.aliases).to.include.members(['немец', 'англичанин', 'француз', 'интурист']);
        // the name the model used this time is kept as an alias
        expect(voland.aliases).to.include('Иностранец в сером костюме');
    });

    it('the journal: one line per merge with the reason and the evidence; one line per possible duplicate', async () => {
        await twoWindows();
        const merges = logged.filter((l) => l.startsWith('[AGENT] Hero merge:'));
        expect(merges).to.have.length(2);
        expect(merges[0]).to.equal('[AGENT] Hero merge: "mikhail_aleksandrovich_berlioz" → mikhail_berlioz (matched_by_name: "Михаил Александрович Берлиоз")');
        expect(merges[1]).to.match(/^\[AGENT\] Hero merge: "foreign_man_gray_suit" → voland \(matched_by_mentions: .*"иностранец".*\)$/);
        const possible = logged.filter((l) => l.startsWith('[AGENT] Possible duplicate:'));
        expect(possible).to.deep.equal(['[AGENT] Possible duplicate: "ivan_nikolayevich_bezdomny" → new ivan_nikolayevich_bezdomny, may be ivan_ponyrev ("Иван Николаевич")']);
    });

    // The main path (step 2b, rerun of the acceptance): the model saw the
    // registry and returned the known heroes with their ids.
    it('model returned the known ids (rerun): no duplicates, no new files, the names become aliases', async () => {
        const rerun = {
            ...MIM_TWO,
            characters: [
                { id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз', appearance: 'small plump man', clothes: 'grey suit' },
                { id: 'ivan_ponyrev', name: 'Иван Николаевич Бездомный', appearance: 'young man', clothes: 'cowboy shirt' },
                { id: 'voland', name: 'Иностранец в сером костюме', appearance: 'tall man', clothes: 'grey suit' },
            ],
            mentions: { 'Бездомный': 'ivan_ponyrev', 'поэт': 'ivan_ponyrev', 'француз': 'voland', 'интурист': 'voland' },
        };
        const { bookId, dir, written } = await twoWindows(rerun);
        expect(written.newHeroes).to.deep.equal([]);
        expect(heroFiles(dir)).to.deep.equal(['ivan_ponyrev.json', 'mikhail_berlioz.json', 'narrator.json', 'voland.json']);
        expect(hero(bookId, 'ivan_ponyrev').aliases).to.include.members(['Иван Николаевич Бездомный', 'Бездомный']);
        expect(hero(bookId, 'voland').aliases).to.include('Иностранец в сером костюме');
        expect(logged.filter((l) => l.startsWith('[AGENT] Possible duplicate:'))).to.deep.equal([]);
    });

    // The rest of step 2b (owner's decision 17.11): a known hero with a timbre
    // and an EMPTY manner is asked for the manner in the next window, unless a
    // person edited the voice or locked a reference. The timbre never changes.
    describe('an empty manner of a known hero is asked for again', () => {
        it('voland and ivan_ponyrev (empty manner after window 1) get the manner of window 2; the timbre stays', async () => {
            const { bookId, dir } = await twoWindows();
            const voland = hero(bookId, 'voland').voice;
            expect(voland.manner).to.equal('Polite and inquisitive.');
            expect(voland.timbre).to.equal('A low male voice. Native Russian pronunciation.');
            const ivan = hero(bookId, 'ivan_ponyrev').voice;
            expect(ivan.manner).to.equal('Impulsive and irritable, with abrupt interruptions.');
            expect(ivan.timbre).to.equal('A hoarse young male voice. Native Russian pronunciation.');
            // Berlioz had a manner — not asked, not changed
            expect(hero(bookId, 'mikhail_berlioz').voice.manner).to.equal('Lecturing.');
            expect(heroFiles(dir)).to.include('voland.json');
        });

        it('a voice edited by a person (timbre_source user) is not asked for and keeps its empty manner', async () => {
            const { bookId } = await twoWindows(MIM_TWO, (id) => {
                const b = book.loadBook(id);
                const v = book.heroes.findHero(b, 'voland');
                voicePort.setCharacterVoiceDescription(b, 'voland', { timbre: v.voice.timbre, manner: '', timbre_source: 'user' });
                book.saveBookBundle(b);
            });
            expect(hero(bookId, 'voland').voice).to.include({ manner: '', timbre_source: 'user' });
            expect(hero(bookId, 'ivan_ponyrev').voice.manner).to.equal('Impulsive and irritable, with abrupt interruptions.');
        });
    });
});
