// ======================================================
// hero-id — canonical hero ids for characters that come from the analysis
// ======================================================
// A hero id is the file name characters/<id>.json (VBOOK_FORMAT_V4 §4), so it
// must be canonical snake_case, at most 64 characters and not reserved. An LLM
// returns whatever it likes: "Юра", "Anna-Sergeevna", "The Shop Woman", "book".
// This module turns such a value into an id — deterministically:
//
//   normalizeHeroId(text)  lower case → fixed Cyrillic → Latin table →
//                          everything outside [a-z0-9] becomes "_" → repeats
//                          collapse → trimmed → cut to 64.
//
//   assignHeroIds(candidates, existingHeroes)
//       gives every candidate of one analysis window its final id:
//       - the SAME hero keeps its id across windows: a candidate whose name or
//         alias names exactly one existing hero gets that hero's id; so does a
//         candidate whose own id is an id of the book (also after
//         transliteration) — unless that id is shared by several heroes;
//       - an ambiguous match (the name points at one hero, an alias at
//         another; an alias two heroes claim; an id that yura and yura_2
//         share) merges nothing — the candidate is a new hero;
//       - two different characters of ONE window whose ids coincide after
//         normalisation, and a reserved id, get the first free suffix _2, _3, …
//         in the order the candidates arrive, so the same input always
//         produces the same ids;
//       - the spelling the model used is never lost: it goes to `name`, and
//         every other variant (the raw id when it was text, alias/aliases) to
//         `aliases`.
//
// Pure functions: no I/O, inputs are not mutated.

'use strict';

const { normalizeForMatch } = require('./character-identity');
const {
    MAX_HERO_ID_LENGTH, isCanonicalHeroId, isReservedHeroId, isValidHeroId,
} = require('./heroes.cjs');

// Fixed transliteration table (lower case only; input is lower-cased first).
// The same letters as the editor's cyr-latin-map / toEntityId, so an id typed
// by a person and an id derived by the analysis agree.
const CYR_TO_LATIN = Object.freeze({
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya',
});

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
    return typeof v === 'string' ? v.trim() : '';
}

function cut(id, max) {
    return id.length > max ? id.slice(0, max).replace(/_+$/, '') : id;
}

/**
 * Any text → canonical snake_case id ('' when nothing usable is left).
 * Grammar only: the result may still be reserved or taken.
 */
function normalizeHeroId(raw) {
    const source = text(raw).toLowerCase();
    if (!source) return '';
    let out = '';
    for (const ch of source) {
        out += Object.prototype.hasOwnProperty.call(CYR_TO_LATIN, ch) ? CYR_TO_LATIN[ch] : ch;
    }
    out = out.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return cut(out, MAX_HERO_ID_LENGTH);
}

/** base, base_2, base_3 … — the first id that is valid and not in `taken`. */
function firstFreeId(base, taken) {
    if (isValidHeroId(base) && !taken.has(base)) return base;
    for (let n = 2; n < 100000; n++) {
        const suffix = `_${n}`;
        const id = `${cut(base, MAX_HERO_ID_LENGTH - suffix.length)}${suffix}`;
        if (isValidHeroId(id) && !taken.has(id)) return id;
    }
    return '';
}

const matchKey = (v) => normalizeForMatch(v) || text(v).toLowerCase();

/** Is `base` used by more than one hero (base, base_2, …)? */
function isSharedBase(base, ids) {
    const prefix = `${base}_`;
    for (const id of ids) {
        if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) return true;
    }
    return false;
}

// name / alias → hero id over the existing cast. A key claimed by two heroes
// is ambiguous and matches nobody.
function buildIdentityIndex(heroes) {
    const owners = new Map(); // key → Set<id>
    const claim = (value, id) => {
        const key = matchKey(value);
        if (!key) return;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(id);
    };
    for (const hero of heroes) {
        if (!isPlainObject(hero) || typeof hero.id !== 'string') continue;
        claim(hero.name, hero.id);
        for (const alias of Array.isArray(hero.aliases) ? hero.aliases : []) claim(alias, hero.id);
    }
    return owners;
}

function candidateAliases(candidate) {
    const list = [];
    if (text(candidate.alias)) list.push(text(candidate.alias));
    for (const a of Array.isArray(candidate.aliases) ? candidate.aliases : []) {
        if (text(a)) list.push(text(a));
    }
    return list;
}

/**
 * Which existing hero is this candidate, judged by name and aliases?
 * @returns {{ id: string|null, ambiguous: boolean }}
 */
function matchExistingHero(candidate, identityIndex) {
    const hits = new Set();
    let ambiguous = false;
    for (const value of [candidate.name, ...candidateAliases(candidate)]) {
        const owners = identityIndex.get(matchKey(value));
        if (!owners) continue;
        if (owners.size > 1) { ambiguous = true; continue; }
        hits.add([...owners][0]);
    }
    if (hits.size === 1 && !ambiguous) return { id: [...hits][0], ambiguous: false };
    return { id: null, ambiguous: ambiguous || hits.size > 1 };
}

/** Aliases a hero keeps: unique after normalizeForMatch, never equal to the name. */
function mergeAliases(name, ...lists) {
    const seen = new Set();
    const nameKey = matchKey(name);
    if (nameKey) seen.add(nameKey);
    const out = [];
    for (const list of lists) {
        for (const value of Array.isArray(list) ? list : []) {
            const spelling = text(value);
            const key = matchKey(spelling);
            if (!spelling || !key || seen.has(key)) continue;
            seen.add(key);
            out.push(spelling);
        }
    }
    return out;
}

