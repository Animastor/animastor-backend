// ======================================================
// heroes helpers (VBOOK_FORMAT_V4 §8.1)
// ======================================================

'use strict';

const { expect } = require('chai');
const {
    CANONICAL_ID_RE,
    RESERVED_HERO_IDS,
    isCanonicalHeroId,
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
