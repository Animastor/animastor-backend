// ======================================================
// heroes helpers (VBOOK_FORMAT_V4 §8.1)
// ======================================================

'use strict';

const { expect } = require('chai');
const {
    CANONICAL_ID_RE,
    RESERVED_HERO_IDS,
    isCanonicalHeroId,
    isReservedHeroId,
    isValidHeroId,
    findHero,
    passportHeroes,
    narrator,
    voiceInstruct,
    buildAliasIndex,
    heroRules,
} = require('../src/heroes.cjs');

function makeBook() {
    return {
        behaviour: {
            defaults: { max_per_scene: 2 },
            rules: [{ id: 'g1', when: 'always', do: 'nothing' }],
        },
        heroes: [
            { id: 'narrator', role: 'narrator', voice: { timbre: 'warm male', manner: 'calm' } },
            {
                id: 'yura',
                name: 'Юра',
                aliases: ['Юрий', 'Юра'],
                passport: { appearance: 'tall', clothes: 'coat', video_tokens: ['man'] },
                voice: { timbre: 'young male', manner: ' hurried ' },
                behaviour: {
                    profile: { baseline: 'anxious' },
                    rules: [{ id: 'r1', when: 'rain', do: 'tremble' }],
                },
            },
            { id: 'shop_women', aliases: ['продавщица'], voice: { timbre: 'female' } },
            { id: 'margarita', passport: { appearance: 'pale' } },
        ],
    };
}

describe('heroes helpers', () => {
    it('canonical id grammar: snake_case, up to 64 characters, reserved ids', () => {
        expect(CANONICAL_ID_RE.test('yura')).to.equal(true);
        expect(isCanonicalHeroId('shop_women')).to.equal(true);
        expect(isCanonicalHeroId('a'.repeat(64))).to.equal(true);
        expect(isCanonicalHeroId('a'.repeat(65))).to.equal(false);
        expect(isCanonicalHeroId('Yura')).to.equal(false);
        expect(isCanonicalHeroId('yura-2')).to.equal(false);
        expect(isCanonicalHeroId('')).to.equal(false);
        expect(RESERVED_HERO_IDS).to.include('manifest');
        expect(RESERVED_HERO_IDS).to.include('behaviour');
    });

    it('an id is one safe path segment: no separators, dots, upper case or non-ASCII', () => {
        for (const bad of ['../x', 'a/b', 'a\\b', 'a.b', '.a', 'a b', 'Юра', 'yura\n', 'a__b', '_a', 'a_', 'a-b', null, 42, undefined, {}]) {
            expect(isCanonicalHeroId(bad), JSON.stringify(bad)).to.equal(false);
        }
    });

    it('reserved ids match the ADR list (§4) and the narrator id is not one of them', () => {
        expect([...RESERVED_HERO_IDS].sort()).to.deep.equal([
            'behavior', 'behaviour', 'bible', 'book', 'characters', 'index',
            'locations', 'manifest', 'mentions', 'voices',
        ]);
        for (const id of RESERVED_HERO_IDS) {
            expect(isCanonicalHeroId(id), id).to.equal(true);   // grammar passes…
            expect(isReservedHeroId(id), id).to.equal(true);
            expect(isValidHeroId(id), id).to.equal(false);      // …but a hero cannot carry it
        }
        // characters/narrator.json is the narrator's file: its id must stay usable
        expect(isReservedHeroId('narrator')).to.equal(false);
        expect(isValidHeroId('narrator')).to.equal(true);
    });

    it('findHero / passportHeroes / narrator', () => {
        const book = makeBook();
        expect(findHero(book, 'yura').name).to.equal('Юра');
        expect(findHero(book, 'nobody')).to.equal(null);
        expect(passportHeroes(book).map((h) => h.id)).to.deep.equal(['yura', 'margarita']);
        expect(narrator(book).id).to.equal('narrator');
        expect(narrator({ heroes: [] })).to.equal(null);
        expect(passportHeroes({})).to.deep.equal([]);
    });

    it('voiceInstruct joins timbre and manner, trims, skips missing parts', () => {
        const book = makeBook();
        expect(voiceInstruct(findHero(book, 'yura'))).to.equal('young male hurried');
        expect(voiceInstruct(findHero(book, 'margarita'))).to.equal('');
        expect(voiceInstruct(null)).to.equal('');
    });

    it('buildAliasIndex maps aliases and reports ambiguous ones', () => {
        const book = makeBook();
        book.heroes.push({ id: 'double', aliases: ['Юрий'] });
        const { index, ambiguous } = buildAliasIndex(book.heroes);
        expect(index['продавщица']).to.equal('shop_women');
        expect(index['Юра']).to.equal('yura');
        expect(index['Юрий']).to.equal(undefined);
        expect(ambiguous).to.deep.equal(['Юрий']);
    });

    it('buildAliasIndex compares aliases after normalizeForMatch and drops every spelling of an ambiguous one', () => {
        const { index, ambiguous } = buildAliasIndex([
            { id: 'a', aliases: ['Юрий', 'Юра', 'Юрий'] },
            { id: 'b', aliases: ['юрий '] },
            { id: 'c', aliases: ['ЮРИЙ', 'constructor'] },
        ]);
        expect(Object.keys(index).sort()).to.deep.equal(['constructor', 'Юра']);
        expect(index['Юра']).to.equal('a');
        expect(index.constructor).to.equal('c');           // prototype keys are plain data
        expect(ambiguous).to.deep.equal(['Юрий']);         // reported once
        expect(buildAliasIndex(null)).to.deep.equal({ index: Object.create(null), ambiguous: [] });
    });

    it('buildAliasIndex does not mutate the heroes', () => {
        const heroes = [{ id: 'a', aliases: [' Юрий '] }, { id: 'b', aliases: ['Юрий'] }];
        const before = JSON.stringify(heroes);
        buildAliasIndex(heroes);
        expect(JSON.stringify(heroes)).to.equal(before);
    });

    it('voiceInstruct ignores non-string parts and never reads a legacy instruction field', () => {
        expect(voiceInstruct({ voice: { timbre: 'deep', manner: null } })).to.equal('deep');
        expect(voiceInstruct({ voice: { timbre: 42, manner: ' calm ' } })).to.equal('calm');
        expect(voiceInstruct({ voice: { instruction: 'legacy 3.1 text' } })).to.equal('');
        expect(voiceInstruct({ voice: [] })).to.equal('');
    });

    it('heroRules derives scope/character_id and skips duplicate ids', () => {
        const book = makeBook();
        book.heroes[3].behaviour = { rules: [{ id: 'g1', when: 'never', do: 'x' }] };
        const { rules, duplicates } = heroRules(book);
        expect(rules.map((r) => [r.id, r.scope, r.character_id])).to.deep.equal([
            ['g1', 'global', undefined],
            ['r1', 'character', 'yura'],
        ]);
        expect(duplicates).to.deep.equal(['g1']);
    });
});
