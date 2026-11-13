// ======================================================
// looks — resolveHeroLook (VBOOK_FORMAT_V4 §12, приёмка 1.8)
// ======================================================
// The acceptance table from the ADR: base, chapter look, scene look over the
// chapter, "base" in a scene despite the chapter, look_patch over a look,
// unknown look → next source + warning, hero without passport → null, and the
// inputs stay untouched.

'use strict';

const { expect } = require('chai');
const { resolveHeroLook, LOOK_FIELDS, BASE_LOOK_ID } = require('../src/looks.cjs');

function makeBook() {
    return {
        heroes: [
            {
                id: 'woland',
                passport: {
                    appearance: 'tall, dark hair',
                    clothes: 'black suit',
                    video_tokens: ['dark hair', 'black suit'],
                },
                looks: [
                    {
                        id: 'coat',
                        label: 'В пальто',
                        fields: { clothes: 'long grey coat', video_tokens: ['grey coat'] },
                        image_ref: { sha256: 'a'.repeat(64) },
                        notes: 'outdoors',
                    },
                    {
                        id: 'beard',
                        label: 'С бородой',
                        fields: { appearance: 'tall, dark hair, beard' },
                    },
                ],
            },
            {
                id: 'narrator',
                passport: { appearance: 'invisible', clothes: '', video_tokens: [] },
            },
        ],
    };
}

describe('resolveHeroLook', () => {
    it('accepts only the documented fields and look ids', () => {
        expect(LOOK_FIELDS).to.deep.equal(['appearance', 'clothes', 'video_tokens']);
        expect(BASE_LOOK_ID).to.equal('base');
    });

    it('base: without assignments the passport is returned', () => {
        const book = makeBook();
        const result = resolveHeroLook(book, {}, {}, 'woland');
        expect(result).to.deep.include({
            hero_id: 'woland',
            look_id: 'base',
            source: 'base',
            appearance: 'tall, dark hair',
            clothes: 'black suit',
        });
        expect(result.video_tokens).to.deep.equal(['dark hair', 'black suit']);
        expect(result.base).to.deep.equal({
            appearance: 'tall, dark hair',
            clothes: 'black suit',
            video_tokens: ['dark hair', 'black suit'],
        });
        expect(result.changed).to.deep.equal([]);
        expect(result.patched).to.deep.equal([]);
        expect(result.image_ref).to.equal(null);
        expect(result.warnings).to.deep.equal([]);
    });

    it('chapter look: fields replace whole base fields, untouched fields stay', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const result = resolveHeroLook(book, chapter, {}, 'woland');
        expect(result).to.deep.include({
            look_id: 'coat',
            source: 'chapter',
            appearance: 'tall, dark hair',
            clothes: 'long grey coat',
        });
        expect(result.video_tokens).to.deep.equal(['grey coat']);
        expect(result.changed).to.deep.equal(['clothes', 'video_tokens']);
        expect(result.image_ref).to.deep.equal({ sha256: 'a'.repeat(64) });
    });

    it('scene look wins over the chapter look', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = { looks: { woland: 'beard' } };
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(result).to.deep.include({
            look_id: 'beard',
            source: 'scene',
            appearance: 'tall, dark hair, beard',
            clothes: 'black suit',
        });
        expect(result.changed).to.deep.equal(['appearance']);
    });

    it('"base" in the scene overrides the chapter look', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = { looks: { woland: 'base' } };
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(result).to.deep.include({
            look_id: 'base',
            source: 'base',
            clothes: 'black suit',
        });
        expect(result.changed).to.deep.equal([]);
    });

    it('look_patch replaces fields over the chosen look for this scene only', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = { look_patch: { woland: { clothes: 'coat open, no hat' } } };
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(result).to.deep.include({
            look_id: 'coat',
            source: 'chapter',
            clothes: 'coat open, no hat',
            appearance: 'tall, dark hair',
        });
        expect(result.video_tokens).to.deep.equal(['grey coat']);
        expect(result.patched).to.deep.equal(['clothes']);
        expect(result.changed).to.deep.equal(['clothes', 'video_tokens']);
    });

    it('unknown look falls through to the next source and warns', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = { looks: { woland: 'ghost_look' } };
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(result).to.deep.include({
            look_id: 'coat',
            source: 'chapter',
            clothes: 'long grey coat',
        });
        expect(result.warnings).to.deep.equal(['unknown_look']);
    });

    it('unknown look with no chapter assignment falls back to base with a warning', () => {
        const book = makeBook();
        const result = resolveHeroLook(book, {}, { looks: { woland: 'ghost_look' } }, 'woland');
        expect(result).to.deep.include({ look_id: 'base', source: 'base', clothes: 'black suit' });
        expect(result.warnings).to.deep.equal(['unknown_look']);
    });

    it('hero without passport or an unknown hero returns null', () => {
        const book = makeBook();
        book.heroes.push({ id: 'episodic', voice: { timbre: 'quiet' } });
        expect(resolveHeroLook(book, {}, {}, 'episodic')).to.equal(null);
        expect(resolveHeroLook(book, {}, {}, 'nobody')).to.equal(null);
        expect(resolveHeroLook(null, {}, {}, 'woland')).to.equal(null);
    });

    it('does not mutate the book, chapter or scene', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = {
            looks: { woland: 'beard' },
            look_patch: { woland: { video_tokens: ['beard'] } },
        };
        const before = JSON.stringify({ book, chapter, scene });
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(JSON.stringify({ book, chapter, scene })).to.equal(before);

        result.base.video_tokens.push('mutated');
        result.video_tokens.push('mutated');
        expect(book.heroes[0].passport.video_tokens).to.deep.equal(['dark hair', 'black suit']);
    });
});
