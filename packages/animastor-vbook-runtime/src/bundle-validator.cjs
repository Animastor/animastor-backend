// ======================================================
// ANIMASTOR BACKEND — BUNDLE VALIDATOR (VBook 4)
// ======================================================
// Canonical data-contract guard for the book bundle.
// Runs AFTER AI patch application and BEFORE any disk write,
// so a structurally broken mutation (e.g. a value of the wrong
// type that Android's strict parser cannot load) is rejected
// instead of becoming the new canonical state.
//
// Contract (architecture/VBOOK_FORMAT_V4.md §3, §8.1) — the in-memory book:
//   manifest    — object with book_id (required)
//   book        — object with structure.chapters_order / characters_order
//   bible       — object (optional)
//   locations   — object keyed by location id
//   behaviour   — behaviour.json: animastor.behaviour-globals/1 (§6.3)
//   heroes      — array of hero files, animastor.character/1 (§4); ids unique
//   hero_issues — array (memory / API only, never written)
//   chapters    — objects with canonical chapter_id; chapter.looks,
//                 scene.looks, scene.look_patch (§4a)
// The 3.1 maps characters / voices / behaviors / mentions do not exist: a book
// object that still carries one is refused, so data is never dropped silently.
//
// The hero-file and behaviour.json validators live in ./character-validator.cjs
// and are re-exported here (validateCharacterFile, validateBehaviourGlobals).
// The JSON Schemas are schemas/character-1.schema.json (normative copy from
// animastor-docs) and schemas/vbook-bundle-4.schema.json.
'use strict';

const {
    validateCharacterFile, validateBehaviourGlobals,
} = require('./character-validator.cjs');
const { CANONICAL_ID_RE } = require('./heroes.cjs');

const CHAPTER_ID_RE = /^ch-[a-f0-9]{6,}$/;
const SCENE_ID_RE = /^sc-[a-f0-9]{6,}$/;
const UNIT_ID_RE = /^iu-[a-f0-9]{6,}$/;

function collectSceneUnits(scene) {
    const units = [];
    if (!scene || typeof scene !== 'object') return units;
    for (const value of Object.values(scene)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object' && typeof item.id === 'string' && UNIT_ID_RE.test(item.id)) {
                    units.push(item);
                }
            }
        }
    }
    return units;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Strict: NaN / Infinity cannot round-trip to valid JSON.
function assertSerializable(value, label, errors) {
    const seen = new WeakSet();
    const walk = (v, path) => {
        if (typeof v === 'number' && (!Number.isFinite(v) || Number.isNaN(v))) {
            errors.push(`${label}: non-serializable number ${String(v)} at "${path}"`);
            return;
        }
        if (v !== null && typeof v === 'object') {
            if (seen.has(v)) return; // circular refs are caught by stringify below
            seen.add(v);
            if (Array.isArray(v)) {
                v.forEach((item, i) => walk(item, `${path}[${i}]`));
            } else {
                for (const [k, item] of Object.entries(v)) walk(item, `${path}/${k}`);
            }
        }
    };
    walk(value, '');
    try {
        JSON.stringify(value);
    } catch (e) {
        errors.push(`${label}: not JSON-serializable (${e.message})`);
    }
}

function validateManifest(manifest, errors) {
    if (!isPlainObject(manifest)) {
        errors.push('manifest: must be a JSON object');
        return;
    }
    if (!manifest.book_id || typeof manifest.book_id !== 'string') {
        errors.push('manifest: book_id missing or not a string');
    }
}

function validateBookMeta(bookMeta, errors) {
    // Absent metadata is tolerated (lazy/draft flows); a wrong TYPE is not.
    if (bookMeta === undefined || bookMeta === null) return;
    if (!isPlainObject(bookMeta)) {
        errors.push('book: must be a JSON object');
        return;
    }
    const structure = bookMeta.structure;
    if (structure === undefined || structure === null) return;
    if (!isPlainObject(structure)) {
        errors.push('book: structure must be a JSON object');
        return;
    }
    const order = structure.chapters_order;
    if (order === undefined || order === null) return;
    if (!Array.isArray(order) || order.some(f => typeof f !== 'string')) {
        errors.push('book: structure.chapters_order must be an array of filenames');
    }
}

function validateLocations(locations, errors) {
    if (!isPlainObject(locations)) {
        errors.push(`locations: must be a JSON object keyed by location id (got ${Array.isArray(locations) ? 'array' : typeof locations})`);
    }
}

const REMOVED_KEYS = Object.freeze(['characters', 'voices', 'behaviors', 'mentions']);
const LOOK_ID_MAX = 64;
const LOOK_PATCH_KEYS = Object.freeze(['appearance', 'clothes', 'video_tokens']);

function formatIssue(prefix, issue) {
    return `${prefix}${issue.path ? `.${issue.path}` : ''}: ${issue.message}`;
}

