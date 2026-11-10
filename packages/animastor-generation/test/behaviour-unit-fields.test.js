// prompt-dependency-registry — explicit unit fields of the behaviour feature.
const { expect } = require('chai');
const r = require('../src/dirty-grammar/prompt-dependency-registry.js');

const scene = (u) => ({ scene_id: 'sc-1', units: [{ id: 'iu-1', text: 'x', ...u }] });

describe('prompt-dependency-registry — behaviour unit fields', () => {
    it('unit.behaviour → video only', () => {
        expect(r.computeSceneDirtyLayers(scene({}), scene({ behaviour: [{ rule_id: 'a' }] })).dirtyLayers).to.deep.equal(['video']);
    });
    it('unit.state / unit.behaviour_locked → no layer', () => {
        expect(r.computeSceneDirtyLayers(scene({}), scene({ state: { a: 'sad' } })).dirtyLayers).to.deep.equal([]);
        expect(r.computeSceneDirtyLayers(scene({}), scene({ behaviour_locked: true })).dirtyLayers).to.deep.equal([]);
    });
    it('unknown unit fields still mark every layer', () => {
        expect(r.computeSceneDirtyLayers(scene({}), scene({ mystery: 1 })).dirtyLayers).to.include.members(['audio', 'image', 'video']);
    });
});
