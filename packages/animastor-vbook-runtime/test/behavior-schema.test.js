// behavior.json schema v2 helpers (src/behavior-schema.cjs) — pure, no I/O.
const { expect } = require('chai');
const s = require('../src/behavior-schema.cjs');

const RULE = { id: 'r1', scope: 'global', when: { emotion: ['sad'] }, then: { action: 'sighs' } };

describe('behavior-schema (v2)', () => {
    it('normalizeBehaviors: legacy v2.1 → all top-level keys become characters', () => {
        expect(s.normalizeBehaviors({ hero: { baseline: 'x' } })).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'x' } } });
        expect(s.normalizeBehaviors({})).to.deep.equal({ schema_version: 2, rules: [], characters: {} });
        expect(s.normalizeBehaviors(null)).to.deep.equal({ schema_version: 2, rules: [], characters: {} });
    });

    it('normalizeBehaviors: v2 coerced, unknown top-level keys kept', () => {
        expect(s.normalizeBehaviors({ schema_version: 2, rules: [RULE], characters: { a: {} }, defaults: { p: 1 } }))
            .to.deep.equal({ schema_version: 2, rules: [RULE], characters: { a: {} }, defaults: { p: 1 } });
        expect(s.normalizeBehaviors({ schema_version: 2, rules: 'x', characters: [] }))
            .to.deep.equal({ schema_version: 2, rules: [], characters: {} });
    });

    it('ensureBehaviorsV2 / behaviorCharacters migrate in place and are idempotent', () => {
        const book = { behaviors: { hero: { baseline: 'x' } } };
        const chars = s.behaviorCharacters(book);
        chars.side = {};
        expect(book.behaviors).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'x' }, side: {} } });
        const same = s.ensureBehaviorsV2(book);
        expect(same).to.equal(book.behaviors);
    });

    it('API projection: flat map + behavior_rules, input untouched', () => {
        const book = { a: 1, behaviors: { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'x' } } } };
        const api = s.projectBookBehaviorsForApi(book);
        expect(api).to.deep.equal({ a: 1, behaviors: { hero: { baseline: 'x' } }, behavior_rules: [RULE] });
        expect(book.behaviors.schema_version).to.equal(2);
    });

    it('mergeIncomingBehaviors: flat map keeps rules; undefined keeps all; v2 without rules keeps rules', () => {
        const stored = { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'old' } } };
        expect(s.mergeIncomingBehaviors(stored, { hero: { baseline: 'new' }, characters: { z: 1 }, rules: [] }))
            .to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'new' } } });
        expect(s.mergeIncomingBehaviors(stored, undefined)).to.deep.equal(stored);
        expect(s.mergeIncomingBehaviors(stored, { schema_version: 2, characters: {} }))
            .to.deep.equal({ schema_version: 2, rules: [RULE], characters: {} });
        expect(s.mergeIncomingBehaviors(null, { hero: {} })).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: {} } });
    });
});