/**
 * Final ids for the characters of one analysis window.
 *
 * @param {object[]} candidates      [{ id?, name?, alias?, aliases? … }] in the order the analysis returned them
 * @param {object[]} existingHeroes  heroes already in the book ({ id, name?, aliases? })
 * @returns {{
 *   assignments: { index: number, candidate: object, id: string, existing: boolean,
 *                  name: string, aliases: string[], rawId: string, reason: string }[],
 *   skipped: { index: number, candidate: object, rawId: string, reason: string }[],
 *   idMap: Map<string, string>   // raw id (as the model wrote it) → final id
 * }}
 * reason of an assignment: 'same_id' | 'matched_by_name' | 'new' | 'new_suffix' | 'new_reserved'
 * reason of a skip: 'empty_id'
 */
function assignHeroIds(candidates, existingHeroes) {
    const existing = (Array.isArray(existingHeroes) ? existingHeroes : [])
        .filter((h) => isPlainObject(h) && typeof h.id === 'string');
    const existingIds = new Set(existing.map((h) => h.id));
    const identityIndex = buildIdentityIndex(existing);
    const taken = new Set(existingIds);

    const assignments = [];
    const skipped = [];
    const idMap = new Map();
    const rawIdConflicts = new Set();
    // heroes created earlier in THIS window take part in name matching too
    const windowIndex = new Map();
    const claimInWindow = (value, id) => {
        const key = matchKey(value);
        if (!key) return;
        if (!windowIndex.has(key)) windowIndex.set(key, new Set());
        windowIndex.get(key).add(id);
    };

    (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
        if (!isPlainObject(candidate)) return;
        const rawId = text(candidate.id);
        const name = text(candidate.name);
        // the id the model wrote, or — when nothing usable is left of it — the name
        const base = normalizeHeroId(rawId) || normalizeHeroId(name);
        if (!base) {
            skipped.push({ index, candidate, rawId, reason: 'empty_id' });
            return;
        }

        let id = null;
        let reason = null;
        let isExisting = false;

        // 1. Name / aliases name exactly one hero of the book → the same hero,
        //    whatever id the model wrote this time. The name is the stronger
        //    evidence: two heroes may share a normalized id (sasha, sasha_2),
        //    and a repeated window must find each of them again.
        {
            const match = matchExistingHero(candidate, identityIndex);
            if (match.id) { id = match.id; reason = 'matched_by_name'; isExisting = true; }
        }
        // 2. The id the model wrote IS an id of the book — as it stands or after
        //    transliteration ("Юра" → yura) → the same hero; the name it used
        //    this time becomes an alias. Not when that id is known to be shared
        //    by different people (yura AND yura_2 exist): then the id alone is
        //    ambiguous, only the name can tell them apart (rule 1), and a
        //    candidate nobody recognises is a new hero.
        if (!id && existingIds.has(base) && !isSharedBase(base, existingIds)) {
            id = base; reason = 'same_id'; isExisting = true;
        }
        // 3. The same character twice in one window (same raw id, or same name).
        if (!id && rawId && idMap.has(rawId) && !rawIdConflicts.has(rawId)) {
            const earlier = assignments.find((a) => a.id === idMap.get(rawId));
            const sameName = !name || !earlier || !earlier.name || matchKey(earlier.name) === matchKey(name);
            if (sameName) { id = idMap.get(rawId); reason = 'same_id'; }
        }
        if (!id) {
            const match = matchExistingHero(candidate, windowIndex);
            if (match.id) { id = match.id; reason = 'matched_by_name'; }
        }
        // 4. A new hero: the normalized id, or the first free suffix.
        if (!id) {
            id = firstFreeId(base, taken);
            if (!id) {
                skipped.push({ index, candidate, rawId, reason: 'empty_id' });
                return;
            }
            reason = id === base ? 'new' : (isReservedHeroId(base) ? 'new_reserved' : 'new_suffix');
            taken.add(id);
        }

        // raw id → final id, for participants / speakers / mentions written with
        // the model's own id. One raw id that ended up as two heroes maps to none.
        if (rawId) {
            if (idMap.has(rawId) && idMap.get(rawId) !== id) rawIdConflicts.add(rawId);
            else idMap.set(rawId, id);
        }

        // The id the model wrote is kept as an alias when it was a way of
        // NAMING the character ("Женщина в будочке"). Not when the id had to
        // be suffixed — then it is the other hero's id — and not when it
        // already names somebody else: an alias must point at one hero only.
        const suffixed = reason === 'new_suffix' || reason === 'new_reserved';
        const namesAnother = (value) => {
            const key = matchKey(value);
            const owners = [...(identityIndex.get(key) || []), ...(windowIndex.get(key) || [])];
            return owners.some((owner) => owner !== id);
        };
        const rawIdAsAlias = rawId && !suffixed && !isCanonicalHeroId(rawId) && /[^a-z0-9_\s-]/i.test(rawId) && !namesAnother(rawId)
            ? [rawId] : [];
        const aliases = mergeAliases(name, rawIdAsAlias, candidateAliases(candidate).filter((a) => !namesAnother(a)));
        assignments.push({ index, candidate, id, existing: isExisting, name, aliases, rawId, reason });
        if (!isExisting) {
            claimInWindow(name, id);
            for (const alias of aliases) claimInWindow(alias, id);
        }
    });

    for (const rawId of rawIdConflicts) idMap.delete(rawId);
    return { assignments, skipped, idMap };
}

module.exports = {
    CYR_TO_LATIN,
    normalizeHeroId,
    firstFreeId,
    mergeAliases,
    assignHeroIds,
};
