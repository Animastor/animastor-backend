// =====================================================
// Hero behaviour via edit_book — creation, loading, AI-agent contract (VBook 4)
// =====================================================
// The VBook 4 successor of the behavior.json contract (VBOOK_FORMAT_V4 §6, §8.2;
// @animastor/assistant 0.3.0). A hero's character lives in its own file
// characters/<id>.json → behaviour.profile {baseline, quirks, reactions}; the
// book-level defaults and global rules live in behaviour.json. edit_book
// addresses a hero BY ID: /heroes/<id>/behaviour/profile/…
//   1. a book without behaviour.json loads with the default globals
//   2. saveBookBundle creates behaviour.json when it is missing
//   3. edit_book can create the behaviour of an existing hero
//   4. edit_book cannot create behaviour for an unknown hero id
//   5. edit_book can update existing behaviour fields
//   6. behaviour survives saveBookBundle (the hero file) roundtrip
//   7. other hero data (passport, voice) is not broken

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const chatEngineFactory = (cfg) => require('@animastor/assistant').createChatEngine(cfg, {
    validateBundleObject: require('../src/book/bundle-validator.cjs').validateBundleObject,
    aiProfile: null,
});

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('Hero behaviour via edit_book — AI-agent contract (VBook 4)', () => {
    let tmpDir;
    let bookId;
    let bookDir;

    const CHAPTER_ID = 'ch-abcd1234';
    const CHAR_HERO = 'hero';
    const CHAR_SIDEKICK = 'sidekick';
    const heroPath = (id) => path.join(bookDir, 'characters', `${id}.json`);
    const readHero = (id) => JSON.parse(fs.readFileSync(heroPath(id), 'utf8'));
    const heroOf = (book, id) => book.heroes.find((h) => h.id === id);

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'behaviour-editbook-'));
        bookId = 'test_book_' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'characters'), { recursive: true });
        config.BOOKS_DIR = tmpDir;

        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId, vbook_version: 4, build_id: 'build-test', state: 'BOOTSTRAPPED', created_at: new Date().toISOString(),
        }, null, 2));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId, title: 'Test Book', author: 'Test Author', language: 'ru',
            structure: { chapters_order: [`${CHAPTER_ID}.json`], characters_order: ['narrator', CHAR_HERO, CHAR_SIDEKICK] },
        }, null, 2));
        fs.writeFileSync(path.join(bookDir, 'chapters', `${CHAPTER_ID}.json`), JSON.stringify({
            chapter_id: CHAPTER_ID, chapter_title: 'Chapter 1',
            scenes: [{ scene_id: 'sc-abcd1234', type: 'narration', participants: [CHAR_HERO], units: [{ id: 'iu-abcd1234', text: 'The hero arrives.' }] }],
        }, null, 2));
        const heroes = [
            { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep calm voice.' } },
            { schema: 'animastor.character/1', id: CHAR_HERO, name: 'Hero', passport: { appearance: 'Tall, dark hair', clothes: 'Black coat' }, voice: { timbre: 'Strong commanding voice.' } },
            { schema: 'animastor.character/1', id: CHAR_SIDEKICK, name: 'Sidekick', passport: { appearance: 'Short, red hair', clothes: 'Green jacket' } },
        ];
        for (const h of heroes) fs.writeFileSync(heroPath(h.id), JSON.stringify(h, null, 2));
        // no behaviour.json — a book right after creation of the cast by hand
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    const profile = {
        baseline: 'Walks with long confident strides, chin slightly raised.',
        quirks: ['Taps fingers on any surface while thinking'],
        reactions: [{ trigger: 'When insulted', reaction: 'Narrows eyes and speaks very quietly' }],
    };

    it('a book without behaviour.json loads with the default globals and no hero behaviour', () => {
        const bookData = bookModule.loadBook(bookId);
        expect(bookData).to.not.be.null;
        expect(bookData.behaviour).to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] });
        expect(heroOf(bookData, CHAR_HERO)).to.not.have.property('behaviour');
        expect(bookData).to.not.have.property('behaviors');
    });

    it('behaviour.json is created by saveBookBundle when it is missing', () => {
        bookModule.saveBookBundle(bookModule.loadBook(bookId));
        const saved = JSON.parse(fs.readFileSync(path.join(bookDir, 'behaviour.json'), 'utf8'));
        expect(saved).to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] });
    });

    it('applyPatches creates the behaviour of a hero via add /heroes/<id>/behaviour/profile', () => {
        const engine = chatEngineFactory(config);
        const result = engine.applyPatches(bookModule.loadBook(bookId), [{ op: 'add', path: `/heroes/${CHAR_HERO}/behaviour/profile`, value: profile }]);
        expect(result.errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO).behaviour).to.deep.equal({ profile });
    });

    it('applyPatches updates existing behaviour via replace', () => {
        const engine = chatEngineFactory(config);
        const book = bookModule.loadBook(bookId);
        heroOf(book, CHAR_HERO).behaviour = { profile: { baseline: 'Old baseline.', quirks: ['old quirk'] } };
        const result = engine.applyPatches(book, [{ op: 'replace', path: `/heroes/${CHAR_HERO}/behaviour/profile/baseline`, value: 'New baseline.' }]);
        expect(result.errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO).behaviour.profile.baseline).to.equal('New baseline.');
        expect(heroOf(result.result, CHAR_HERO).behaviour.profile.quirks).to.deep.equal(['old quirk']);
    });

    it('applyPatches replaces the quirks array', () => {
        const engine = chatEngineFactory(config);
        const book = bookModule.loadBook(bookId);
        heroOf(book, CHAR_HERO).behaviour = { profile: { quirks: ['old'] } };
        const result = engine.applyPatches(book, [{ op: 'replace', path: `/heroes/${CHAR_HERO}/behaviour/profile/quirks`, value: ['new quirk 1', 'new quirk 2'] }]);
        expect(result.errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO).behaviour.profile.quirks).to.deep.equal(['new quirk 1', 'new quirk 2']);
    });

    it('applyPatches replaces the reactions array', () => {
        const engine = chatEngineFactory(config);
        const book = bookModule.loadBook(bookId);
        heroOf(book, CHAR_HERO).behaviour = { profile: { reactions: [] } };
        const reactions = [{ trigger: 'When laughed at', reaction: 'Laughs louder' }, { trigger: 'When alone', reaction: 'Hums' }];
        const result = engine.applyPatches(book, [{ op: 'replace', path: `/heroes/${CHAR_HERO}/behaviour/profile/reactions`, value: reactions }]);
        expect(result.errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO).behaviour.profile.reactions).to.deep.equal(reactions);
    });

    it('creates behaviour and persists it in characters/<id>.json through saveBookBundle', () => {
        const engine = chatEngineFactory(config);
        const result = engine.applyPatches(bookModule.loadBook(bookId), [{ op: 'add', path: `/heroes/${CHAR_HERO}/behaviour/profile`, value: profile }]);
        expect(result.errors).to.have.length(0);
        bookModule.saveBookBundle(result.result);
        expect(heroOf(bookModule.loadBook(bookId), CHAR_HERO).behaviour).to.deep.equal({ profile });
        expect(readHero(CHAR_HERO).behaviour).to.deep.equal({ profile });
        expect(fs.existsSync(path.join(bookDir, 'behavior.json'))).to.equal(false);
    });

    it('creates behaviour for several heroes via separate patches', () => {
        const engine = chatEngineFactory(config);
        const side = { baseline: 'Fidgets constantly.', quirks: [], reactions: [] };
        const result = engine.applyPatches(bookModule.loadBook(bookId), [
            { op: 'add', path: `/heroes/${CHAR_HERO}/behaviour/profile`, value: profile },
            { op: 'add', path: `/heroes/${CHAR_SIDEKICK}/behaviour/profile`, value: side },
        ]);
        expect(result.errors).to.have.length(0);
        bookModule.saveBookBundle(result.result);
        const reloaded = bookModule.loadBook(bookId);
        expect(heroOf(reloaded, CHAR_HERO).behaviour.profile).to.deep.equal(profile);
        expect(heroOf(reloaded, CHAR_SIDEKICK).behaviour.profile).to.deep.equal(side);
    });

    it('creating behaviour keeps the passport and the voice of the hero', () => {
        const engine = chatEngineFactory(config);
        const result = engine.applyPatches(bookModule.loadBook(bookId), [{ op: 'add', path: `/heroes/${CHAR_HERO}/behaviour/profile`, value: profile }]);
        bookModule.saveBookBundle(result.result);
        const hero = readHero(CHAR_HERO);
        expect(hero.passport).to.deep.equal({ appearance: 'Tall, dark hair', clothes: 'Black coat' });
        expect(hero.voice).to.deep.equal({ timbre: 'Strong commanding voice.' });
        expect(readHero('narrator').voice.timbre).to.equal('Deep calm voice.');
    });

    it('applyPatchesValidated creates behaviour and passes the bundle validation; an unknown hero id is refused', () => {
        const engine = chatEngineFactory(config);
        const result = engine.applyPatchesValidated(bookModule.loadBook(bookId), [{ op: 'add', path: `/heroes/${CHAR_HERO}/behaviour/profile`, value: profile }]);
        expect(result.errors).to.have.length(0);
        expect(result.validation_errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO).behaviour.profile).to.deep.equal(profile);
        const unknown = engine.applyPatchesValidated(bookModule.loadBook(bookId), [{ op: 'add', path: '/heroes/ghost/behaviour/profile', value: profile }]);
        expect(unknown.result).to.equal(null);
        expect(unknown.errors[0]).to.match(/Hero ghost not found/);
    });

    it('applyPatches removes the behaviour of a hero via remove', () => {
        const engine = chatEngineFactory(config);
        const book = bookModule.loadBook(bookId);
        heroOf(book, CHAR_HERO).behaviour = { profile };
        const result = engine.applyPatches(book, [{ op: 'remove', path: `/heroes/${CHAR_HERO}/behaviour` }]);
        expect(result.errors).to.have.length(0);
        expect(heroOf(result.result, CHAR_HERO)).to.not.have.property('behaviour');
    });

    it('hero behaviour and global rules survive saveBookBundle + loadBook with full data', () => {
        const book = bookModule.loadBook(bookId);
        const rule = { id: 'hero.taps', when: { emotion: ['anxious'] }, then: { action: 'taps fingers' }, enabled: true };
        heroOf(book, CHAR_HERO).behaviour = { profile, rules: [rule] };
        book.behaviour = { schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 3 }, rules: [{ id: 'g.sigh', when: { emotion: ['sad'] }, then: { action: 'sighs' } }] };
        bookModule.saveBookBundle(book);
        const reloaded = bookModule.loadBook(bookId);
        expect(heroOf(reloaded, CHAR_HERO).behaviour).to.deep.equal({ profile, rules: [rule] });
        expect(reloaded.behaviour.defaults.max_per_scene).to.equal(3);
        expect(reloaded.behaviour.rules.map((r) => r.id)).to.deep.equal(['g.sigh']);
    });
});