function validateBehaviour(behaviour, errors) {
    const check = validateBehaviourGlobals(behaviour);
    for (const e of check.errors) errors.push(formatIssue('behaviour', e));
}

function validateHeroes(heroes, errors) {
    if (!Array.isArray(heroes)) {
        errors.push(`heroes: must be a JSON array (got ${heroes === null ? 'null' : typeof heroes})`);
        return;
    }
    const seen = new Set();
    heroes.forEach((hero, i) => {
        const id = isPlainObject(hero) && typeof hero.id === 'string' ? hero.id : null;
        const label = id ? `heroes[${i}] (${id})` : `heroes[${i}]`;
        const check = validateCharacterFile(hero);
        for (const e of check.errors) errors.push(formatIssue(label, e));
        if (id === null) return;
        if (seen.has(id)) errors.push(`${label}: duplicate hero id "${id}"`);
        seen.add(id);
    });
}

// chapter.looks / scene.looks: { <hero_id>: <look_id> } (§4a.3).
function validateLookAssignments(map, label, errors) {
    if (map === undefined) return;
    if (!isPlainObject(map)) {
        errors.push(`${label}: looks must be an object of hero id → look id`);
        return;
    }
    for (const [heroId, lookId] of Object.entries(map)) {
        if (typeof lookId !== 'string' || !CANONICAL_ID_RE.test(lookId) || [...lookId].length > LOOK_ID_MAX) {
            errors.push(`${label}/looks/${heroId}: must be a look id`);
        }
    }
}

// scene.look_patch: { <hero_id>: { appearance?, clothes?, video_tokens? } } (§4a.4).
function validateLookPatch(map, label, errors) {
    if (map === undefined) return;
    if (!isPlainObject(map)) {
        errors.push(`${label}: look_patch must be an object of hero id → fields`);
        return;
    }
    for (const [heroId, patch] of Object.entries(map)) {
        const p = `${label}/look_patch/${heroId}`;
        if (!isPlainObject(patch)) {
            errors.push(`${p}: must be an object`);
            continue;
        }
        for (const key of Object.keys(patch)) {
            if (!LOOK_PATCH_KEYS.includes(key)) errors.push(`${p}/${key}: unexpected key (allowed: ${LOOK_PATCH_KEYS.join(', ')})`);
        }
        for (const key of ['appearance', 'clothes']) {
            if (key in patch && (typeof patch[key] !== 'string' || patch[key].length < 1)) {
                errors.push(`${p}/${key}: must be a non-empty string`);
            }
        }
        if ('video_tokens' in patch) {
            const tokens = patch.video_tokens;
            if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 4
                || tokens.some((t) => typeof t !== 'string' || t.length < 1)) {
                errors.push(`${p}/video_tokens: must be an array of 1–4 non-empty strings`);
            }
        }
    }
}

function validateChapters(chapters, errors) {
    if (chapters == null) return;
    if (!Array.isArray(chapters)) {
        errors.push(`chapters: must be an array (got ${typeof chapters})`);
        return;
    }
    chapters.forEach((chapter, ci) => {
        const label = `chapters[${ci}]`;
        if (!isPlainObject(chapter)) {
            errors.push(`${label}: must be an object`);
            return;
        }
        const cid = chapter.chapter_id;
        if (typeof cid === 'string' && !CHAPTER_ID_RE.test(cid)) {
            errors.push(`${label}: invalid chapter_id "${cid}" (expected: ch-XXXXXXXX)`);
        }
        validateLookAssignments(chapter.looks, label, errors);
        if (chapter.scenes !== undefined && !Array.isArray(chapter.scenes)) {
            errors.push(`${label}: scenes must be an array`);
            return;
        }
        (chapter.scenes || []).forEach((scene, si) => {
            const sceneLabel = `${label}/scenes[${si}]`;
            if (!isPlainObject(scene)) {
                errors.push(`${sceneLabel}: must be an object`);
                return;
            }
            validateLookAssignments(scene.looks, sceneLabel, errors);
            validateLookPatch(scene.look_patch, sceneLabel, errors);
            const sid = scene.scene_id;
            if (typeof sid === 'string' && !SCENE_ID_RE.test(sid)) {
                errors.push(`${sceneLabel}: invalid scene_id "${sid}" (expected: sc-XXXXXXXX)`);
            }
            // participants must be an array of character_id strings — never a
            // display name, never a bare string, never a wrapped object
            // ({"item": [...]} — a model hallucination that previously slipped
            // through and corrupted the book's canonical state).
            const participants = scene.participants;
            if (participants !== undefined && participants !== null) {
                if (!Array.isArray(participants)) {
                    errors.push(`${sceneLabel}: participants must be an array of character_id strings (got ${Array.isArray(participants) ? 'array' : typeof participants})`);
                } else {
                    participants.forEach((p, pi) => {
                        if (typeof p !== 'string' || !p.trim()) {
                            errors.push(`${sceneLabel}/participants[${pi}]: must be a non-empty character_id string`);
                        }
                    });
                }
            }
            for (const unit of collectSceneUnits(scene)) {
                if (!UNIT_ID_RE.test(unit.id)) {
                    errors.push(`${sceneLabel}: invalid unit id "${unit.id}" (expected: iu-XXXXXXXX)`);
                }
            }
        });
    });
}

