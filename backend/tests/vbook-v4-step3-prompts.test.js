// ======================================================
// VBook 4 step 3 — generation reads heroes: prompts equal the 3.1 golden
// ======================================================
// Acceptance (VBOOK_FORMAT_V4 §12, step 3): for a fixture book in the v4 shape
// the image and video prompts equal the 3.1 golden of the same book.
// tests/fixtures/vbook-v4-step3/book.cjs renders one book in both shapes;
// golden.json was produced by the 3.1 readers (resolvePassport,
// buildCharLines over book.characters / scene.passport / chapter.character)
// before they were replaced by resolveHeroLook.

'use strict';

const { expect } = require('chai');
const fx = require('./fixtures/vbook-v4-step3/book.cjs');
const golden = require('./fixtures/vbook-v4-step3/golden.json');
const promptBuilder = require('../src/image/prompt-builder');
const videoWorkflows = require('../src/workflows/video/video-workflows');

const build = { buildImagePrompt: promptBuilder.buildImagePrompt, buildVideoPrompt: videoWorkflows.buildVideoPrompt };
const { collectSceneHeroIssues } = require('@animastor/vbook-runtime/heroes.cjs');

// Deliberate differences from the 3.1 golden (owner's decision 18.11, step 4):
// image takes a participant ONLY by its exact hero id, like video. Scene s2
// lists "berlioz" — 3.1 found mikhail_berlioz by the first four letters of a
// name token, v4 leaves the participant out and reports it as a non-blocking
// `unknown_participant` of the book. Nothing else differs.
const BERLIOZ_LINE = 'mikhail_berlioz: Short, plump man, pale and sweating, grey summer suit, straw hat, ';
const DELIBERATE = {
    'ch1/s2/u3': (golden) => golden.replace(BERLIOZ_LINE, ''),
    'ch1/s2/u4': (golden) => golden.replace(BERLIOZ_LINE, ''),
};

describe('VBook 4 step 3 — image and video prompts of a v4 book equal the 3.1 golden', () => {
    const v4 = fx.allPrompts(fx.bookV4(), build);

    it('the golden covers every unit and scene of the fixture', () => {
        expect(Object.keys(golden.image)).to.have.length(5);
        expect(Object.keys(golden.video)).to.have.length(3);
    });

    for (const key of Object.keys(golden.image)) {
        if (DELIBERATE[key]) {
            it(`image ${key} — the golden without the fuzzy participant (deliberate, step 4)`, () => {
                expect(golden.image[key]).to.include(BERLIOZ_LINE, 'the 3.1 golden had it');
                expect(v4.image[key]).to.equal(DELIBERATE[key](golden.image[key]));
            });
        } else {
            it(`image ${key}`, () => expect(v4.image[key]).to.equal(golden.image[key]));
        }
    }

    it('the deliberate differences are exactly the two units of scene s2 (the "berlioz" participant)', () => {
        const differing = Object.keys(golden.image).filter((k) => v4.image[k] !== golden.image[k]);
        expect(differing).to.deep.equal(Object.keys(DELIBERATE));
        expect(Object.keys(golden.video).filter((k) => v4.video[k] !== golden.video[k])).to.deep.equal([]);
    });

    it('the participant that is not a hero id is a non-blocking warning of the book', () => {
        const issues = collectSceneHeroIssues(fx.bookV4());
        expect(issues.map((i) => [i.code, i.participant, i.blocking])).to.deep.equal([['unknown_participant', 'berlioz', false]]);
    });
    for (const key of Object.keys(golden.video)) {
        it(`video ${key}`, () => expect(v4.video[key]).to.equal(golden.video[key]));
    }

    it('the generation readers no longer see the 3.1 maps: a v4 book has no characters / scene.passport', () => {
        const v4book = fx.bookV4();
        expect(v4book).to.not.have.property('characters');
        expect(JSON.stringify(v4book.chapters)).to.not.include('"passport":{"appearance"');
        // the 3.1 shape given to the v4 readers yields no hero lines at all
        const old = fx.allPrompts(fx.book31(), build);
        expect(old.video['ch1/s1']).to.not.include('mikhail_berlioz:');
    });

    it('what v4 adds on top of 3.1: a chapter look reaches the video tokens too (3.1 video did not see chapters)', () => {
        const book = fx.bookV4();
        const ivan = book.heroes.find((h) => h.id === 'ivan_ponyrev');
        ivan.looks[0].fields.video_tokens = ['cowboy shirt'];
        const out = fx.allPrompts(book, build);
        expect(out.video['ch1/s1']).to.include('ivan_ponyrev: cowboy shirt.');
        expect(out.video['ch2/s3']).to.include('ivan_ponyrev: checked cap.');
    });
});
