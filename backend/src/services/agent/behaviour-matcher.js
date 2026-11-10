// ======================================================
// Behaviour matcher — deterministic rule application (phase 0)
// ======================================================
// Pure function, no I/O, no Math.random. Given a scene, its IU (in order)
// and the effective rules, decides which rules fire on which IU and returns
// unit.behaviour = [{rule_id, character_id, strength, seed, action}].
//
//   condition  : unit.state[character_id] ∈ rule.when.emotion
//                (and unit.type ∈ rule.when.unit_type when given;
//                 scope:"character" → only rule.character_id)
//   off        : enabled === false, strength <= 0 or probability <= 0
//   roll       : seed = first 4 bytes of sha256(`${book_id}:${rule_id}:${unit_id}`)
//                as uint32; fires when seed / 2^32 < probability
//   cooldown   : per (rule_id, character_id) inside the scene, by IU order;
//                after a fire at index i the rule is blocked for that hero on
//                i+1 … i+cooldown_iu
//   conflicts  : at most one behaviour per hero per IU — higher priority,
//                then rule id ascending
//   idempotent : IU with behaviour_locked:true or an existing behaviour array
//                are skipped (their existing entries still count for cooldown)
//   snapshot   : `action` is a copy of rule.then.action at application time
//
// Docs: animastor-docs architecture/VBOOK_BEHAVIOUR.md.
// ======================================================

'use strict';

const crypto = require('crypto');
const { isBehaviourEmotion } = require('./behaviour-emotions');

const SEED_SPACE = 2 ** 32;

function behaviourSeed(bookId, ruleId, unitId) {
    const h = crypto.createHash('sha256').update(`${bookId}:${ruleId}:${unitId}`).digest();
    return h.readUInt32BE(0);
}

function isRuleActive(rule) {
    return !!rule && rule.enabled !== false
        && typeof rule.strength === 'number' && rule.strength > 0
        && typeof rule.probability === 'number' && rule.probability > 0
        && rule.then && typeof rule.then.action === 'string' && rule.then.action.trim() !== '';
}

function ruleAppliesTo(rule, characterId, emotion, unitType) {
    if (rule.scope === 'character' && rule.character_id !== characterId) return false;
    const emotions = Array.isArray(rule.when?.emotion) ? rule.when.emotion : [];
    if (!emotions.includes(emotion)) return false;
    const types = rule.when?.unit_type;
    if (Array.isArray(types) && types.length > 0 && !types.includes(unitType || 'perception')) return false;
    return true;
}

function compareRules(a, b) {
    const pa = Number.isFinite(a.priority) ? a.priority : 0;
    const pb = Number.isFinite(b.priority) ? b.priority : 0;
    if (pa !== pb) return pb - pa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {object} input
 * @param {string} input.bookId
 * @param {object} [input.scene]           — unused by the phase-0 conditions; kept for the contract
 * @param {object[]} input.units           — scene IU in order (each needs a string id)
 * @param {object[]} input.rules           — effective rules (see behaviour-rules.js)
 * @param {Iterable<string>} [input.characterIds] — known character ids; state
 *                                            entries of other ids are ignored
 * @returns {Array<null|object[]>} parallel to units: null = leave the unit
 *          untouched (skipped or nothing fired); array = new unit.behaviour
 */
function matchSceneBehaviours({ bookId, units, rules, characterIds } = {}) {
    const list = Array.isArray(units) ? units : [];
    const out = list.map(() => null);
    const active = (Array.isArray(rules) ? rules : []).filter(isRuleActive);
    if (active.length === 0 || list.length === 0) return out;
    const known = characterIds ? new Set(characterIds) : null;

    // last fire index per `${rule_id}\u0000${character_id}`
    const lastFired = new Map();
    const key = (ruleId, charId) => `${ruleId}\u0000${charId}`;
    const blocked = (rule, charId, idx) => {
        const last = lastFired.get(key(rule.id, charId));
        if (last === undefined) return false;
        const cd = Number.isInteger(rule.cooldown_iu) && rule.cooldown_iu > 0 ? rule.cooldown_iu : 0;
        return idx - last <= cd;
    };

    for (let idx = 0; idx < list.length; idx++) {
        const unit = list[idx] || {};

        if (unit.behaviour_locked === true || Array.isArray(unit.behaviour)) {
            for (const b of (Array.isArray(unit.behaviour) ? unit.behaviour : [])) {
                if (b && b.rule_id && b.character_id) lastFired.set(key(b.rule_id, b.character_id), idx);
            }
            continue;
        }
        if (typeof unit.id !== 'string' || !unit.id) continue;

        const state = unit.state && typeof unit.state === 'object' && !Array.isArray(unit.state) ? unit.state : {};
        const applied = [];
        for (const charId of Object.keys(state).sort()) {
            const emotion = state[charId];
            if (known && !known.has(charId)) continue;
            if (!isBehaviourEmotion(emotion)) continue;

            const candidates = [];
            for (const rule of active) {
                if (!ruleAppliesTo(rule, charId, emotion, unit.type)) continue;
                if (blocked(rule, charId, idx)) continue;
                const seed = behaviourSeed(bookId, rule.id, unit.id);
                if (seed / SEED_SPACE >= rule.probability) continue;
                candidates.push({ rule, seed });
            }
            if (candidates.length === 0) continue;
            candidates.sort((a, b) => compareRules(a.rule, b.rule));
            const { rule, seed } = candidates[0];
            lastFired.set(key(rule.id, charId), idx);
            applied.push({
                rule_id: rule.id,
                character_id: charId,
                strength: rule.strength,
                seed,
                action: String(rule.then.action).trim(),
            });
        }
        if (applied.length > 0) out[idx] = applied;
    }
    return out;
}

module.exports = {
    matchSceneBehaviours,
    behaviourSeed,
    SEED_SPACE,
};
