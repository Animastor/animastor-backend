// ======================================================
// Placeholder Audio Marker
// ======================================================
// A silent placeholder is a *valid MP3 file*. Nothing in the bytes says
// "this is silence, not speech", and `file exists + duration > 0` is
// therefore not evidence of real audio. On 2026-11-04 (BA book,
// ch-5e5a8c76/sc-4bb85e02) exactly that assumption promoted a 10.85 s silent
// placeholder to `scene_assets.status = 'ready'` and then answered every
// "audio" command with `already_ready` / `already_done` — no GPU job, silence
// in the player.
//
// The marker is a sidecar written by the ONLY producer of silence
// (`audio/silence.js` → generateSilentAudio) and checked everywhere readiness
// is decided. It survives PG/Redis drift, which is precisely the failure
// mode: the DB record was stale, the file was not.
//
// Invariants
//   - a marked file is NEVER "real audio", never `ready`, never `already_ready`;
//   - a fenced GPU commit writes the canonical chunk; the merge then replaces
//     the canonical file, so the marker is cleared at publication time;
//   - absence of a marker is not proof of real audio either — readiness still
//     requires a committed chunk of the current generation
//     (`validation.isSceneAudioCommitted`).
// ======================================================

const fs = require('fs');
const path = require('path');

const MARKER_SUFFIX = '.placeholder.json';
const MARKER_KIND = 'animastor-placeholder';

function placeholderMarkerPath(audioPath) {
    return `${audioPath}${MARKER_SUFFIX}`;
}

/**
 * Write the "this file is silence" sidecar next to a placeholder audio file.
 * Never throws: a failed marker write must not break placeholder creation
 * (the readiness check independently requires a committed chunk).
 *
 * @param {string} audioPath
 * @param {{durationSec?:number, reason?:string, bookId?:string, chapterId?:string, sceneId?:string}} info
 * @returns {object|null} the marker record, or null on a write failure
 */
function writePlaceholderMarker(audioPath, info = {}) {
    if (!audioPath) return null;
    const record = {
        kind: MARKER_KIND,
        real: false,
        silent: true,
        duration_sec: Number(info.durationSec) || 0,
        reason: info.reason || 'silent-placeholder',
        book_id: info.bookId || null,
        chapter_id: info.chapterId || null,
        scene_id: info.sceneId || null,
        created_at: Date.now(),
    };
    try {
        fs.mkdirSync(path.dirname(audioPath), { recursive: true });
        fs.writeFileSync(placeholderMarkerPath(audioPath), JSON.stringify(record));
        return record;
    } catch (_) {
        return null;
    }
}

/**
 * @param {string} audioPath
 * @returns {boolean} true when the file is (or was last written as) a placeholder
 */
function isPlaceholderAudioFile(audioPath) {
    if (!audioPath) return false;
    try {
        return fs.existsSync(placeholderMarkerPath(audioPath));
    } catch (_) {
        return false;
    }
}

/**
 * @param {string} audioPath
 * @returns {object|null}
 */
function readPlaceholderMarker(audioPath) {
    try {
        const raw = fs.readFileSync(placeholderMarkerPath(audioPath), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && parsed.kind === MARKER_KIND ? parsed : null;
    } catch (_) {
        return null;
    }
}

/**
 * Clear the marker when real (fenced-committed) audio replaces the file.
 * @param {string} audioPath
 * @returns {boolean} true when a marker was removed
 */
function clearPlaceholderMarker(audioPath) {
    if (!audioPath) return false;
    try {
        fs.unlinkSync(placeholderMarkerPath(audioPath));
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    MARKER_SUFFIX,
    MARKER_KIND,
    placeholderMarkerPath,
    writePlaceholderMarker,
    isPlaceholderAudioFile,
    readPlaceholderMarker,
    clearPlaceholderMarker,
};
