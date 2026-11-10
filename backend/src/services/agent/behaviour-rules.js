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

let _defaultsCache = null;
function loadDefaultRules(filePath = DEFAULT_RULES_PATH) {
    if (filePath === DEFAULT_RULES_PATH && _defaultsCache) return _defaultsCache;
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rules = Array.isArray(doc?.rules) ? doc.rules : [];
    if (filePath === DEFAULT_RULES_PATH) _defaultsCache = rules;
    return rules;
}

/** Rules stored in a book's behavior.json (v2 only — v2.1 files have none). */
function readBookRules(bookDir) {
    if (!bookDir) return [];
    const p = path.join(bookDir, 'behavior.json');
    if (!fs.existsSync(p)) return [];
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!doc || typeof doc !== 'object' || doc.schema_version == null) return [];
    return Array.isArray(doc.rules) ? doc.rules : [];
}

/**
 * Effective rules for a book directory. Never throws: a broken defaults
 * file or behavior.json is logged and treated as "no rules" for that source.
 */
function loadEffectiveRules(bookDir, { log = console } = {}) {
    let defaults = [];
    let bookRules = [];
    try { defaults = loadDefaultRules(); } catch (e) {
        log.warn(`[BEHAVIOUR] default rules unreadable: ${e.message}`);
    }
    try { bookRules = readBookRules(bookDir); } catch (e) {
        log.warn(`[BEHAVIOUR] behavior.json rules unreadable (${bookDir}): ${e.message}`);
    }
    return computeEffectiveRules(defaults, bookRules);
}

module.exports = {
    DEFAULT_RULES_PATH,
    RULE_DEFAULTS,
    ACTION_MAX_CHARS,
    sanitizeRule,
    computeEffectiveRules,
    loadDefaultRules,
    readBookRules,
    loadEffectiveRules,
};
