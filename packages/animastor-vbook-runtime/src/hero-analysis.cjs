// ======================================================
// hero-analysis — between the analysis and the hero files
// ======================================================
// The analysis works on its own list of characters — plain objects with the
// fields the prompts need ({ id, name, role, appearance, clothes, video_tokens,
// description, traits, voice }). The BOOK keeps heroes: characters/<id>.json
// (VBOOK_FORMAT_V4 §4). This module is the only bridge between the two:
//
//   registryFromBook(book, working)   the character registry of the next
//       window, read from the hero files — the book is the source of truth
//       between windows, so what a person changed, added or deleted in the
//       editor is what the analysis sees. The analysis-only working fields
//       (description, traits) ride along from the previous window.
//
//   mentionsFromBook(book, working)   alias → hero id for the prompts, built on
//       the fly from hero.aliases (buildAliasIndex); mentions whose target is
//       not a hero ("natural designations") come from the working map only.
//
//   normalizeWindowCharacters(candidates, registry)   canonical ids for what
//       the model returned (assignHeroIds), before anything refers to them.
//
//   mergeWindowIntoHero(hero, addition)   what a later window may do to a hero
//       that already exists: ADD what is missing, never replace. A voice a
//       person edited (timbre_source 'user') or one with a locked reference is
//       not touched at all; looks are never touched.
//
// Pure functions: no I/O, inputs are not mutated.

'use strict';

const { hasRealAppearance, normalizeForMatch } = require('./character-identity');
const { buildAliasIndex, passportHeroes, isValidHeroId, NARRATOR_ID } = require('./heroes.cjs');
const { assignHeroIds, mergeAliases } = require('./hero-id.cjs');
const { isVoiceProtected } = require('./voice');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const matchKey = (v) => normalizeForMatch(v) || text(v).toLowerCase();

/** A hero as the analysis prompts see it. */
function workingCharacterFromHero(hero, working) {
    const passport = isPlainObject(hero.passport) ? hero.passport : {};
    const out = {
        ...(isPlainObject(working) ? { description: working.description, traits: working.traits } : {}),
        id: hero.id,
        name: text(hero.name) || hero.id,
        role: text(hero.role) || undefined,
        aliases: Array.isArray(hero.aliases) ? [...hero.aliases] : [],
        appearance: text(passport.appearance),
        clothes: text(passport.clothes),
        video_tokens: Array.isArray(passport.video_tokens) ? [...passport.video_tokens] : [],
        passport: {
            appearance: text(passport.appearance),
            clothes: text(passport.clothes),
            video_tokens: Array.isArray(passport.video_tokens) ? [...passport.video_tokens] : [],
        },
    };
    if (isPlainObject(hero.voice)) {
        out.voice = { timbre: text(hero.voice.timbre), manner: text(hero.voice.manner) };
        // a person's voice / a locked reference: the voice step must not ask
        // for anything of it (not even a missing manner)
        if (isVoiceProtected(hero.voice)) out.voice.protected = true;
    }
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out;
}

/**
 * The character registry for the next analysis window.
 *
 * @param {object} book      v4 book ({ heroes })
 * @param {object[]} [working] the working list of the previous window (PG window data)
 * @returns {object[]} heroes with a passport, in book order, then the working-only
 *   entries that never became a file because they have no described appearance.
 *   A working entry WITH a described appearance and without a file was deleted
 *   by a person (or never written) — the book wins, it is not brought back.
 */
function registryFromBook(book, working) {
    const workingList = (Array.isArray(working) ? working : []).filter((c) => isPlainObject(c) && typeof c.id === 'string');
    const workingById = new Map(workingList.map((c) => [c.id, c]));
    const heroes = passportHeroes(book).filter((h) => h.id !== NARRATOR_ID);
    const onDisk = new Set((book && Array.isArray(book.heroes) ? book.heroes : []).map((h) => h && h.id));
    const registry = heroes.map((h) => workingCharacterFromHero(h, workingById.get(h.id)));
    for (const c of workingList) {
        if (onDisk.has(c.id) || hasRealAppearance(c)) continue;
        registry.push({ ...c });
    }
    return registry;
}

