// ======================================================
// PATCH HERO — global passport persistence (VBook 4)
// ======================================================
// The save path of the hero card's «Внешность» block (VBOOK_FORMAT_V4 §8.2,
// HERO_CARD.md §4) — the VBook 4 successor of PATCH /characters/{id}:
//   1. PATCH /heroes/{id} with "passport.<field>" keys → characters/<id>.json
//      (the file the generator reads through resolveHeroLook)
//   2. null / empty string removes a passport field
//   3. video_tokens comma-text → array
//   4. the image prompt builder sees the new passport
//   5. regression guard: the OLD Android behaviour (char.* keys sent to the
//      scene PATCH with unit_id) never touches the hero file.

'use strict';

const { expect } = require('chai');
const h = require('./hero-harness.cjs');
const promptBuilder = require('../../../backend/src/image/prompt-builder');
const { findUnitInScene } = require('../src/scene-patch-utils.cjs');

const B = 'passport_book_1';

describe('PATCH HERO — global passport persistence (VBook 4)', function () {
    this.timeout(20000);
    let t;

    beforeEach(async () => {
        t = await h.startHeroServer();
        h.writeBook(t.booksDir, B);
    });
    afterEach(async () => { await t.close(); });

    const patch = (fields) => t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { fields });

    it('persists passport.<field> keys to characters/<id>.json', async () => {
        const r = await patch({ 'passport.appearance': 'short blond hair', 'passport.clothes': 'leather jacket' });
        expect(r.status).to.equal(200);
        const hero = t.readHero(B, 'sveta');
        expect(hero.passport.appearance).to.equal('short blond hair');
        expect(hero.passport.clothes).to.equal('leather jacket');
        // unrelated field untouched
        expect(hero.passport.video_tokens).to.deep.equal(['woman', 'red hair']);
    });

    it('removes a passport field when the editor sends an empty string or null', async () => {
        await patch({ 'passport.appearance': '' });
        expect(t.readHero(B, 'sveta').passport).to.not.have.property('appearance');
        expect(t.readHero(B, 'sveta').passport.clothes).to.equal('green dress');
        await patch({ 'passport.clothes': null });
        expect(t.readHero(B, 'sveta').passport).to.not.have.property('clothes');
    });

    it('normalizes comma-joined video_tokens text back into an array', async () => {
        await patch({ 'passport.video_tokens': 'short blond hair, leather jacket' });
        expect(t.readHero(B, 'sveta').passport.video_tokens).to.deep.equal(['short blond hair', 'leather jacket']);
    });

    it('the image prompt builder sees the updated global passport', async () => {
        await patch({ 'passport.appearance': 'tall and thin, grey eyes', 'passport.clothes': 'long grey coat' });
        const book = h.bookModule.loadBook(B);
        const chapter = book.chapters[1];
        const out = promptBuilder.buildCharacters(chapter.scenes[0], null, chapter, book);
        expect(out).to.have.length(1);
        expect(out[0]).to.include('tall and thin, grey eyes');
        expect(out[0]).to.include('long grey coat');
    });

    it('char.* keys sent to the scene PATCH must NOT reach the hero file', async () => {
        const before = JSON.stringify(t.readHero(B, 'sveta'));
        const r = await t.api('PATCH', `/api/v1/book/${B}/scene/${h.CH2}/sc-00000003`, {
            unit_id: 'iu-00000003',
            fields: { 'char.sveta.passport.appearance': 'short hair', 'char.sveta.passport.clothes': 'leather jacket' },
        });
        expect(r.status).to.equal(200);
        expect(JSON.stringify(t.readHero(B, 'sveta'))).to.equal(before);
        // the junk DID land in the unit — that is exactly why the leak is wrong
        const scene = t.readChapter(B, h.CH2).scenes[0];
        expect(findUnitInScene(scene, 'iu-00000003')).to.have.property('char');
    });
});
