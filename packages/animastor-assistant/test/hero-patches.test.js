// edit_book on VBook 4 heroes (@animastor/assistant 0.3.0, VBOOK_FORMAT_V4 §8.2):
// the segment after /heroes/ is a hero ID — the guard turns it into the array
// index before the patches run; the 3.1 paths (/characters, /voices,
// /behaviors …) are refused with a hint. Replaces the behavior.json v2 guard
// of 0.2.0 (normalizeBehaviorPatches), which the format no longer needs.
const { expect } = require('chai');
const { createChatEngine } = require('../src/index.cjs');

const engine = () => createChatEngine({}, { validateBundleObject: () => ({ valid: true, errors: [] }) });
const RULE = { id: 'r1', when: { emotion: ['sad'] }, then: { action: 'sighs' } };
const book = () => ({
    behaviour: { schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [RULE] },
    heroes: [
        { schema: 'animastor.character/1', id: 'narrator', role: 'narrator' },
        { schema: 'animastor.character/1', id: 'hero', behaviour: { profile: { baseline: 'calm' }, rules: [{ id: 'hero.r', then: { action: 'x' } }] } },
        { schema: 'animastor.character/1', id: 'side' },
    ],
});

describe('assistant — hero path guard (VBook 4)', () => {
    it('rewrites /heroes/<id>[/...] to /heroes/<index>[/...]; add /heroes/<new id> appends a hero', () => {
        const { patches, errors } = engine().normalizeHeroPatches(book(), [
            { op: 'replace', path: '/heroes/hero/behaviour/profile/baseline', value: 'x' },
            { op: 'add', path: '/heroes/side/behaviour/profile', value: {} },
            { op: 'add', path: '/heroes/anna', value: { name: 'Анна' } },
            { op: 'replace', path: '/book/title', value: 'T' },
        ]);
        expect(errors).to.deep.equal([]);
        expect(patches.map((p) => p.path)).to.deep.equal(['/heroes/1/behaviour/profile/baseline', '/heroes/2/behaviour/profile', '/heroes/-', '/book/title']);
        expect(patches[2].value).to.deep.equal({ schema: 'animastor.character/1', name: 'Анна', id: 'anna' });
    });

    it('the 3.1 paths and computed fields are refused with a hint; nothing is applied', () => {
        for (const path of ['/behaviors', '/behaviors/hero', '/characters/0', '/voices/narrator', '/mentions/x', '/behavior_rules/0', '/hero_issues/0', '/scene_list/0']) {
            const { result, errors } = engine().applyPatches(book(), [{ op: 'replace', path, value: {} }]);
            expect(errors, path).to.have.length(1);
            expect(result.heroes[1].behaviour.profile.baseline, path).to.equal('calm');
        }
        expect(engine().applyPatches(book(), [{ op: 'replace', path: '/behaviors/hero/baseline', value: 'q' }]).errors[0])
            .to.match(/not part of VBook 4.*\/heroes\/<hero_id>/);
    });

    it('ids, not indexes: /heroes/0, /heroes/-, /heroes and the id / schema / rev / voice.reference of a hero are refused', () => {
        const refused = [
            { op: 'replace', path: '/heroes/0/name', value: 'x' },
            { op: 'add', path: '/heroes/-', value: { id: 'x' } },
            { op: 'replace', path: '/heroes', value: [] },
            { op: 'remove', path: '/heroes' },
            { op: 'replace', path: '/heroes/hero/id', value: 'x' },
            { op: 'replace', path: '/heroes/hero/schema', value: 'x' },
            { op: 'add', path: '/heroes/hero/voice/reference', value: {} },
            { op: 'add', path: '/heroes/hero/voice', value: { timbre: 'x', reference: {} } },
            { op: 'add', path: '/heroes/Hero', value: {} },
            { op: 'add', path: '/heroes/anna', value: { id: 'other' } },
        ];
        for (const p of refused) {
            expect(engine().normalizeHeroPatches(book(), [p]).errors, JSON.stringify(p)).to.have.length(1);
        }
    });

    it('removing a hero takes its rules with it (they live in its file); the narrator cannot be removed; the input is untouched', () => {
        const b = book();
        const { result, errors } = engine().applyPatches(b, [{ op: 'remove', path: '/heroes/hero' }]);
        expect(errors).to.deep.equal([]);
        expect(result.heroes.map((h) => h.id)).to.deep.equal(['narrator', 'side']);
        expect(result.behaviour.rules).to.deep.equal([RULE]);
        expect(b.heroes).to.have.length(3);
        expect(engine().applyPatches(b, [{ op: 'remove', path: '/heroes/narrator' }]).errors[0]).to.match(/narrator cannot be removed/);
    });
});
