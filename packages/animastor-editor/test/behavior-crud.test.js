// ======================================================
// BEHAVIOUR of a hero — the manual behaviour editor (VBook 4)
// ======================================================
// The VBook 4 successor of the /behaviors CRUD (behavior.json v2): the
// character of a hero lives in its own file — behaviour.profile {baseline,
// quirks, reactions} and behaviour.rules — and is edited through
// PATCH /heroes/:id (behaviour.profile.*) and the rules routes; the book-level
// defaults and global rules live in behaviour.json (GET/PATCH /behaviour).
// VBOOK_FORMAT_V4 §6, §8.2; HERO_CARD.md §5. No dirty layer: rules are
// snapshotted into unit.behaviour at pipeline time (VBOOK_BEHAVIOUR.md).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const h = require('./hero-harness.cjs');
const { heroRules } = require('@animastor/vbook-runtime/heroes.cjs');

const B = 'behaviour_book_1';

describe('BEHAVIOUR of a hero — profile and rules (VBook 4)', function () {
    this.timeout(20000);
    let t;

    beforeEach(async () => {
        t = await h.startHeroServer();
        h.writeBook(t.booksDir, B);
    });
    afterEach(async () => { await t.close(); });

    const patch = (id, fields) => t.api('PATCH', `/api/v1/book/${B}/heroes/${id}`, { fields });
    const behaviourJson = () => fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8');

    it('a baseline creates behaviour.profile inside the hero file', async () => {
        const r = await patch('sveta', { 'behaviour.profile.baseline': 'Spirited, moves fast.' });
        expect(r.status).to.equal(200);
        expect(t.readHero(B, 'sveta').behaviour).to.deep.equal({ profile: { baseline: 'Spirited, moves fast.' } });
    });

    it('quirks alone create a profile with quirks only (no empty baseline)', async () => {
        await patch('sveta', { 'behaviour.profile.quirks': ['tucks hair behind her ear'] });
        expect(t.readHero(B, 'sveta').behaviour).to.deep.equal({ profile: { quirks: ['tucks hair behind her ear'] } });
    });

    it('PATCH without fields is rejected (400 bad_request)', async () => {
        const r = await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { baseline: 'x' });
        expect(r.status).to.equal(400);
        expect(r.body.error).to.equal('bad_request');
    });

    it('PATCH for an unknown hero is rejected (404 hero_not_found)', async () => {
        const r = await patch('nobody', { 'behaviour.profile.baseline': 'x' });
        expect(r.status).to.equal(404);
        expect(r.body.error).to.equal('hero_not_found');
    });

    it('a second rule with a taken id is rejected (409 rule_exists)', async () => {
        const r = await t.api('POST', `/api/v1/book/${B}/heroes/sveta/rules`, { id: 'yura.praised', then: { action: 'laughs' } });
        expect(r.status).to.equal(409);
        expect(r.body.error).to.equal('rule_exists');
    });

    it('structured fields (baseline, quirks, reactions) are stored verbatim', async () => {
        const reactions = [{ trigger: 'is teased', reaction: 'rolls her eyes' }, { trigger: 'is scared', reaction: 'grabs a sleeve' }];
        await patch('sveta', { 'behaviour.profile.baseline': 'calm', 'behaviour.profile.quirks': ['hums', 'taps'], 'behaviour.profile.reactions': reactions });
        expect(t.readHero(B, 'sveta').behaviour.profile).to.deep.equal({ baseline: 'calm', quirks: ['hums', 'taps'], reactions });
    });

    it('PATCH baseline keeps unknown keys of the profile (schema-tolerant storage, reported as unknown_key)', async () => {
        const yura = t.readHero(B, 'yura');
        yura.behaviour.profile.instruction = 'pass-1 text';
        fs.writeFileSync(t.heroFile(B, 'yura'), JSON.stringify(yura, null, 2));
        await patch('yura', { 'behaviour.profile.baseline': 'nervous' });
        const profile = t.readHero(B, 'yura').behaviour.profile;
        expect(profile).to.include({ baseline: 'nervous', instruction: 'pass-1 text' });
        const issues = (await t.api('GET', `/api/v1/book/${B}`)).body.hero_issues;
        expect(issues.some((i) => i.code === 'unknown_key' && i.hero_id === 'yura' && i.blocking === false)).to.equal(true);
    });

    it('an untouched reaction keeps its unknown keys (the card never sends an untouched list)', async () => {
        await patch('yura', { 'behaviour.profile.baseline': 'nervous' });
        expect(t.readHero(B, 'yura').behaviour.profile.reactions[0]).to.deep.equal({ trigger: 'is praised', reaction: 'looks away', note: 'kept' });
    });

    it('PATCH of a rule the hero does not have is rejected (404 rule_not_found)', async () => {
        const r = await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta/rules/yura.praised`, { fields: { enabled: false } });
        expect(r.status).to.equal(404);
        expect(r.body.error).to.equal('rule_not_found');
    });

    it('PATCHing one field never rewrites sibling fields', async () => {
        await patch('yura', { 'behaviour.profile.quirks': ['bites his lip'] });
        const b = t.readHero(B, 'yura').behaviour;
        expect(b.profile.baseline).to.equal('calm');
        expect(b.profile.quirks).to.deep.equal(['bites his lip']);
        expect(b.rules.map((r) => r.id)).to.deep.equal(['yura.praised']);
    });

    it('clearing the whole profile removes behaviour from the file when no rules are left', async () => {
        await patch('sveta', { 'behaviour.profile.baseline': 'calm' });
        await patch('sveta', { 'behaviour.profile.baseline': null });
        expect(t.readHero(B, 'sveta')).to.not.have.property('behaviour');
        await patch('yura', { 'behaviour.profile.baseline': null, 'behaviour.profile.quirks': null, 'behaviour.profile.reactions': null });
        expect(t.readHero(B, 'yura').behaviour).to.deep.equal({ rules: t.readHero(B, 'yura').behaviour.rules });
    });

    it('DELETE of a missing rule is rejected (404 rule_not_found)', async () => {
        const r = await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta/rules/nope`);
        expect(r.status).to.equal(404);
        expect(r.body.error).to.equal('rule_not_found');
    });

    it('DELETE hero removes its behaviour with the file (no dangling entry anywhere)', async () => {
        await t.api('DELETE', `/api/v1/book/${B}/heroes/yura`);
        const book = h.bookModule.loadBook(B);
        expect(book.heroes.map((x) => x.id)).to.not.include('yura');
        expect(heroRules(book).rules.map((r) => r.id)).to.deep.equal(['global.sigh']);
    });

    it('buildBookFromBundle reads hero behaviour from characters/<id>.json and the globals from behaviour.json', () => {
        const files = {};
        const dir = t.bookDir(B);
        for (const name of ['manifest.json', 'book.json', 'behaviour.json', 'locations.json']) files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const name of fs.readdirSync(path.join(dir, 'characters'))) files[`characters/${name}`] = fs.readFileSync(path.join(dir, 'characters', name), 'utf8');
        for (const name of fs.readdirSync(path.join(dir, 'chapters'))) files[`chapters/${name}`] = fs.readFileSync(path.join(dir, 'chapters', name), 'utf8');
        const book = h.bookModule.buildBookFromBundle(files);
        expect(book.heroes.find((x) => x.id === 'yura').behaviour.profile.baseline).to.equal('calm');
        expect(book.behaviour.rules.map((r) => r.id)).to.deep.equal(['global.sigh']);
        expect(book).to.not.have.property('behaviors');
    });

    it('DELETE hero removes its rules; global rules and other heroes\' rules stay', async () => {
        await t.api('POST', `/api/v1/book/${B}/heroes/sveta/rules`, { id: 'sveta.laughs', when: { emotion: ['joy'] }, then: { action: 'laughs' } });
        await t.api('DELETE', `/api/v1/book/${B}/heroes/yura`);
        const ids = heroRules(h.bookModule.loadBook(B)).rules.map((r) => [r.id, r.scope, r.character_id || null]);
        expect(ids).to.deep.equal([['global.sigh', 'global', null], ['sveta.laughs', 'character', 'sveta']]);
    });

    it('hero routes never touch behaviour.json (the book-level defaults and global rules)', async () => {
        const before = behaviourJson();
        await patch('yura', { 'behaviour.profile.baseline': 'nervous' });
        await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { when: { emotion: ['sad'] }, then: { action: 'sighs' } });
        await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/rules/yura.praised`, { fields: { enabled: false } });
        await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta`);
        expect(behaviourJson()).to.equal(before);
    });
});
