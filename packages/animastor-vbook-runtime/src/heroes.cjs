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

const { normalizeForMatch } = require('./character-identity');

const CANONICAL_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_HERO_ID_LENGTH = 64;
const NARRATOR_ID = 'narrator';

// Reserved ids cannot be a hero id: they name files/directories of the book.
const RESERVED_HERO_IDS = Object.freeze([
    'manifest', 'book', 'bible', 'locations', 'voices', 'characters',
    'behavior', 'behaviour', 'mentions', 'index',
]);

// Grammar only: one path segment, lower-case snake_case, up to 64 characters.
// A canonical id never contains a separator, a dot or a non-ASCII character,
// so it is safe as a file name — but it may still be reserved (below).
function isCanonicalHeroId(id) {
    if (typeof id !== 'string' || id.length > MAX_HERO_ID_LENGTH) return false;
    return CANONICAL_ID_RE.test(id);
}

function isReservedHeroId(id) {
    return RESERVED_HERO_IDS.includes(id);
}

// An id a hero may actually carry: canonical grammar and not reserved.
function isValidHeroId(id) {
    return isCanonicalHeroId(id) && !isReservedHeroId(id);
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

// Alias → hero id, built on the fly (§7). Keys keep the author's spelling;
// two spellings are the SAME alias when they are equal after normalizeForMatch
// ("Юрий" / "юрий "), which is also how duplicates inside one hero are judged.
// An alias claimed by two heroes is ambiguous: every spelling of it is left
// out of the map and it is reported once (first spelling seen).
function buildAliasIndex(heroes) {
    const groups = new Map(); // normalized alias → { owners:Set<id>, spellings:[[spelling, id]] }

    for (const hero of Array.isArray(heroes) ? heroes : []) {
        if (!isPlainObject(hero) || typeof hero.id !== 'string') continue;
        const aliases = Array.isArray(hero.aliases) ? hero.aliases : [];
        for (const alias of aliases) {
            if (typeof alias !== 'string' || !alias.trim()) continue;
            const spelling = alias.trim();
            const key = normalizeForMatch(spelling) || spelling.toLowerCase();
            let group = groups.get(key);
            if (!group) { group = { owners: new Set(), spellings: [] }; groups.set(key, group); }
            group.owners.add(hero.id);
            group.spellings.push([spelling, hero.id]);
        }
    }

    const index = Object.create(null);
    const ambiguous = [];
    for (const group of groups.values()) {
        if (group.owners.size > 1) {
            ambiguous.push(group.spellings[0][0]);
            continue;
        }
        for (const [spelling, id] of group.spellings) index[spelling] = id;
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

// Display order (§3): the narrator first, then ids from book.json's
// structure.characters_order (a hint — unknown and missing ids are fine),
// then the rest alphabetically. Returns a new array.
function sortHeroes(heroes, charactersOrder) {
    const order = Array.isArray(charactersOrder) ? charactersOrder : [];
    const rank = new Map();
    order.forEach((id, i) => { if (typeof id === 'string' && !rank.has(id)) rank.set(id, i); });
    return [...heroes].sort((a, b) => {
        if (a.id === b.id) return 0;
        if (a.id === NARRATOR_ID) return -1;
        if (b.id === NARRATOR_ID) return 1;
        const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
        const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
        if (ra !== rb) return ra - rb;
        return a.id < b.id ? -1 : 1;
    });
}

// Book-level findings about the cast (§10.3), added to hero_issues by the
// loaders next to the per-file ones:
//   narrator_missing   (blocking)     — no healthy characters/narrator.json
//   duplicate_rule_id  (non-blocking) — the later rule is not applied (§6.2)
//   ambiguous_alias    (non-blocking) — the alias is left out of the index (§7)
function collectBookHeroIssues(book) {
    const issues = [];
    if (!narrator(book)) {
        issues.push({
            file: 'characters/narrator.json', hero_id: NARRATOR_ID, code: 'narrator_missing',
            message: 'the narrator file is missing or broken; narration uses the default voice',
            blocking: true,
        });
    }
    for (const id of heroRules(book).duplicates) {
        issues.push({ code: 'duplicate_rule_id', message: `behaviour rule id "${id}" is used more than once; the later rule is not applied`, blocking: false });
    }
    for (const alias of buildAliasIndex(heroList(book)).ambiguous) {
        issues.push({ code: 'ambiguous_alias', message: `alias "${alias}" is claimed by more than one hero`, blocking: false });
    }
    return issues;
}

module.exports = {
    CANONICAL_ID_RE,
    MAX_HERO_ID_LENGTH,
    NARRATOR_ID,
    RESERVED_HERO_IDS,
    isCanonicalHeroId,
    isReservedHeroId,
    isValidHeroId,
    findHero,
    passportHeroes,
    narrator,
    voiceInstruct,
    buildAliasIndex,
    heroRules,
    sortHeroes,
    collectBookHeroIssues,
};
