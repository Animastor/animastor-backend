// ======================================================
// Audio Validation
// ======================================================

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
// A silent placeholder is a valid MP3 — the sidecar is the only proof that a
// file is NOT real audio (2026-11-04, sc-4bb85e02).
const { isPlaceholderAudioFile } = require('./placeholder-marker');

async function validateCanonicalAudio(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        helpers.warn(`validateCanonicalAudio: invalid path`);
        return false;
    }

    if (!fs.existsSync(filePath)) {
        helpers.warn(`validateCanonicalAudio: file does not exist: ${filePath}`);
        return false;
    }

    // Placeholder first: silence has a valid MP3 header and a positive
    // duration, so every byte-level check below would pass it.
    if (isPlaceholderAudioFile(filePath)) {
        helpers.warn(`validateCanonicalAudio: placeholder (silence) file is not real audio: ${filePath}`);
        return false;
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 1024) {
        helpers.warn(`validateCanonicalAudio: file too small: ${filePath} (${stats.size} bytes)`);
        return false;
    }

    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(filePath);
        const duration = metadata.format.duration || 0;

        if (duration <= 0) {
            helpers.warn(`validateCanonicalAudio: invalid duration: ${filePath} (${duration}s)`);
            return false;
        }

        if (duration > 7200) {
            helpers.warn(`validateCanonicalAudio: suspiciously long duration: ${filePath} (${duration}s)`);
            return false;
        }

        return true;
    } catch (err) {
        helpers.warn(`validateCanonicalAudio: parse error: ${filePath} ${err.message}`);
        return false;
    }
}

async function isSceneAudioReady(buildId, bookId, chapterId, sceneId) {
    const audioPath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, chapterId, sceneId));

    if (!fs.existsSync(audioPath)) {
        return false;
    }

    return await validateCanonicalAudio(audioPath);
}

/**
 * Is this scene's audio the result of a REAL, FENCED GPU commit of the
 * current generation?
 *
 * Proven defect (2026-11-04, ba_1788172242081/ch-5e5a8c76/sc-4bb85e02):
 * `isSceneAudioReady` only asked "does the canonical file exist and parse".
 * A 10.85 s silent placeholder answered yes, so the scene went READY with
 * `worker_id = NULL`, no GPU job, and every later "audio" command was
 * skipped as already_ready / already_done.
 *
 * Evidence required here:
 *   1. the canonical file exists, parses, and is NOT a marked placeholder;
 *   2. the scene's chunks exist on disk — the fenced commit writes the chunk
 *      artifact (staged → canonical). A placeholder never has chunks;
 *   3. when `expectedChunkCount` is known, every expected chunk is present.
 *
 * Missing chunk evidence is NOT "legacy audio": it is "no GPU result". The
 * caller regenerates instead of trusting the file.
 *
 * @param {string} buildId
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {number|null} [expectedChunkCount]
 * @returns {Promise<{ready:boolean, reason:string, path:string|null, chunks:number[], expected?:number, missing?:number[]}>}
 */
async function isSceneAudioCommitted(buildId, bookId, chapterId, sceneId, expectedChunkCount = null) {
    const audioPath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, chapterId, sceneId));
    const out = { ready: false, reason: '', path: audioPath, chunks: [] };

    if (isPlaceholderAudioFile(audioPath)) {
        out.reason = 'placeholder_marker';
        return out;
    }
    if (!fs.existsSync(audioPath)) {
        out.reason = 'no_canonical';
        return out;
    }
    if (!(await validateCanonicalAudio(audioPath))) {
        out.reason = 'canonical_invalid';
        return out;
    }

    const indices = sceneChunkIndices(buildId, bookId, chapterId, sceneId, expectedChunkCount);
    const expected = Number(expectedChunkCount) > 0 ? Number(expectedChunkCount) : null;
    if (expected) out.expected = expected;
    if (indices.length === 0) {
        out.reason = 'no_committed_chunks';
        return out;
    }

    const missing = [];
    const present = [];
    for (const i of indices) {
        const chunkPath = helpers.getOutputPath(
            buildId,
            artifactNaming.sceneChunkAudioName(bookId, chapterId, sceneId, i)
        );
        let size = 0;
        try { size = fs.statSync(chunkPath).size; } catch (_) { size = 0; }
        if (size > 0) present.push(i);
        else missing.push(i);
    }
    out.chunks = present;
    if (present.length === 0) {
        out.reason = 'no_committed_chunks';
        out.missing = missing;
        return out;
    }
    if (missing.length > 0) {
        out.reason = 'missing_chunks';
        out.missing = missing;
        return out;
    }
    if (expected && present.length < expected) {
        out.reason = 'incomplete_chunks';
        out.missing = missing;
        return out;
    }

    out.ready = true;
    out.reason = 'committed';
    return out;
}

/**
 * Chunk indices of a scene that exist on disk. With a known expected count
 * the indices are enumerated deterministically (1..N); otherwise the build
 * directory is readdir-scanned for this scene's chunk files.
 */
function sceneChunkIndices(buildId, bookId, chapterId, sceneId, expectedChunkCount) {
    const expected = Number(expectedChunkCount);
    if (Number.isFinite(expected) && expected > 0) {
        const indices = [];
        for (let i = 1; i <= expected; i++) indices.push(i);
        return indices;
    }
    const dir = helpers.getOutputPath(buildId);
    try {
        if (!fs.existsSync(dir)) return [];
        const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${esc(bookId)}_${esc(chapterId)}_${esc(sceneId)}_(\\d+)\\.mp3$`);
        return fs.readdirSync(dir)
            .filter((f) => re.test(f))
            .map((f) => parseInt(f.match(re)[1], 10))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => a - b);
    } catch (_) {
        return [];
    }
}

async function getAudioDuration(filePath) {
    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(filePath);
        return metadata.format.duration || 0;
    } catch (err) {
        return 0;
    }
}

module.exports = {
    validateCanonicalAudio,
    isSceneAudioReady,
    isSceneAudioCommitted,
    getAudioDuration,
};
