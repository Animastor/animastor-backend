// ======================================================
// ANIMASTOR BACKEND — ENTITY CLEANUP SERVICE
// ======================================================
// Deep cleanup for manually deleted scene / module (unit) entities.
// The caller already saved the JSON (saveBookBundle), so this service
// removes the derived state across the remaining layers:
//
//   PostgreSQL   → scene_assets / image_units / storyboard_elements /
//                  audio_layers / scenes (reuses bookSync.purgeRemovedSceneRows)
//   Redis        → the scene's chunk records + chunk set entries
//   Filesystem   → OUTPUT_DIR/<build> scene audio/chunk/IU/preview/video files
//   (2026-11-28, ORCHESTRATION_V2 этап 4: the legacy runtime legs — dispatch
//    lease / hub cancellation, active index, per-asset / FSM / registry / dedup
//    Redis families — are gone with the legacy orchestration.)
//   Invalidation→ deleted Unit marks the parent scene dirty for regen (reuses
//                  bookSync.reconcileFromDiff + sceneAssetsRepo.bumpSceneVersions)
//
// Reuses existing helpers instead of duplicating their logic:
//   - bookSync.purgeRemovedSceneRows       (PG scene purge)
//   - bookSync.reconcileFromDiff           (PG scene invalidation)
//   - sceneAssetsRepo.bumpSceneVersions    (PG content version bump)
//   - filesystem-store filename helpers    (collision-free FS matching)
//
// SAFETY SEMANTICS (fix pass):
//   - Every step reports ok/error individually. A step failure NEVER fails the
//     already-successful entity delete response, but it is surfaced in the
//     `cleanup` field of the response instead of being swallowed.
//   - On any incomplete purge a marker is recorded in the `animastor:pending-purge`
//     set; a periodic timer of the composition root retries it (retryPendingPurges),
//     giving up after PENDING_PURGE_MAX_ATTEMPTS so a stuck marker cannot loop.
//   - All operations are idempotent (delete-by-key/prefix), so retries are safe.
//   - Filesystem matches use EXACT scene asset names (filesystem-store helpers)
//     plus a `{prefix}_` boundary, so a shorter chapter/scene id can never
//     delete files of a longer sibling id (prefix collision).
// ======================================================

const path = require('path');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const fs = require('fs');
const fsStore = require('../storage/filesystem-store');
// S-2: stage list resolved from media registry
const { listMediaTypes: _mediaTypes } = require('@animastor/generation').mediaRegistry;

const PENDING_PURGE_SET = 'animastor:pending-purge';
const PENDING_PURGE_ATTEMPTS_PREFIX = 'animastor:pending-purge-attempts';
const PENDING_PURGE_MAX_ATTEMPTS = 5;

