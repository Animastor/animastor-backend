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

    it('unknown look in the scene AND in the chapter: base, one warning per dangling reference', () => {
        const book = makeBook();
        const result = resolveHeroLook(book, { looks: { woland: 'gone' } }, { looks: { woland: 'ghost_look' } }, 'woland');
        expect(result).to.deep.include({ look_id: 'base', source: 'base', clothes: 'black suit' });
        expect(result.warnings).to.deep.equal(['unknown_look', 'unknown_look']);
    });

    it('look_patch applies over the base passport when no look is assigned', () => {
        const book = makeBook();
        const scene = { look_patch: { woland: { video_tokens: ['monocle'] } } };
        const result = resolveHeroLook(book, {}, scene, 'woland');
        expect(result).to.deep.include({ look_id: 'base', source: 'base', clothes: 'black suit' });
        expect(result.video_tokens).to.deep.equal(['monocle']);
        expect(result.patched).to.deep.equal(['video_tokens']);
        expect(result.changed).to.deep.equal(['video_tokens']);
        expect(result.base.video_tokens).to.deep.equal(['dark hair', 'black suit']);
    });

    it('"base" in the scene keeps look_patch but drops the chapter look entirely', () => {
        const book = makeBook();
        const chapter = { looks: { woland: 'coat' } };
        const scene = { looks: { woland: 'base' }, look_patch: { woland: { clothes: 'bathrobe' } } };
        const result = resolveHeroLook(book, chapter, scene, 'woland');
        expect(result).to.deep.include({ look_id: 'base', source: 'base', clothes: 'bathrobe' });
        expect(result.video_tokens).to.deep.equal(['dark hair', 'black suit']); // not the coat tokens
        expect(result.image_ref).to.equal(null);
    });

    it('a look does not inherit another look: only its own fields override the passport', () => {
        const book = makeBook();
        // "beard" changes appearance only; nothing of "coat" leaks in, even with
        // a (non-format) pointer to it.
        book.heroes[0].looks[1].base = 'coat';
        book.heroes[0].looks[1].extends = 'coat';
        const result = resolveHeroLook(book, { looks: { woland: 'coat' } }, { looks: { woland: 'beard' } }, 'woland');
        expect(result.clothes).to.equal('black suit');
        expect(result.video_tokens).to.deep.equal(['dark hair', 'black suit']);
        expect(result.changed).to.deep.equal(['appearance']);
    });

    it('assignments of other heroes and prototype keys are ignored', () => {
        const book = makeBook();
        book.heroes.push({ id: 'constructor', passport: { appearance: 'plain', clothes: 'grey', video_tokens: ['x'] } });
        const scene = { looks: { margarita: 'coat' }, look_patch: { margarita: { clothes: 'cloak' } } };
        expect(resolveHeroLook(book, {}, scene, 'woland')).to.deep.include({ look_id: 'base', clothes: 'black suit' });
        const proto = resolveHeroLook(book, { looks: {} }, { looks: {}, look_patch: {} }, 'constructor');
        expect(proto).to.deep.include({ look_id: 'base', source: 'base', clothes: 'grey' });
        expect(proto.patched).to.deep.equal([]);
        expect(proto.warnings).to.deep.equal([]);
    });

    it('a passport that is not an object means "no passport"', () => {
        const book = makeBook();
        book.heroes.push({ id: 'odd', passport: ['tall'] }, { id: 'nul', passport: null });
        expect(resolveHeroLook(book, {}, {}, 'odd')).to.equal(null);
        expect(resolveHeroLook(book, {}, {}, 'nul')).to.equal(null);
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
