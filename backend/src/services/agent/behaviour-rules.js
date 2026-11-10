// ======================================================
// Behaviour rules — effective rule set of a book (host, with I/O)
// ======================================================
// Effective rules = repository defaults (backend/ai/examples/behaviour-rules.json)
// overridden by the book's behavior.json v2 `rules` with the same id
// (shallow merge: a book entry {id, enabled:false} disables a default);
// book-only ids are added. Disabled and invalid rules are dropped here, so
// the matcher only ever sees well-formed rules.
//
// Rule (schema v2):
//   {id, scope:"global"|"character", character_id?, when:{emotion:[], unit_type?:[]},
//    then:{action}, strength 0..1, probability 0..1, cooldown_iu, priority, enabled?}
// Missing numbers fall back to RULE_DEFAULTS.
//
// Scene limit: defaults.max_per_scene of the defaults file (2), overridden by
// the book's behavior.json defaults.max_per_scene (integer ≥ 0; 0 = behaviours
// off in every scene). Invalid values are ignored; neither set = unlimited.
//
// Docs: animastor-docs architecture/VBOOK_BEHAVIOUR.md.
// ======================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { isBehaviourEmotion } = require('./behaviour-emotions');

const DEFAULT_RULES_PATH = path.join(__dirname, '..', '..', '..', 'ai', 'examples', 'behaviour-rules.json');
const ACTION_MAX_CHARS = 200;
const RULE_DEFAULTS = Object.freeze({ strength: 1, probability: 0.35, cooldown_iu: 4, priority: 0 });

function clamp01(v, fallback) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return Math.min(1, Math.max(0, n));
}

/** Well-formed copy of a rule, or null when it cannot be applied. */
function sanitizeRule(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) return null;
    if (raw.enabled === false) return null;
    const scope = raw.scope === 'character' ? 'character' : raw.scope === 'global' || raw.scope == null ? 'global' : null;
    if (!scope) return null;
    const characterId = typeof raw.character_id === 'string' ? raw.character_id.trim() : '';
    if (scope === 'character' && !characterId) return null;
    const emotions = (Array.isArray(raw.when?.emotion) ? raw.when.emotion : [])
        .filter(isBehaviourEmotion);
    if (emotions.length === 0) return null;
    const unitTypes = Array.isArray(raw.when?.unit_type)
        ? raw.when.unit_type.filter(t => typeof t === 'string' && t)
        : null;
    let action = typeof raw.then?.action === 'string' ? raw.then.action.trim() : '';
    if (!action) return null;
    if (action.length > ACTION_MAX_CHARS) action = action.slice(0, ACTION_MAX_CHARS).trim();
    const cooldown = Number.isInteger(raw.cooldown_iu) && raw.cooldown_iu >= 0 ? raw.cooldown_iu : RULE_DEFAULTS.cooldown_iu;
    const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : RULE_DEFAULTS.priority;
    const rule = {
        id,
        scope,
        when: { emotion: emotions },
        then: { action },
        strength: clamp01(raw.strength, RULE_DEFAULTS.strength),
        probability: clamp01(raw.probability, RULE_DEFAULTS.probability),
        cooldown_iu: cooldown,
        priority,
    };
    if (scope === 'character') rule.character_id = characterId;
    if (unitTypes && unitTypes.length > 0) rule.when.unit_type = unitTypes;
    return rule;
}

/**
 * @param {object[]} defaults  — repository default rules
 * @param {object[]} bookRules — behavior.json v2 rules of the book
 * @returns {object[]} sanitized effective rules, sorted by id
 */
function computeEffectiveRules(defaults, bookRules) {
    const merged = new Map();
    for (const r of (Array.isArray(defaults) ? defaults : [])) {
        if (r && typeof r.id === 'string' && r.id) merged.set(r.id, { ...r });
    }
    for (const r of (Array.isArray(bookRules) ? bookRules : [])) {
        if (!r || typeof r.id !== 'string' || !r.id) continue;
        const base = merged.get(r.id) || {};
        merged.set(r.id, { ...base, ...r });
    }
    const out = [];
    for (const r of merged.values()) {
        const s = sanitizeRule(r);
        if (s) out.push(s);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
}

/** Integer ≥ 0, or undefined when the value cannot be used. */
function sanitizeMaxPerScene(v) {
    return Number.isInteger(v) && v >= 0 ? v : undefined;
}

let _defaultsCache = null;
function loadDefaultsDoc(filePath = DEFAULT_RULES_PATH) {
    if (filePath === DEFAULT_RULES_PATH && _defaultsCache) return _defaultsCache;
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (filePath === DEFAULT_RULES_PATH) _defaultsCache = doc;
    return doc;
}

function loadDefaultRules(filePath = DEFAULT_RULES_PATH) {
    const doc = loadDefaultsDoc(filePath);
    return Array.isArray(doc?.rules) ? doc.rules : [];
}

/** A book's behavior.json when it is a v2 document, else null (v2.1 has no rules/defaults). */
function readBookDoc(bookDir) {
    if (!bookDir) return null;
    const p = path.join(bookDir, 'behavior.json');
    if (!fs.existsSync(p)) return null;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schema_version == null) return null;
    return doc;
}

/** Rules stored in a book's behavior.json (v2 only — v2.1 files have none). */
function readBookRules(bookDir) {
    const doc = readBookDoc(bookDir);
    return doc && Array.isArray(doc.rules) ? doc.rules : [];
}

/**
 * Effective settings from the two documents (pure).
 * @returns {{rules: object[], maxPerScene: number|null}}
 */
function computeEffectiveSettings(defaultsDoc, bookDoc) {
    const rules = computeEffectiveRules(defaultsDoc?.rules, bookDoc?.rules);
    const fromBook = sanitizeMaxPerScene(bookDoc?.defaults?.max_per_scene);
    const fromDefaults = sanitizeMaxPerScene(defaultsDoc?.defaults?.max_per_scene);
    const maxPerScene = fromBook !== undefined ? fromBook : fromDefaults !== undefined ? fromDefaults : null;
    return { rules, maxPerScene };
}

/**
 * Effective rules + scene limit for a book directory. Never throws: a broken
 * defaults file or behavior.json is logged and treated as absent.
 */
function loadEffectiveSettings(bookDir, { log = console } = {}) {
    let defaultsDoc = null;
    let bookDoc = null;
    try { defaultsDoc = loadDefaultsDoc(); } catch (e) {
        log.warn(`[BEHAVIOUR] default rules unreadable: ${e.message}`);
    }
    try { bookDoc = readBookDoc(bookDir); } catch (e) {
        log.warn(`[BEHAVIOUR] behavior.json unreadable (${bookDir}): ${e.message}`);
    }
    return computeEffectiveSettings(defaultsDoc, bookDoc);
}

/** Effective rules only (see loadEffectiveSettings). */
function loadEffectiveRules(bookDir, opts) {
    return loadEffectiveSettings(bookDir, opts).rules;
}

module.exports = {
    DEFAULT_RULES_PATH,
    RULE_DEFAULTS,
    ACTION_MAX_CHARS,
    sanitizeRule,
    computeEffectiveRules,
    loadDefaultRules,
    loadDefaultsDoc,
    readBookDoc,
    readBookRules,
    sanitizeMaxPerScene,
    computeEffectiveSettings,
    loadEffectiveSettings,
    loadEffectiveRules,
};
