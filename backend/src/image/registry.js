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
            helpers.log(`CANONICAL IU IMAGE: ${iuImages[0]}`);
            return iuImages[0];
        }
    } catch (err) {
        helpers.error(`Error scanning IU images for scene: ${bookId}/${chapterId}/${sceneId}`, err.message);
    }
    return null;
}

/**
 * Stage 143a — resolve the PUBLISHED versioned image of one IU.
 *
 * Three-way verdict (Phase 2a) instead of a single `null`, so a caller can
 * tell "nothing was ever published here" apart from "the publication is
 * broken" — the second one must NEVER silently fall back to legacy bytes:
 *
 *   null                          flag OFF → legacy callers keep today's
 *                                 contract and NO PostgreSQL call is made
 *   {status:'ok', ...}             pointer row + a safely resolved file that
 *                                 exists on disk (path, fence, relativePath)
 *   {status:'absent'}              no pointer row for this key → the caller
 *                                 may fall back to the legacy canonical file
 *   {status:'missing', ...}        pointer row exists but the target is
 *                                 unsafe (traversal/symlink) or absent → the
 *                                 caller must NOT fall back to legacy: the
 *                                 pointer is the authority and it is broken
 *
 * A PG ERROR (as opposed to "no row") THROWS: an outage must never look
 * like "no publication" and silently serve stale canonical bytes.
 *
 * Path resolution still rejects traversal/absolute/symlink escapes
 * (condition 3).
 *
 * @returns {Promise<null
 *                 |{status:'ok', path:string, fence:number, relativePath:string}
 *                 |{status:'absent'}
 *                 |{status:'missing', relativePath:string, reason:string}>}
 */
async function resolveIuImagePath(OUTPUT_DIR, buildId, bookId, chapterId, sceneId, iuId) {
    const pointerRepo = require('../storage/postgres/repositories/iu-image-pointer-repo');
    if (!pointerRepo.versionedEnabled()) return null;

    const row = await pointerRepo.getIuImagePointer({ bookId, chapterId, sceneId, iuId, buildId });
    if (!row) return { status: 'absent' };

    const resolved = pointerRepo.resolveOutputPath(OUTPUT_DIR, row.path);
    if (!resolved.ok) {
        helpers.error(`resolveIuImagePath: rejected pointer path (${resolved.reason}): ${row.path}`);
        return { status: 'missing', relativePath: row.path, reason: resolved.reason };
    }
    if (!fs.existsSync(resolved.path)) {
        helpers.warn(`resolveIuImagePath: pointer target missing on disk: ${row.path}`);
        return { status: 'missing', relativePath: row.path, reason: 'target_missing' };
    }
    return {
        status: 'ok',
        path: resolved.path,
        fence: row.publishFence,
        relativePath: row.path,
    };
}

/**
 * Stage 143a (Phase 2a) — published IU ids of one scene build, for readers
 * that COUNT ready units (the iu-progress counter reset in scene-callbacks).
 * Flag OFF ⇒ [] with zero PG calls; a PG error THROWS (the caller decides
 * whether the count is display-only).
 *
 * @returns {Promise<string[]>}
 */
async function listPublishedIuIdsForScene(buildId, bookId, chapterId, sceneId) {
    const pointerRepo = require('../storage/postgres/repositories/iu-image-pointer-repo');
    if (!pointerRepo.versionedEnabled()) return [];
    return pointerRepo.listPublishedIuIds({ bookId, chapterId, sceneId, buildId });
}

/**
 * Stage 143a — versioned fallback proof for a scene's image stage.
 *
 * Called by the caller ONLY after the legacy canonical scan came back empty:
 * returns the safely resolved path of a published pointer for the scene
 * build (flag OFF ⇒ null immediately, zero PG calls), or null when no
 * pointer/file exists. Path resolution rejects traversal and anything
 * outside OUTPUT_DIR (condition 3).
 */
async function resolveVersionedSceneProof(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const pointerRepo = require('../storage/postgres/repositories/iu-image-pointer-repo');
    if (!pointerRepo.versionedEnabled()) return null;

    const rows = await pointerRepo.listScenePointerPaths({ bookId, chapterId, sceneId, buildId });
    for (const row of rows) {
        const resolved = pointerRepo.resolveOutputPath(OUTPUT_DIR, row.path);
        if (resolved.ok && fs.existsSync(resolved.path)) return resolved.path;
    }
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
