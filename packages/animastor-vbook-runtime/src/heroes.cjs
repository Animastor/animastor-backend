// ======================================================
// heroes — the ONE reader port over book.heroes (VBOOK_FORMAT_V4 §8.1)
// ======================================================
// In v4 a hero is one object everywhere: characters/<id>.json on disk, an
// element of book.heroes[] in memory, an element of heroes[] in the API. The
// maps book.characters / book.voices / book.behaviors are gone, so readers ask
// these helpers instead of walking the array by hand.
//
// `heroRules` flattens hero behaviour rules for the matcher: scope and
// character_id are not stored in the hero file, they follow from where the
// rule lives (§6.2). Duplicate rule ids across heroes/globals are reported and
// the later source is skipped, so matching stays deterministic.

'use strict';

const CANONICAL_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_HERO_ID_LENGTH = 64;
const NARRATOR_ID = 'narrator';

// Reserved ids cannot be a hero id: they name files/directories of the book.
const RESERVED_HERO_IDS = Object.freeze([
    'manifest', 'book', 'bible', 'locations', 'voices', 'characters',
    'behavior', 'behaviour', 'mentions', 'index',
]);

function isCanonicalHeroId(id) {
    if (typeof id !== 'string' || id.length > MAX_HERO_ID_LENGTH) return false;
    return CANONICAL_ID_RE.test(id);
}

function heroList(book) {
    return book && Array.isArray(book.heroes) ? book.heroes : [];
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function findHero(book, heroId) {
    return heroList(book).find((h) => isPlainObject(h) && h.id === heroId) || null;
}

// Heroes with a passport — the replacement for the old book.characters and the
// only ones that take part in analysis/generation character registries (§4).
function passportHeroes(book) {
    return heroList(book).filter((h) => isPlainObject(h) && isPlainObject(h.passport));
}

function narrator(book) {
    return findHero(book, NARRATOR_ID);
}

// The only place that builds the TTS description (§5.1).
function voiceInstruct(hero) {
    const voice = hero && isPlainObject(hero.voice) ? hero.voice : null;
    if (!voice) return '';
    return [voice.timbre, voice.manner]
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.trim())
        .join(' ');
}

// Alias → hero id, built on the fly (§7). An alias claimed by two heroes is
// ambiguous: it is left out of the map and reported.
function buildAliasIndex(heroes) {
    const index = Object.create(null);
    const claimedBy = Object.create(null);
    const ambiguous = [];

    for (const hero of Array.isArray(heroes) ? heroes : []) {
        if (!isPlainObject(hero) || typeof hero.id !== 'string') continue;
        const aliases = Array.isArray(hero.aliases) ? hero.aliases : [];
        for (const alias of aliases) {
            if (typeof alias !== 'string' || !alias.trim()) continue;
            const key = alias.trim();
            if (claimedBy[key] && claimedBy[key] !== hero.id) {
                if (!ambiguous.includes(key)) ambiguous.push(key);
                delete index[key];
                continue;
            }
            claimedBy[key] = hero.id;
            index[key] = hero.id;
        }
    }

    return { index, ambiguous };
}

// Effective hero rules for the matcher: every hero rule gets its derived
// scope/character_id; duplicates (including global rules) keep the first one.
function heroRules(book) {
    const rules = [];
    const duplicates = [];
    const seen = new Set();

    const globalRules = book && isPlainObject(book.behaviour) && Array.isArray(book.behaviour.rules)
        ? book.behaviour.rules
        : [];
    for (const rule of globalRules) {
        if (!isPlainObject(rule) || typeof rule.id !== 'string') continue;
        if (seen.has(rule.id)) { duplicates.push(rule.id); continue; }
        seen.add(rule.id);
        rules.push({ ...rule, scope: 'global' });
    }

    for (const hero of heroList(book)) {
        if (!isPlainObject(hero)) continue;
        const heroRuleList = isPlainObject(hero.behaviour) && Array.isArray(hero.behaviour.rules)
            ? hero.behaviour.rules
            : [];
        for (const rule of heroRuleList) {
            if (!isPlainObject(rule) || typeof rule.id !== 'string') continue;
            if (seen.has(rule.id)) { duplicates.push(rule.id); continue; }
            seen.add(rule.id);
            rules.push({ ...rule, scope: 'character', character_id: hero.id });
        }
    }

    return { rules, duplicates };
}

module.exports = {
    CANONICAL_ID_RE,
    MAX_HERO_ID_LENGTH,
    NARRATOR_ID,
    RESERVED_HERO_IDS,
    isCanonicalHeroId,
    findHero,
    passportHeroes,
    narrator,
    voiceInstruct,
    buildAliasIndex,
    heroRules,
};