/**
 * alias → id for the prompts of the next window.
 * Aliases of heroes come from the hero files; an alias two heroes claim is left
 * out (ambiguous). Working mentions are kept only when their target is NOT a
 * hero of the book — those never live in a file (§7).
 */
function mentionsFromBook(book, working) {
    const heroes = book && Array.isArray(book.heroes) ? book.heroes : [];
    const heroIds = new Set(heroes.map((h) => h && h.id));
    const { index, ambiguous } = buildAliasIndex(heroes);
    const ambiguousKeys = new Set(ambiguous.map(matchKey));
    const out = {};
    if (isPlainObject(working)) {
        for (const [alias, target] of Object.entries(working)) {
            if (typeof target !== 'string' || heroIds.has(target) || ambiguousKeys.has(matchKey(alias))) continue;
            out[alias] = target;
        }
    }
    for (const [alias, id] of Object.entries(index)) out[alias] = id;
    return out;
}

/**
 * Canonical ids for the characters one window returned.
 * @returns {{ characters: object[], idMap: Map<string,string>, skipped: object[] }}
 *   characters — copies with the final `id`, the model's `name`, and `aliases`
 *   extended with the other spellings; `existing: true` marks a hero already in
 *   the registry (matched by id, name or alias).
 *   merges — one entry per candidate that turned out to be a hero of the
 *   registry: { from, name, to, reason, evidence } (the journal of the window).
 *   possible_duplicates — new heroes that ONE mention clue ties to a hero of
 *   the registry (not merged): { from, name, id, of, evidence }.
 * @param {{ mentions?: object }} [options]  the window's mentions — evidence
 *   for a renamed hero (assignHeroIds, 'matched_by_mentions').
 */
function normalizeWindowCharacters(candidates, registry, options = {}) {
    const { assignments, skipped, idMap, possibleDuplicates } = assignHeroIds(candidates, registry, { mentions: options.mentions });
    const characters = assignments.map((a) => {
        const copy = { ...a.candidate, id: a.id };
        if (a.name) copy.name = a.name;
        delete copy.alias;
        if (a.aliases.length > 0) copy.aliases = a.aliases; else delete copy.aliases;
        return copy;
    });
    return {
        characters,
        idMap,
        assignments,
        merges: assignments.filter((a) => a.existing).map((a) => ({
            from: a.rawId || null, name: a.name || null, to: a.id, reason: a.reason, evidence: a.evidence || [],
        })),
        skipped: skipped.map((s) => ({ id: s.rawId || null, name: text(s.candidate.name) || null, reason: s.reason })),
        possible_duplicates: (possibleDuplicates || []).map((p) => ({
            from: p.rawId || null, name: p.name || null, id: p.id, of: p.of, evidence: p.evidence || [],
        })),
    };
}

/** Replace ids the model wrote with the final ones (strings that are not in the map stay). */
function remapId(value, idMap) {
    return typeof value === 'string' && idMap && idMap.has(value) ? idMap.get(value) : value;
}

/** { alias: target } with targets remapped to final ids. */
function remapMentions(mentions, idMap) {
    if (!isPlainObject(mentions)) return {};
    const out = {};
    for (const [alias, target] of Object.entries(mentions)) out[alias] = remapId(String(target), idMap);
    return out;
}

/**
 * Aliases that may be ADDED to heroes from the mentions of a window (§7).
 * Not added: a mention whose target is not a hero; an alias equal (after
 * normalizeForMatch) to the hero's own name or an alias it already has; an
 * alias that belongs — as a name or an alias — to ANOTHER hero, or that two
 * heroes of this window claim: writing it would make it ambiguous.
 *
 * @param {object[]} heroes   every hero that will exist after this window ({ id, name, aliases })
 * @param {object} mentions   { alias: hero id }
 * @returns {{ additions: Map<string, string[]>, rejected: {alias: string, target: string, reason: string}[] }}
 */
