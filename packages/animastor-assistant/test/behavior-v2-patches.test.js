// edit_book on behavior.json schema v2 — legacy /behaviors/<id> paths and
// flat-map replacements land in behaviors.characters; rules survive.
const { expect } = require('chai');
const { createChatEngine } = require('../src/index.cjs');

const engine = () => createChatEngine({}, { validateBundleObject: () => ({ valid: true, errors: [] }) });
const RULE = { id: 'r1', when: { emotion: ['sad'] }, then: { action: 'sighs' } };
const book = () => ({ behaviors: { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } } } });

describe('assistant — behavior.json v2 patch guard', () => {
    it('rewrites /behaviors/<id>[/...] to /behaviors/characters/<id>[/...]', () => {
        const out = engine().normalizeBehaviorPatches(book(), [
            { op: 'replace', path: '/behaviors/hero/baseline', value: 'x' },
            { op: 'add', path: '/behaviors/side', value: {} },
            { op: 'replace', path: '/behaviors/characters/hero/baseline', value: 'y' },
            { op: 'replace', path: '/behaviors/rules', value: [] },
        ]);
        expect(out.map(p => p.path)).to.deep.equal([
            '/behaviors/characters/hero/baseline',
            '/behaviors/characters/side',
            '/behaviors/characters/hero/baseline',
            '/behaviors/rules',
        ]);
    });

    it('a flat map written to /behaviors becomes characters; rules kept', () => {
        const { result, errors } = engine().applyPatches(book(), [{ op: 'replace', path: '/behaviors', value: { hero: { baseline: 'z' }, schema_version: 9 } }]);
        expect(errors).to.deep.equal([]);
        expect(result.behaviors).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'z' } } });
    });

    it('a legacy in-memory map (no schema_version) is left alone', () => {
        const legacy = { behaviors: { hero: {} } };
        const patches = [{ op: 'replace', path: '/behaviors/hero', value: { baseline: 'q' } }];
        expect(engine().normalizeBehaviorPatches(legacy, patches)).to.deep.equal(patches);
    });
});
