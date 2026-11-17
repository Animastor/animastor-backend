// ======================================================
// VBook 4 step 3 — the invalidation registry on heroes and looks
// ======================================================
// VBOOK_FORMAT_V4 §4a.5, §8.2 (acceptance of step 3):
//   - a test per field of a hero: passport.* → image + video of the scenes
//     where the resolved look changed; the LOCKED reference (sha256,
//     ref_text) → audio; voice.timbre / voice.manner → nothing (kept from
//     VOICE_REFERENCES / generation 0.2.0: chunks are cloned from the
//     reference; §8.2 lists them → audio — an open question, step 3 report);
//     name, role, aliases, notes, image_refs, behaviour.* → no layer;
//   - looks: an edit of a look field marks image + video only of the scenes
//     where the look acts; an assignment to a chapter — the chapter's scenes
//     without their own reference; an edit of an overridden base field —
//     nothing; label / notes — nothing; audio is never marked by a look.
// Real book-diff (host) + real collectScenes + the package registry.

'use strict';

const { expect } = require('chai');
const { collectScenes } = require('@animastor/vbook-runtime');
const createBookDiff = require('../src/services/book-diff.cjs');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeDiff() {
    return createBookDiff(null, {}, {
        state: { AssetState: {}, SceneState: {} },
        book: { loadBook: () => null, findSceneRuntimeData: () => null, collectScenes },
        layerConfig: {}, genScope: {}, activeScenes: {}, getChunk: async () => null, saveChunk: async () => {},
        utils: { log: () => {}, collectScenes },
    });
}

// ch1: s1 (anna, boris), s2 (anna; scene look "base"), s3 (boris)
// ch2: s4 (anna; scene look "coat"), s5 (anna)
// anna has the look "coat" (clothes) and "hat" (appearance, assigned nowhere)
function book() {
    return {
        manifest: { book_id: 'reg', vbook_version: 4 },
        heroes: [
            {
                id: 'narrator', name: 'Рассказчик',
                voice: { timbre: 'A calm male voice.', manner: 'Even.' },
            },
            {
                id: 'anna', name: 'Анна', role: 'main', aliases: ['Аня'], notes: 'n',
                passport: { appearance: 'young woman', clothes: 'grey dress', video_tokens: ['grey dress'] },
                looks: [
                    { id: 'coat', label: 'В пальто', notes: 'зима', fields: { clothes: 'red coat', video_tokens: ['red coat'] } },
                    { id: 'hat', label: 'В шляпе', fields: { appearance: 'young woman in a hat' } },
                ],
                voice: { timbre: 'A light soprano.', manner: 'Quick.', reference: { file: 'voices/anna/c1.wav', sha256: SHA_A, ref_text: 'Да.', source: 'designed', verification: 'passed', locked: true } },
                behaviour: { profile: { baseline: 'calm' }, rules: [] },
                image_refs: [],
            },
            {
                id: 'boris', name: 'Борис',
                passport: { appearance: 'old man', clothes: 'black suit', video_tokens: ['black suit'] },
                voice: { timbre: 'A low bass.', manner: '' },
            },
        ],
        chapters: [
            {
                chapter_id: 'ch1',
                scenes: [
                    { scene_id: 's1', participants: ['anna', 'boris'], units: [{ id: 'u1', type: 'dialogue', audio: { speaker: 'boris' } }] },
                    { scene_id: 's2', participants: ['anna'], looks: { anna: 'base' } },
                    { scene_id: 's3', participants: ['boris'] },
                ],
            },
            {
                chapter_id: 'ch2',
                scenes: [
                    { scene_id: 's4', participants: ['anna'], looks: { anna: 'coat' } },
                    { scene_id: 's5', participants: ['anna'] },
                ],
            },
        ],
    };
}

const hero = (b, id) => b.heroes.find((h) => h.id === id);
const look = (b, id) => hero(b, 'anna').looks.find((l) => l.id === id);

function dirty(edit) {
    const before = book();
    const after = book();
    edit(after);
    const result = makeDiff().computeBookDiff(before, after);
    const out = {};
    for (const d of result.dirty_scenes) out[d.scene_id] = [...d.dirty_layers].sort();
    return out;
}
const IV = ['image', 'video'];

