// ======================================================
// Behaviour apply — the single pipeline hook (both runner paths)
// ======================================================
// Called ONCE per window by runPipeline AND processCachedScenes, after every
// LLM step of the window (visuals → reconcile → polish → final sweep →
// fantasy repair) and before the window is saved — no later step can
// rewrite or drop unit.behaviour. Only the IU of the current window are
// touched; ready scenes of the book are never recomputed.
//
// No rules → no-op (no ids assigned, nothing written). Otherwise every IU
// of the window gets its final id here (the matcher seed depends on it;
// lazy-book create keeps a pre-assigned id) and unit.behaviour is set where
// a rule fired. No new step_type, no progress stage.
// ======================================================

'use strict';

const { unitId } = require('@animastor/vbook-runtime/lazy-book/paths');
const { matchSceneBehaviours } = require('./behaviour-matcher');
const { loadEffectiveSettings } = require('./behaviour-rules');

/**
 * @param {object[]} scenes — enriched scenes of the window (mutated in place)
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {object[]} [opts.characters]
 * @param {string|null} [opts.bookDir] — book directory (book rules come from its behavior.json)
 * @param {object[]} [opts.rules] — effective rules (tests); default: loaded from bookDir
 * @param {number|null} [opts.maxPerScene] — scene limit with explicit rules (tests); default: from settings
 * @returns {{rules:number, applied:number}}
 */
function applyBehavioursToWindow(scenes, { bookId, characters, bookDir = null, rules, maxPerScene = null } = {}) {
    const list = Array.isArray(scenes) ? scenes : [];
    if (!bookId || list.length === 0) return { rules: 0, applied: 0 };

    let effective = rules;
    let limit = maxPerScene;
    if (!Array.isArray(effective)) {
        const settings = loadEffectiveSettings(bookDir);
        effective = settings.rules;
        limit = settings.maxPerScene;
    }
    if (effective.length === 0) return { rules: 0, applied: 0 };

    // Known ids filter state entries; without a character list (tests) the
    // state is taken as already validated by the visuals step.
    const characterIds = Array.isArray(characters) ? characters.map(c => c && c.id).filter(Boolean) : undefined;
    let applied = 0;
    for (const scene of list) {
        const units = Array.isArray(scene?.units) ? scene.units : [];
        if (units.length === 0) continue;
        for (const u of units) {
            if (u && (typeof u.id !== 'string' || !u.id)) u.id = unitId();
        }
        const result = matchSceneBehaviours({ bookId, scene, units, rules: effective, characterIds, maxPerScene: limit });
        result.forEach((behaviour, i) => {
            if (behaviour) {
                units[i].behaviour = behaviour;
                applied += behaviour.length;
            }
        });
    }
    if (applied > 0) console.log(`[BEHAVIOUR] ${bookId}: ${applied} behaviour(s) applied (${effective.length} effective rule(s))`);
    return { rules: effective.length, applied, maxPerScene: limit };
}

module.exports = { applyBehavioursToWindow };