module.exports = function (redis, config, deps) {
    const storage = deps.storage;
    const bookSync = storage?.bookSync;
    const bookDiff = deps.bookDiff;
    const sceneAssetsRepo = deps.sceneAssetsRepo;
    const bookApi = deps.book;

    const OUTPUT_DIR = (config || {}).OUTPUT_DIR;
    const log = deps.utils?.log || ((...a) => console.log(new Date().toISOString(), ...a));

    const ASSET_EXTENSIONS = ['.mp3', '.png', '.mp4'];

    // ── Step bookkeeping ──────────────────────────────
    function finish(steps, summary) {
        const failed = steps.filter(s => !s.ok);
        return {
            complete: failed.length === 0,
            steps,
            failed_steps: failed.map(s => s.step),
            summary,
        };
    }

    async function guardedStep(steps, name, fn) {
        try {
            await fn();
            steps.push({ step: name, ok: true });
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] step '${name}' failed: ${err.message}`);
            steps.push({ step: name, ok: false, error: err.message });
        }
    }

    // ── Redis scan helpers ────────────────────────────
    async function scanKeys(pattern) {
        const keys = [];
        let cursor = '0';
        do {
            const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== '0');
        return keys;
    }

    // Delete the scene's chunk keys AND remove their ids from the book chunk
    // set in one scan pass (scanning after a separate del would miss them).
    async function deleteSceneChunks(bookId, chapterId, sceneId) {
        const prefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
        let keys;
        try {
            keys = await scanKeys(`${prefix}*`);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] scan failed for ${prefix}*: ${err.message}`);
            return 0;
        }
        if (keys.length === 0) return 0;
        const ids = keys.map(k => k.slice('animastor:chunk:'.length));
        let deleted = 0;
        if (typeof redis.del === 'function') {
            deleted = await redis.del(...keys);
        }
        await redis.srem(`animastor:chunks:${bookId}`, ...ids);
        return typeof deleted === 'number' ? deleted : keys.length;
    }

    // ── Filesystem helpers ────────────────────────────
    function listBuildDirs() {
        if (!OUTPUT_DIR || !fs.existsSync(OUTPUT_DIR)) return [];
        let entries;
        try {
            entries = fs.readdirSync(OUTPUT_DIR);
        } catch {
            return [];
        }
        return entries
            .map(e => path.join(OUTPUT_DIR, e))
            .filter(p => {
                try { return fs.statSync(p).isDirectory(); } catch { return false; }
            });
    }

    // Collision-free scene file matching. Uses the canonical scene audio/video
    // names verbatim (filesystem-store helpers) plus the `{prefix}_` boundary
    // for chunk/IU/preview files — a shorter chapter/scene id (e.g. sc-a vs
    // sc-aX) can never match a longer sibling id because after `{prefix}`
    // the next char must be `_` (or end of the name).
    function deleteSceneFiles(bookId, chapterId, sceneId) {
        const sceneAudio = fsStore.makeSceneAudioFilename(bookId, chapterId, sceneId);
        const sceneVideo = artifactNaming.sceneVideoName(bookId, chapterId, sceneId);
        const chunkPrefix = `${artifactNaming.scenePrefix(bookId, chapterId, sceneId)}_`;
        let deleted = 0;
        for (const buildPath of listBuildDirs()) {
            let files;
            try {
                files = fs.readdirSync(buildPath);
            } catch { continue; }
            for (const f of files) {
                let match = f === sceneAudio || f === sceneVideo;
                if (!match && f.startsWith(chunkPrefix)) {
                    match = ASSET_EXTENSIONS.some(ext => f.endsWith(ext));
                }
                if (!match) continue;
                try {
                    fs.unlinkSync(path.join(buildPath, f));
                    deleted++;
                } catch { /* best-effort */ }
            }
        }
        return deleted;
    }

    // Exact per-unit files: IU image PNG + preview PNG (writer-verified names).
    function deleteUnitFiles(bookId, chapterId, sceneId, unitId) {
        const imageIUId = artifactNaming.iuAssetId(bookId, chapterId, sceneId, unitId);
        const targets = [
            `${imageIUId}.png`,
            fsStore.makePreviewFilename(bookId, chapterId, sceneId, String(unitId).replace(/^iu/, '')),
        ];
        let deleted = 0;
        for (const buildPath of listBuildDirs()) {
            for (const t of targets) {
                const full = path.join(buildPath, t);
                try {
                    if (fs.existsSync(full)) {
                        fs.unlinkSync(full);
                        deleted++;
                    }
                } catch { /* best-effort */ }
            }
        }
        return deleted;
    }

    // ── Pending purge (retry) markers ─────────────────
    async function recordPendingPurge(kind, ...ids) {
        const marker = `${kind}:${ids.join(':')}`;
        try {
            await redis.sadd(PENDING_PURGE_SET, marker);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] failed to record pending purge ${marker}: ${err.message}`);
        }
    }

    // ── Scene purge ───────────────────────────────────
    async function purgeScene(bookId, chapterId, sceneId) {
        const steps = [];
        const summary = { pg: {}, chunks: 0, files_deleted: 0 };

        // 1. PostgreSQL — reuse the shared scene purge.
        await guardedStep(steps, 'pg_purge', async () => {
            if (bookSync && typeof bookSync.purgeRemovedSceneRows === 'function') {
                summary.pg = await bookSync.purgeRemovedSceneRows(bookId, [`${chapterId}::${sceneId}`]);
            }
        });

        // 2. Redis — the scene's chunk records.
        await guardedStep(steps, 'redis_cleanup', async () => {
            summary.chunks += await deleteSceneChunks(bookId, chapterId, sceneId);
        });

        // 3. Filesystem.
        await guardedStep(steps, 'filesystem', async () => {
            summary.files_deleted = deleteSceneFiles(bookId, chapterId, sceneId);
        });

        const result = finish(steps, summary);
        if (!result.complete) await recordPendingPurge('scene', bookId, chapterId, sceneId);
        log(`[ENTITY-CLEANUP] scene ${bookId}/${chapterId}/${sceneId} → ${result.complete ? 'OK' : 'PARTIAL'} ` +
            `(pg=${JSON.stringify(summary.pg)}, chunks=${summary.chunks}, files=${summary.files_deleted})`);
        return result;
    }

    // ── Unit (module) purge ───────────────────────────
    async function purgeUnit(bookId, chapterId, sceneId, unitId, loadedBook) {
        const steps = [];
        const summary = { pg: {}, files_deleted: 0 };
        const imageIUId = artifactNaming.iuAssetId(bookId, chapterId, sceneId, unitId);

        // 1. PostgreSQL — the unit's image_units row + any dirty marker left on
        //    the parent scene row (the removed unit must simply disappear).
        await guardedStep(steps, 'pg_purge', async () => {
            const r1 = await storage.postgres.query(
                `DELETE FROM image_units
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND unit_id = $4`,
                [bookId, chapterId, sceneId, unitId],
            );
            summary.pg.image_units = r1.rowCount || 0;
            const r2 = await storage.postgres.query(
                `UPDATE scenes
                 SET dirty_unit_ids = array_remove(dirty_unit_ids, $4)
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3`,
                [bookId, chapterId, sceneId, unitId],
            );
            summary.pg.scenes_updated = r2.rowCount || 0;
        });

        // 2. Filesystem — IU image + preview PNG.
        await guardedStep(steps, 'filesystem', async () => {
            summary.files_deleted = deleteUnitFiles(bookId, chapterId, sceneId, unitId);
        });

        // 3. Invalidate the parent scene. Removing a unit changes the scene's
        //    text (audio) and its IU composition (image), and video depends on
        //    both — so the scene becomes dirty for audio+image+video, exactly
        //    like the canonical editor flow. The scheduler detects the stale
        //    content version and regenerates the scene without the unit.
        await guardedStep(steps, 'invalidate_scene', async () => {
            await invalidateScene(bookId, chapterId, sceneId, loadedBook);
        });

        const result = finish(steps, summary);
        if (!result.complete) await recordPendingPurge('unit', bookId, chapterId, sceneId, unitId);
        log(`[ENTITY-CLEANUP] unit ${imageIUId} → ${result.complete ? 'OK' : 'PARTIAL'} ` +
            `(pg=${JSON.stringify(summary.pg)}, files=${summary.files_deleted})`);
        return result;
    }

    // Mark the parent scene dirty via the same PG path the editor PUT-book flow
    // uses: scene hash update + scene_assets stale (reconcileFromDiff) +
    // content_version bump / is_dirty (bumpSceneVersions).
    async function invalidateScene(bookId, chapterId, sceneId, loadedBook) {
        const book = loadedBook || (bookApi && typeof bookApi.loadBook === 'function' ? bookApi.loadBook(bookId) : null);
        const dirtyScenes = [{
            chapter_id: chapterId,
            scene_id: sceneId,
            reason: 'changed',
            dirty_layers: _mediaTypes(),
        }];
        if (bookSync && typeof bookSync.reconcileFromDiff === 'function') {
            await bookSync.reconcileFromDiff(bookId, dirtyScenes, book);
        }
        if (sceneAssetsRepo && typeof sceneAssetsRepo.bumpSceneVersions === 'function') {
            await sceneAssetsRepo.bumpSceneVersions(bookId, dirtyScenes);
        }
    }

    // ── Pending purge retry (consumed by reconcileCycle) ──
    async function retryPendingPurges() {
        let members = [];
        try {
            members = await redis.smembers(PENDING_PURGE_SET);
        } catch (err) {
            console.warn(`[ENTITY-CLEANUP] pending purge scan failed: ${err.message}`);
            return 0;
        }
        let cleared = 0;
        for (const marker of members) {
            const parts = marker.split(':');
            const kind = parts[0];
            let result = null;
            try {
                if (kind === 'scene' && parts.length >= 4) {
                    result = await purgeScene(parts[1], parts[2], parts[3]);
                } else if (kind === 'unit' && parts.length >= 5) {
                    result = await purgeUnit(parts[1], parts[2], parts[3], parts[4], undefined);
                } else {
                    console.warn(`[ENTITY-CLEANUP] unknown pending purge marker: ${marker}`);
                }
            } catch (err) {
                console.warn(`[ENTITY-CLEANUP] retry failed for ${marker}: ${err.message}`);
            }

            if (result && result.complete) {
                try {
                    await redis.srem(PENDING_PURGE_SET, marker);
                    await redis.del(`${PENDING_PURGE_ATTEMPTS_PREFIX}:${marker}`);
                    cleared++;
                } catch (err) {
                    console.warn(`[ENTITY-CLEANUP] failed to clear pending purge ${marker}: ${err.message}`);
                }
            } else {
                // Bump the attempt counter; give up after the cap so a stuck
                // marker cannot hot-loop the cycle (residual state stays logged).
                try {
                    const key = `${PENDING_PURGE_ATTEMPTS_PREFIX}:${marker}`;
                    const attempts = await redis.incr(key);
                    if (attempts === 1) await redis.expire(key, 3600);
                    if (attempts >= PENDING_PURGE_MAX_ATTEMPTS) {
                        await redis.srem(PENDING_PURGE_SET, marker);
                        await redis.del(key);
                        console.warn(`[ENTITY-CLEANUP] giving up pending purge after ${attempts} attempts: ${marker}`);
                    }
                } catch (err) {
                    console.warn(`[ENTITY-CLEANUP] pending purge counter failed for ${marker}: ${err.message}`);
                }
            }
        }
        if (cleared > 0) log(`[ENTITY-CLEANUP] retried ${cleared} pending purge(s)`);
        return cleared;
    }

    return {
        purgeScene,
        purgeUnit,
        recordPendingPurge,
        retryPendingPurges,
        PENDING_PURGE_SET,
    };
};