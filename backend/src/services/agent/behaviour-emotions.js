// ======================================================
// Behaviour emotions — the fixed per-IU emotion vocabulary (EN)
// ======================================================
// unit.state = { <character_id>: <emotion> } is written by the visuals step
// (same LLM call, no new request) and validated by the host against this
// list. Behaviour rules match on it (rule.when.emotion).
//
// The SAME list is spelled out in backend/ai/rules/visuals.md
// ("Character emotions (unit.state)") — tests/behaviour-emotions.test.js
// pins both to stay identical. Docs: animastor-docs
// architecture/VBOOK_BEHAVIOUR.md.
// ======================================================

'use strict';

const BEHAVIOUR_EMOTIONS = Object.freeze([
    'neutral',
    'joyful',
    'sad',
    'angry',
    'afraid',
    'surprised',
    'disgusted',
    'embarrassed',
    'anxious',
    'proud',
    'confused',
    'determined',
    'thoughtful',
    'tender',
    'tense',
]);

const EMOTION_SET = new Set(BEHAVIOUR_EMOTIONS);

function isBehaviourEmotion(value) {
    return typeof value === 'string' && EMOTION_SET.has(value);
}

/**
 * Host validation of a raw unit.state from the LLM.
 * Keeps only entries whose key is a known character id and whose value is a
 * vocabulary emotion (case/whitespace-normalized). Returns a new object
 * (possibly empty — an empty state is valid).
 * @param {*} raw
 * @param {Iterable<string>} knownCharacterIds
 */
function sanitizeUnitState(raw, knownCharacterIds) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const known = knownCharacterIds instanceof Set ? knownCharacterIds : new Set(knownCharacterIds || []);
    for (const [charId, emotion] of Object.entries(raw)) {
        if (!known.has(charId)) continue;
        if (typeof emotion !== 'string') continue;
        const e = emotion.trim().toLowerCase();
        if (EMOTION_SET.has(e)) out[charId] = e;
    }
    return out;
}

module.exports = {
    BEHAVIOUR_EMOTIONS,
    isBehaviourEmotion,
    sanitizeUnitState,
};
