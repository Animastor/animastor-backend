// ======================================================
// IU Image Registry
// ======================================================
// IU image registration, probing, and scene unit collection.

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');
const helpers = require('./helpers');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;

async function saveIURegistry(redis, iuId, buildId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    await redis.set(key, JSON.stringify({ build_id: buildId, iu_id: iuId, ts: Date.now() }), 'EX', 86400);
}

async function getIURegistry(redis, iuId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

function probeIUImage(iuId, buildId, OUTPUT_DIR) {
    const dir = path.join(OUTPUT_DIR, buildId);
    try {
        if (!fs.existsSync(dir)) {
            return { image: false, path: null };
        }
        const imgPath = path.join(dir, `${iuId}.png`);
        if (fs.existsSync(imgPath)) {
            return { image: true, path: imgPath };
        }
        return { image: false, path: null };
    } catch (err) {
        helpers.error(`probeIUImage error: ${err.message}`);
        return { image: false, path: null };
    }
}

// Reconciliation calls this reader on every cycle, so an unconditional log
// printed the same canonical file once a minute per ready scene (audit
// 2026-11-01: 29 lines for 2 scenes in 15 minutes). Emit the line only when
// the selected file actually changes — name, size or mtime — and keep the
// cache bounded so a long-lived process cannot grow it without limit.
const canonicalImageLogged = new Map();
const CANONICAL_IMAGE_LOG_MAX = 5000;

function logCanonicalImageChange(cacheKey, dir, fileName) {
    let fingerprint = fileName;
    try {
        const st = fs.statSync(path.join(dir, fileName));
        fingerprint = `${fileName}:${st.size}:${st.mtimeMs}`;
    } catch (_) { /* stat failure — fall back to the name */ }
    if (canonicalImageLogged.get(cacheKey) === fingerprint) return;
    if (canonicalImageLogged.size >= CANONICAL_IMAGE_LOG_MAX) {
        const oldest = canonicalImageLogged.keys().next().value;
        canonicalImageLogged.delete(oldest);
    }
    canonicalImageLogged.set(cacheKey, fingerprint);
    helpers.log(`CANONICAL IU IMAGE: ${fileName}`);
}

function resolveCanonicalSceneImage(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const dir = path.join(OUTPUT_DIR, buildId);
    const scenePrefix = artifactNaming.iuImagePrefix(bookId, chapterId, sceneId);

    try {
        if (!fs.existsSync(dir)) {
            return null;
        }
        const files = fs.readdirSync(dir);
        const iuImages = files.filter(f => f.startsWith(scenePrefix) && f.endsWith('.png'));
        if (iuImages.length > 0) {
            iuImages.sort();
            logCanonicalImageChange(`${buildId}/${bookId}/${chapterId}/${sceneId}`, dir, iuImages[0]);
            return iuImages[0];
        }
    } catch (err) {
        helpers.error(`Error scanning IU images for scene: ${bookId}/${chapterId}/${sceneId}`, err.message);
    }
    return null;
}

// ── Stage 143a versioned IU images (IU_IMAGE_VERSIONED) — removed ──────────
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the fenced pointer layer
// (PG iu_image_pointers / iu_image_fence_reservations, publisher in the legacy
// task handler) is gone with the legacy orchestration — the flag was never on
// in production and orchestration v2 publishes the canonical IU file only
// (ADR §13 п.9). The three readers keep their flag-OFF contract (no PG call):
// the player (@animastor/player iu-media) and image/preview still call them.

/** @returns {Promise<null>} always null (the flag-OFF contract) */
async function resolveIuImagePath(_OUTPUT_DIR, _buildId, _bookId, _chapterId, _sceneId, _iuId) {
    return null;
}

/** @returns {Promise<string[]>} always [] (the flag-OFF contract) */
async function listPublishedIuIdsForScene(_buildId, _bookId, _chapterId, _sceneId) {
    return [];
}

/** @returns {Promise<null>} always null (the flag-OFF contract) */
async function resolveVersionedSceneProof(_OUTPUT_DIR, _buildId, _bookId, _chapterId, _sceneId) {
    return null;
}

function collectSceneUnits(scenePayload) {
    const result = [];
    if (scenePayload?.units?.length) {
        result.push(...scenePayload.units);
    }
    if (scenePayload?.dialogue_blocks?.length) {
        for (const block of scenePayload.dialogue_blocks) {
            if (block?.units?.length) {
                result.push(...block.units);
            }
        }
    }
    return result;
}

module.exports = {
    saveIURegistry,
    getIURegistry,
    probeIUImage,
    resolveCanonicalSceneImage,
    resolveIuImagePath,
    resolveVersionedSceneProof,
    listPublishedIuIdsForScene,
    collectSceneUnits,
};
