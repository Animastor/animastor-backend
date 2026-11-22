'use strict';

// ======================================================
// "Nothing to generate" guard for /regenerate
// ======================================================
// A book whose scenes carry no material for the requested layers (a blank
// book right after POST /book/blank, or one whose units were emptied) has
// nothing to voice, draw or animate. Before 2026-11-22 /regenerate accepted
// such a command: the audio dispatch found 0 jobs (no_jobs_generated),
// retried every tick and was finally cancelled — the user only saw "failed"
// (reports/2026-11-22/assistant-edit-bug.md §4). The route now refuses the
// command up front with code `book_has_no_text`.
//
// Material per layer (any scene of the book):
//   audio — a non-blank unit.text / unit.audio.text (scene units and
//           dialogue-block units) or scene.audio.full_text;
//   image — the above, or unit.image.prompt, or a cover chapter/scene;
//   video — the image material, or unit.video.action.

const isText = (v) => typeof v === 'string' && v.trim() !== '';

function unitsOf(sc) {
    const out = Array.isArray(sc.units) ? [...sc.units] : [];
    for (const db of Array.isArray(sc.dialogue_blocks) ? sc.dialogue_blocks : []) {
        if (db && Array.isArray(db.units)) out.push(...db.units);
    }
    return out.filter((u) => u && typeof u === 'object');
}

/**
 * @param {object|null} book loaded bundle ({ chapters: [{ scenes: [...] }] })
 * @returns {{ scenes: number, audio: boolean, image: boolean, video: boolean }}
 *   whether ANY scene has material for each layer
 */
function bookMaterial(book) {
    const out = { scenes: 0, audio: false, image: false, video: false };
    for (const ch of (book && Array.isArray(book.chapters) ? book.chapters : [])) {
        if (!ch || typeof ch !== 'object') continue;
        for (const sc of (Array.isArray(ch.scenes) ? ch.scenes : [])) {
            if (!sc || typeof sc !== 'object') continue;
            out.scenes++;
            const units = unitsOf(sc);
            const text = isText(sc.audio && sc.audio.full_text)
                || units.some((u) => isText(u.text) || isText(u.audio && u.audio.text));
            const cover = ch.type === 'cover' || sc.type === 'cover';
            const prompt = units.some((u) => isText(u.image && u.image.prompt));
            const action = units.some((u) => isText(u.video && u.video.action));
            if (text) out.audio = true;
            if (text || prompt || cover) out.image = true;
            if (text || prompt || cover || action) out.video = true;
        }
    }
    return out;
}

/**
 * Should a /regenerate for `workerTypes` be refused as "nothing to generate"?
 * Only when the book HAS scenes (a scene-less book keeps the historic empty
 * 200) and none of the requested layers has material anywhere.
 * @param {object|null} book
 * @param {string[]} workerTypes requested layers (audio|image|video)
 */
function nothingToGenerate(book, workerTypes) {
    const m = bookMaterial(book);
    if (m.scenes === 0) return false;
    const LAYERS = ['audio', 'image', 'video'];
    const types = (Array.isArray(workerTypes) && workerTypes.length > 0) ? workerTypes : LAYERS;
    // An unknown layer is the route's own 400 (worker_types validation) —
    // this guard never answers for a malformed request.
    if (!types.every((t) => LAYERS.includes(t))) return false;
    return !types.some((t) => m[t] === true);
}

const BOOK_HAS_NO_TEXT = Object.freeze({
    error: 'book_has_no_text',
    code: 'book_has_no_text',
    message: 'The book has no text yet — add text to its scenes, then start the generation.',
});

module.exports = { bookMaterial, nothingToGenerate, BOOK_HAS_NO_TEXT };
