// ======================================================
// looks — the ONE hero-look resolver (VBOOK_FORMAT_V4 §4a.5)
// ======================================================
// A hero's appearance in a scene is resolved from three places, in this order:
//   1. scene.looks[hero_id]    — "base" means the base passport, overriding the chapter
//   2. chapter.looks[hero_id]
//   3. the base passport       — hero.passport
// The chosen look's `fields` REPLACE whole base fields (never concatenated), and
// scene.look_patch[hero_id] replaces fields on top of that for this scene only.
//
// Pure function: the inputs are never mutated. An unknown look id does not break
// the book — the resolver moves on to the next source in order and reports
// `unknown_look` in warnings, so a dangling reference is visible but harmless.
//
// Consumers keep their own non-look logic (placeholder stripping, token
// de-duplication between participants); they only ask this function for the look.

'use strict';

const LOOK_FIELDS = Object.freeze(['appearance', 'clothes', 'video_tokens']);
const BASE_LOOK_ID = 'base';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function tokens(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
        if (typeof item !== 'string') continue;
        const t = item.trim();
        if (t) out.push(t);
    }
    return out;
}

function cloneValue(field, value) {
    return field === 'video_tokens' ? tokens(value) : str(value);
}

function emptyLook() {
    return { appearance: '', clothes: '', video_tokens: [] };
}

function baseLookOf(hero) {
    const passport = hero.passport;
    const base = emptyLook();
    for (const field of LOOK_FIELDS) base[field] = cloneValue(field, passport[field]);
    return base;
}

function findHero(book, heroId) {
    const heroes = book && Array.isArray(book.heroes) ? book.heroes : [];
    return heroes.find((h) => h && typeof h === 'object' && h.id === heroId) || null;
}

function findLook(hero, lookId) {
    const looks = Array.isArray(hero.looks) ? hero.looks : [];
    return looks.find((l) => l && typeof l === 'object' && l.id === lookId) || null;
}

function hasOwn(obj, key) {
    return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function assignment(map, heroId) {
    if (!map || typeof map !== 'object' || !hasOwn(map, heroId)) return null;
    const value = map[heroId];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameField(field, a, b) {
    if (field === 'video_tokens') {
        return a.length === b.length && a.every((x, i) => x === b[i]);
    }
    return a === b;
}

/**
 * Resolve how a hero looks in one scene.
 *
 * @param {object} book      v4 book in memory ({ heroes: [...] })
 * @param {object} chapter   chapter with optional `looks`
 * @param {object} scene     scene with optional `looks` / `look_patch`
 * @param {string} heroId
 * @returns {null|{
 *   hero_id: string, look_id: string, source: 'scene'|'chapter'|'base',
 *   appearance: string, clothes: string, video_tokens: string[],
 *   base: { appearance: string, clothes: string, video_tokens: string[] },
 *   changed: string[], patched: string[],
 *   image_ref: object|null, warnings: string[]
 * }}
 */
function resolveHeroLook(book, chapter, scene, heroId) {
    const hero = findHero(book, heroId);
    if (!hero || !hero.passport || typeof hero.passport !== 'object') return null;

    const base = baseLookOf(hero);
    const warnings = [];

    const candidates = [
        { source: 'scene', lookId: assignment(scene && scene.looks, heroId) },
        { source: 'chapter', lookId: assignment(chapter && chapter.looks, heroId) },
        { source: 'base', lookId: BASE_LOOK_ID },
    ];

    let chosen = null;
    for (const candidate of candidates) {
        if (!candidate.lookId) continue;
        if (candidate.lookId === BASE_LOOK_ID) {
            chosen = { source: 'base', look: null, lookId: BASE_LOOK_ID };
            break;
        }
        const look = findLook(hero, candidate.lookId);
        if (look) {
            chosen = { source: candidate.source, look, lookId: candidate.lookId };
            break;
        }
        warnings.push('unknown_look');
    }
    // Unreachable: the base candidate always terminates the loop.
    if (!chosen) chosen = { source: 'base', look: null, lookId: BASE_LOOK_ID };

    const result = emptyLook();
    for (const field of LOOK_FIELDS) result[field] = base[field];

    if (chosen.look) {
        const fields = chosen.look.fields;
        if (fields && typeof fields === 'object') {
            for (const field of LOOK_FIELDS) {
                if (hasOwn(fields, field)) result[field] = cloneValue(field, fields[field]);
            }
        }
    }

    const patched = [];
    const patch = scene && scene.look_patch && typeof scene.look_patch === 'object'
        ? scene.look_patch[heroId]
        : null;
    if (patch && typeof patch === 'object') {
        for (const field of LOOK_FIELDS) {
            if (!hasOwn(patch, field)) continue;
            result[field] = cloneValue(field, patch[field]);
            patched.push(field);
        }
    }

    const changed = LOOK_FIELDS.filter((field) => !sameField(field, result[field], base[field]));

    return {
        hero_id: heroId,
        look_id: chosen.lookId,
        source: chosen.source,
        appearance: result.appearance,
        clothes: result.clothes,
        video_tokens: result.video_tokens,
        base,
        changed,
        patched,
        image_ref: chosen.look && chosen.look.image_ref != null ? chosen.look.image_ref : null,
        warnings,
    };
}

module.exports = {
    LOOK_FIELDS,
    BASE_LOOK_ID,
    resolveHeroLook,
};
