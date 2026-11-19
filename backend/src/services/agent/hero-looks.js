// ======================================================
// hero-looks — how a character looks in a scene, during the analysis
// ======================================================
// The passport-reconciliation step (stage 2 of the video_tokens scheme) reads
// the tokens a participant CURRENTLY has in a scene and writes new ones only
// where they differ. Both go through the one resolver of VBook 4 —
// resolveHeroLook (@animastor/vbook-runtime, VBOOK_FORMAT_V4 §4a.5):
//
//   current tokens = base passport ← chapter look ← scene look ← scene.look_patch
//   written to     = scene.look_patch[hero_id].video_tokens  (never scene.passport,
//                    which VBook 4 does not have)
//
// The analysis works on its own character list (plain objects); workingBook()
// presents that list as a v4 book for the resolver. The chapter of a window
// that is still being analysed is not known here — a chapter look, when one is
// assigned, is taken into account once more at the write barrier
// (lazy-book/create.js drops a look_patch equal to the resolved look).

'use strict';

const { resolveHeroLook } = require('@animastor/vbook-runtime/looks.cjs');
const { sanitizeVideoTokens } = require('@animastor/vbook-runtime/lazy-book/appearance');

const str = (v) => (typeof v === 'string' ? v : '');

function tokenList(value) {
    // a working character of an older window may still carry tokens as one
    // comma-separated string
    const list = typeof value === 'string' ? value.split(',') : value;
    const cleaned = sanitizeVideoTokens(list);
    return Array.isArray(cleaned) ? cleaned : [];
}

/** One working character as the hero the resolver expects. */
function heroView(c) {
    const p = c && c.passport && typeof c.passport === 'object' ? c.passport : {};
    return {
        id: c.id,
        looks: Array.isArray(c.looks) ? c.looks : undefined,
        passport: {
            appearance: str(p.appearance) || str(c.appearance),
            clothes: str(p.clothes) || str(c.clothes),
            video_tokens: tokenList(p.video_tokens !== undefined && p.video_tokens !== null ? p.video_tokens : c.video_tokens),
        },
    };
}

/** The working character list as a book for resolveHeroLook. */
function workingBook(characters) {
    return { heroes: (characters || []).filter((c) => c && typeof c.id === 'string').map(heroView) };
}

/**
 * A scene that came out of an older analysis (cached in PG) may still carry
 * `passport` — the pre-v4 name of look_patch. It is read as look_patch and
 * removed, so nothing downstream sees scene.passport.
 */
function adoptLegacyScenePassport(scene) {
    if (!scene || typeof scene !== 'object' || scene.passport === undefined) return scene;
    if (!scene.look_patch && scene.passport && typeof scene.passport === 'object' && !Array.isArray(scene.passport)) {
        scene.look_patch = scene.passport;
    }
    delete scene.passport;
    return scene;
}

/**
 * The look a participant has in a scene right now.
 * @returns {null|object} the resolveHeroLook result (null: not a hero with a passport)
 */
function resolveSceneLook(book, scene, heroId, chapter = null) {
    return resolveHeroLook(book, chapter, adoptLegacyScenePassport(scene), heroId);
}

/** Effective video tokens of a participant in a scene (array, possibly empty). */
function currentSceneTokens(book, scene, heroId, chapter = null) {
    const look = resolveSceneLook(book, scene, heroId, chapter);
    return look ? look.video_tokens : [];
}

function sameTokens(a, b) {
    return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Write the tokens the reconciliation agent chose for one scene.
 * Only participants of the scene, only heroes with a passport, and only when
 * the tokens DIFFER from what the hero already has there.
 * @returns {string[]} ids whose look_patch was written
 */
function applyReconciledTokens(book, scene, tokensByHero, chapter = null) {
    adoptLegacyScenePassport(scene);
    const participants = Array.isArray(scene.participants) ? scene.participants : [];
    const written = [];
    for (const [heroId, raw] of Object.entries(tokensByHero || {})) {
        // Guard: only participants of THIS scene get overrides — a hallucinated
        // token for a non-participant would otherwise win at render time.
        if (!participants.includes(heroId)) continue;
        const look = resolveSceneLook(book, scene, heroId, chapter);
        if (!look) continue;
        const tokens = tokenList(raw);
        if (tokens.length === 0 || sameTokens(tokens, look.video_tokens)) continue;
        const patch = scene.look_patch && typeof scene.look_patch === 'object' ? scene.look_patch : {};
        scene.look_patch = { ...patch, [heroId]: { ...(patch[heroId] || {}), video_tokens: tokens } };
        written.push(heroId);
    }
    return written;
}

module.exports = {
    workingBook,
    heroView,
    adoptLegacyScenePassport,
    resolveSceneLook,
    currentSceneTokens,
    applyReconciledTokens,
};
