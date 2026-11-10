// ======================================================
// behavior.json — schema v2 (character behaviour + behaviour rules)
// ======================================================
// Three representations (see animastor-docs architecture/VBOOK_BEHAVIOUR.md):
//
//   disk / memory (v2):
//     { schema_version: 2,
//       rules: [ {id, scope, character_id?, when, then, strength, probability,
//                 cooldown_iu, priority, enabled?} ],
//       characters: { <character_id>: {baseline, quirks, reactions} } }
//
//   API (GET /book): flat character map exactly like v2.1 under `behaviors`
//   + read-only `behavior_rules` (released Android/web clients parse
//   `behaviors` as Map<character_id, entry>; v2 keys would break them).
//
//   legacy v2.1 file (no schema_version): every top-level key is a
//   character entry — migrated on load, always saved back as v2.
//
// Pure functions, zero I/O. Character entries stay schema-tolerant: unknown
// keys inside an entry are never touched. Unknown top-level keys of a v2
// document are preserved (passthrough).
// ======================================================

'use strict';

const BEHAVIOR_SCHEMA_VERSION = 2;

// Top-level keys of a v2 document that are NOT character ids. A flat map
// coming from a client never carries them as characters.
const BEHAVIOR_RESERVED_KEYS = Object.freeze(['schema_version', 'rules', 'characters', 'defaults']);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isV2(raw) {
    return isPlainObject(raw) && raw.schema_version != null;
}

/**
 * Any stored/received behaviour value → canonical v2 document (new object).
 * - not an object            → empty v2
 * - no schema_version (v2.1) → all top-level keys become `characters`
 * - v2                       → rules/characters coerced to array/object,
 *                              other top-level keys passed through
 */
function normalizeBehaviors(raw) {
    if (!isPlainObject(raw)) {
        return { schema_version: BEHAVIOR_SCHEMA_VERSION, rules: [], characters: {} };
    }
    if (!isV2(raw)) {
        return { schema_version: BEHAVIOR_SCHEMA_VERSION, rules: [], characters: { ...raw } };
    }
    const out = { ...raw };
    out.schema_version = BEHAVIOR_SCHEMA_VERSION;
    out.rules = Array.isArray(raw.rules) ? raw.rules : [];
    out.characters = isPlainObject(raw.characters) ? raw.characters : {};
    return out;
}

/** Normalize `book.behaviors` in place; returns the v2 document. */
function ensureBehaviorsV2(book) {
    if (!book || typeof book !== 'object') return normalizeBehaviors(null);
    const raw = book.behaviors;
    if (isV2(raw) && Array.isArray(raw.rules) && isPlainObject(raw.characters)
        && raw.schema_version === BEHAVIOR_SCHEMA_VERSION) {
        return raw;
    }
    book.behaviors = normalizeBehaviors(raw);
    return book.behaviors;
}

/** The mutable character map of a book (`book.behaviors.characters`). */
function behaviorCharacters(book) {
    return ensureBehaviorsV2(book).characters;
}

/** v2 (or legacy) → API projection: flat character map + read-only rules. */
function toApiBehaviors(raw) {
    const v2 = normalizeBehaviors(raw);
    return { behaviors: { ...v2.characters }, behavior_rules: [...v2.rules] };
}

/**
 * Projection of a whole loaded book for an HTTP response. Shallow copy —
 * the in-memory model keeps v2. `behavior_rules` is read-only output.
 */
function projectBookBehaviorsForApi(bookData) {
    if (!bookData || typeof bookData !== 'object') return bookData;
    const { behaviors, behavior_rules } = toApiBehaviors(bookData.behaviors);
    return { ...bookData, behaviors, behavior_rules };
}

/** Flat client map → character entries (reserved keys dropped). */
function flatToCharacters(flat) {
    const out = {};
    if (!isPlainObject(flat)) return out;
    for (const [k, v] of Object.entries(flat)) {
        if (BEHAVIOR_RESERVED_KEYS.includes(k)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Merge a client-supplied `behaviors` value into the stored v2 document.
 * Clients only ever see the flat API map, so:
 *   - undefined/null incoming → stored document unchanged
 *   - flat map                → replaces `characters`; rules and any other
 *                               top-level keys of the stored doc survive
 *   - v2 document (schema_version === 2)
 *                             → taken as is, but a missing `rules` array
 *                               keeps the stored rules
 */
function mergeIncomingBehaviors(stored, incoming) {
    const base = normalizeBehaviors(stored);
    if (incoming === undefined || incoming === null) return base;
    if (isPlainObject(incoming) && incoming.schema_version === BEHAVIOR_SCHEMA_VERSION) {
        const next = normalizeBehaviors(incoming);
        if (!Array.isArray(incoming.rules)) next.rules = base.rules;
        return next;
    }
    if (!isPlainObject(incoming)) return base;
    return { ...base, characters: flatToCharacters(incoming) };
}

module.exports = {
    BEHAVIOR_SCHEMA_VERSION,
    BEHAVIOR_RESERVED_KEYS,
    normalizeBehaviors,
    ensureBehaviorsV2,
    behaviorCharacters,
    toApiBehaviors,
    projectBookBehaviorsForApi,
    flatToCharacters,
    mergeIncomingBehaviors,
};