/**
 * Validate a book object (in-memory, post-patch) against the bundle contract.
 * @param {Object} book - {manifest, book, bible, locations, behaviour, heroes, hero_issues, chapters}
 * @returns {{valid: boolean, errors: string[]}} errors are empty when valid
 */
function validateBundleObject(book) {
    const errors = [];
    if (!isPlainObject(book)) {
        return { valid: false, errors: ['book data: must be a JSON object'] };
    }
    // Serializability first — the whole point is to never write JSON
    // that cannot be parsed back.
    assertSerializable(book, 'book data', errors);
    validateManifest(book.manifest, errors);
    validateBookMeta(book.book, errors);
    if (book.bible !== undefined && book.bible !== null && !isPlainObject(book.bible)) {
        errors.push('bible: must be a JSON object');
    }
    validateLocations(book.locations, errors);
    validateBehaviour(book.behaviour, errors);
    validateHeroes(book.heroes, errors);
    if (book.hero_issues !== undefined && !Array.isArray(book.hero_issues)) {
        errors.push('hero_issues: must be an array');
    }
    for (const key of REMOVED_KEYS) {
        if (key in book) errors.push(`${key}: not part of VBook 4 (heroes live in book.heroes, see VBOOK_FORMAT_V4 §8.1)`);
    }
    validateChapters(book.chapters, errors);
    return { valid: errors.length === 0, errors };
}

/**
 * Lightweight per-chapter-file check: only validates scene.participants
 * structural shape. Unlike validateChapters (used by validateBundleObject),
 * this does NOT check chapter_id / scene_id regex format — those are
 * enforced by the full-book path and per-file checks would break existing
 * fixtures that use short test IDs like "ch-aaa", "sc-111".
 */
function validateSceneParticipantsOnly(chapter, errors) {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return;
    const label = 'chapter (per-file)';
    validateLookAssignments(chapter.looks, label, errors);
    (Array.isArray(chapter.scenes) ? chapter.scenes : []).forEach((scene, si) => {
        if (!isPlainObject(scene)) return;
        validateLookAssignments(scene.looks, `${label}/scenes[${si}]`, errors);
        validateLookPatch(scene.look_patch, `${label}/scenes[${si}]`, errors);
        const participants = scene.participants;
        if (participants === undefined || participants === null) return;
        if (!Array.isArray(participants)) {
            errors.push(`${label}/scenes[${si}]: participants must be an array of character_id strings (got ${Array.isArray(participants) ? 'array' : typeof participants})`);
        } else {
            participants.forEach((p, pi) => {
                if (typeof p !== 'string' || !p.trim()) {
                    errors.push(`${label}/scenes[${si}]/participants[${pi}]: must be a non-empty character_id string`);
                }
            });
        }
    });
}

/**
 * Validate one resource value before it is written to a bundle JSON file.
 * Used by saveBookBundle as a last line of defense right before writeFileSync.
 * @param {string} filename - target path inside the book (e.g. 'behaviour.json',
 *        'characters/yura.json', 'chapter.json')
 * @param {*} data - value to be serialized
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateBundleFile(filename, data) {
    const errors = [];
    assertSerializable(data, filename, errors);
    if (data !== null && typeof data !== 'object' && filename.endsWith('.json')) {
        errors.push(`${filename}: bundle JSON files must contain a JSON object or array`);
        return { valid: false, errors };
    }
    const name = filename.toLowerCase();
    if (name === 'locations.json') validateLocations(data, errors);
    else if (name === 'behaviour.json') validateBehaviour(data, errors);
    else if (name.startsWith('characters/')) {
        const check = validateCharacterFile(data, { filename: filename.slice('characters/'.length) });
        for (const e of check.errors) errors.push(formatIssue(filename, e));
    }
    else if (['voices.json', 'characters.json', 'behavior.json', 'mentions.json'].includes(name)) {
        errors.push(`${filename}: not a VBook 4 file`);
    }
    else if (name === 'bible.json') {
        if (data !== null && !isPlainObject(data)) errors.push('bible.json: must be a JSON object');
    }
    else if (name === 'chapter.json' || name.startsWith('ch-')) {
        validateSceneParticipantsOnly(data, errors);
    }
    return { valid: errors.length === 0, errors };
}

module.exports = {
    validateBundleObject,
    validateBundleFile,
    validateCharacterFile,
    validateBehaviourGlobals,
};