describe('VBook 4 step 3 — the invalidation registry (heroes, looks)', () => {
    it('an unchanged book → nothing', () => {
        expect(dirty(() => {})).to.deep.equal({});
    });

    describe('every field of a hero', () => {
        const CASES = [
            // [field, edit, expected]
            ['passport.appearance (not overridden anywhere) → image + video of every scene of anna', (b) => { hero(b, 'anna').passport.appearance = 'tall woman'; },
                { s1: IV, s2: IV, s4: IV, s5: IV }],
            ['passport.clothes → only the scenes where no look overrides clothes (s4 wears the coat)', (b) => { hero(b, 'anna').passport.clothes = 'blue dress'; },
                { s1: IV, s2: IV, s5: IV }],
            ['passport.video_tokens → the scenes where the base tokens act', (b) => { hero(b, 'anna').passport.video_tokens = ['blue dress']; },
                { s1: IV, s2: IV, s5: IV }],
            ['voice.timbre → nothing (chunks are cloned from the locked reference)', (b) => { hero(b, 'anna').voice.timbre = 'A dark alto.'; }, {}],
            ['voice.manner → nothing', (b) => { hero(b, 'boris').voice.manner = 'Slow.'; }, {}],
            ['voice.reference.sha256 (locked) → audio', (b) => { hero(b, 'anna').voice.reference.sha256 = SHA_B; },
                { s1: ['audio'], s2: ['audio'], s4: ['audio'], s5: ['audio'] }],
            ['voice.reference.ref_text (locked) → audio', (b) => { hero(b, 'anna').voice.reference.ref_text = 'Нет.'; },
                { s1: ['audio'], s2: ['audio'], s4: ['audio'], s5: ['audio'] }],
            ['the narrator\'s locked reference → audio of every scene', (b) => {
                hero(b, 'narrator').voice.reference = { file: 'voices/narrator/c1.wav', sha256: SHA_B, ref_text: 'И вот.', source: 'designed', verification: 'passed', locked: true };
            }, { s1: ['audio'], s2: ['audio'], s3: ['audio'], s4: ['audio'], s5: ['audio'] }],
            ['boris\'s locked reference → audio of the scenes where he takes part or speaks', (b) => {
                hero(b, 'boris').voice.reference = { file: 'voices/boris/c1.wav', sha256: SHA_B, ref_text: 'Ну.', source: 'designed', verification: 'passed', locked: true };
            }, { s1: ['audio'], s3: ['audio'] }],
            ['name → nothing', (b) => { hero(b, 'anna').name = 'Анна Сергеевна'; }, {}],
            ['role → nothing', (b) => { hero(b, 'anna').role = 'minor'; }, {}],
            ['aliases → nothing', (b) => { hero(b, 'anna').aliases.push('Анечка'); }, {}],
            ['notes → nothing', (b) => { hero(b, 'anna').notes = 'другое'; }, {}],
            ['image_refs → nothing', (b) => { hero(b, 'anna').image_refs.push({ file: 'refs/anna/1.png', sha256: SHA_B }); }, {}],
            ['behaviour.* → nothing', (b) => { hero(b, 'anna').behaviour.profile.baseline = 'nervous'; hero(b, 'anna').behaviour.rules.push({ id: 'r1' }); }, {}],
            ['unlocking a locked reference → audio (the reference no longer applies)', (b) => {
                const r = hero(b, 'anna').voice.reference; r.locked = false;
            }, { s1: ['audio'], s2: ['audio'], s4: ['audio'], s5: ['audio'] }],
        ];
        for (const [name, edit, want] of CASES) {
            it(name, () => expect(dirty(edit)).to.deep.equal(want));
        }
        it('voice.reference: an edit of an UNLOCKED reference → nothing', () => {
            const before = book(); hero(before, 'anna').voice.reference.locked = false;
            const after = book(); hero(after, 'anna').voice.reference.locked = false; hero(after, 'anna').voice.reference.sha256 = SHA_B;
            expect(makeDiff().computeBookDiff(before, after).dirty_scenes).to.deep.equal([]);
        });
    });

    describe('looks (§4a.5)', () => {
        it('an edit of a look field → image + video only of the scenes where the look acts (s4)', () => {
            expect(dirty((b) => { look(b, 'coat').fields.clothes = 'green coat'; })).to.deep.equal({ s4: IV });
        });
        it('an edit of a look that is assigned nowhere → nothing', () => {
            expect(dirty((b) => { look(b, 'hat').fields.appearance = 'woman in a big hat'; })).to.deep.equal({});
        });
        it('assigning a look to a chapter → the chapter\'s scenes without their own reference (s1, not s2 with "base")', () => {
            expect(dirty((b) => { b.chapters[0].looks = { anna: 'coat' }; })).to.deep.equal({ s1: IV });
        });
        it('assigning to ch2 where s4 already has the coat → only s5', () => {
            expect(dirty((b) => { b.chapters[1].looks = { anna: 'coat' }; })).to.deep.equal({ s5: IV });
        });
        it('an edit of a base field the look overrides, in the look\'s scene → nothing there', () => {
            const d = dirty((b) => { hero(b, 'anna').passport.clothes = 'blue dress'; });
            expect(d).to.not.have.property('s4');
        });
        it('label / notes of a look → nothing', () => {
            expect(dirty((b) => { look(b, 'coat').label = 'Зимнее'; look(b, 'coat').notes = 'другое'; })).to.deep.equal({});
        });
        it('scene.look_patch → that scene only; equal to the resolved value → nothing', () => {
            expect(dirty((b) => { b.chapters[0].scenes[0].look_patch = { anna: { video_tokens: ['scarf'] } }; })).to.deep.equal({ s1: IV });
            expect(dirty((b) => { b.chapters[0].scenes[0].look_patch = { anna: { clothes: 'grey dress' } }; })).to.deep.equal({});
        });
        it('a scene look reference → that scene', () => {
            expect(dirty((b) => { b.chapters[0].scenes[2].looks = { boris: 'missing_look' }; })).to.deep.equal({});
            expect(dirty((b) => { b.chapters[1].scenes[1].looks = { anna: 'coat' }; })).to.deep.equal({ s5: IV });
        });
        it('audio is never marked by a look', () => {
            for (const edit of [
                (b) => { look(b, 'coat').fields.clothes = 'x'; },
                (b) => { b.chapters[0].looks = { anna: 'coat' }; },
                (b) => { b.chapters[0].scenes[0].look_patch = { anna: { appearance: 'y' } }; },
                (b) => { hero(b, 'anna').passport.appearance = 'z'; },
            ]) {
                for (const layers of Object.values(dirty(edit))) expect(layers).to.not.include('audio');
            }
        });
    });
});