function aliasAdditions(heroes, mentions) {
    const list = (Array.isArray(heroes) ? heroes : []).filter((h) => isPlainObject(h) && typeof h.id === 'string');
    const byId = new Map(list.map((h) => [h.id, h]));
    const owners = new Map(); // key → Set<hero id> (names and aliases already there)
    const claim = (value, id) => {
        const key = matchKey(value);
        if (!key) return;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(id);
    };
    for (const h of list) {
        claim(h.name, h.id);
        for (const a of Array.isArray(h.aliases) ? h.aliases : []) claim(a, h.id);
    }

    // the same alias for two heroes inside one window → for nobody
    const wanted = new Map(); // key → Set<target>
    const entries = isPlainObject(mentions) ? Object.entries(mentions) : [];
    for (const [alias, target] of entries) {
        if (!byId.has(target)) continue;
        const key = matchKey(alias);
        if (!key) continue;
        if (!wanted.has(key)) wanted.set(key, new Set());
        wanted.get(key).add(target);
    }

    const additions = new Map();
    const rejected = [];
    for (const [alias, target] of entries) {
        const spelling = text(alias);
        const key = matchKey(spelling);
        if (!spelling || !key) continue;
        if (!byId.has(target)) { rejected.push({ alias: spelling, target: String(target), reason: 'not_a_hero' }); continue; }
        const current = owners.get(key);
        if (current && current.has(target)) continue; // already the hero's name or alias
        if ((current && current.size > 0) || wanted.get(key).size > 1) {
            rejected.push({ alias: spelling, target, reason: 'ambiguous_alias' });
            continue;
        }
        if (!additions.has(target)) additions.set(target, []);
        additions.get(target).push(spelling);
        claim(spelling, target);
    }
    return { additions, rejected };
}

/**
 * What a later window may add to a hero that already exists. Returns the SAME
 * object when nothing changes, so the caller can skip the write.
 *
 * @param {object} hero  the hero file as it is
 * @param {{ aliases?: string[], voice?: {timbre, manner, timbre_source}|null,
 *           passport?: {appearance, clothes, video_tokens}|null }} addition
 */
function mergeWindowIntoHero(hero, addition = {}) {
    let next = hero;
    const change = (patch) => { next = { ...next, ...patch }; };

    // aliases: only new spellings
    if (Array.isArray(addition.aliases) && addition.aliases.length > 0) {
        const merged = mergeAliases(hero.name, hero.aliases, addition.aliases);
        const before = Array.isArray(hero.aliases) ? hero.aliases : [];
        if (merged.length !== before.length) change({ aliases: merged });
    }

    // passport: only when the hero has none (a voice-only hero that the text now describes)
    if (isPlainObject(addition.passport) && !isPlainObject(hero.passport)) {
        change({ passport: addition.passport });
    }

    // voice: a missing voice is added; a missing timbre / manner is filled.
    // A voice edited by a person or carrying a locked reference is never touched.
    const proposed = isPlainObject(addition.voice) ? addition.voice : null;
    if (proposed && text(proposed.timbre)) {
        if (!isPlainObject(hero.voice)) {
            change({ voice: { ...proposed } });
        } else if (!isVoiceProtected(hero.voice)) {
            const voice = { ...hero.voice };
            let touched = false;
            if (!text(voice.timbre)) {
                voice.timbre = proposed.timbre;
                if (proposed.timbre_source) voice.timbre_source = proposed.timbre_source;
                touched = true;
            }
            if (!text(voice.manner) && text(proposed.manner)) { voice.manner = proposed.manner; touched = true; }
            if (touched) change({ voice });
        }
    }
    return next;
}

module.exports = {
    workingCharacterFromHero,
    registryFromBook,
    mentionsFromBook,
    normalizeWindowCharacters,
    remapId,
    remapMentions,
    aliasAdditions,
    mergeWindowIntoHero,
    isValidHeroId,
};
