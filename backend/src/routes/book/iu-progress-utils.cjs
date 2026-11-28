// Pure + async helpers for computing image-unit (IU) generation progress used
// by the GET /assets-state endpoint.
//
// Background (Architectural Debt — progress determinism):
// The previous inline computation mixed THREE sources — a Redis confirmed
// counter, the PG dirty-unit count, and a filesystem PNG listing via
// fs.readdirSync with Math.max/Math.min. The disk listing made `ready`
// non-monotonic: a partially-written or stale PNG could bump the count up,
// and clearing dirty_unit_ids mid-regen flipped the formula between branches,
// causing the frontend progress to jump backwards.
//
// 2026-11-28 (ORCHESTRATION_V2 этап 4): the Redis confirmed counter
// (animastor:iu-progress:{book}:{ch}:{sc}:image) was INCR-ed only by the
// legacy task handler — orchestration v2 never wrote it, so it was 0 for every
// v2 book. The counter is gone; computeIuReady keeps its signature (the
// player package calls it) and counts the confirmed part as 0.

/**
 * Deterministic IU-ready count from raw counters. No IO — unit-testable.
 *
 * @param {number} total          total IUs for the scene
 * @param {number} dirtyCount     number of IUs marked dirty (being regenerated)
 * @param {number} confirmedCount value of the Redis iu-progress counter
 * @returns {number} ready count, clamped to [0, total]
 */
function iuReadyFromCounters(total, dirtyCount, confirmedCount) {
    const t = Math.max(0, total | 0);
    const dirty = Math.max(0, Math.min(dirtyCount | 0, t));
    const confirmed = Math.max(0, confirmedCount | 0);

    // Regeneration: non-dirty IUs are already on disk and ready; the dirty
    // ones become ready as the GPU confirms them (capped by dirtyCount).
    // Fresh generation (dirty=0): all confirmed IUs are ready, capped by total.
    const ready = dirty > 0
        ? (t - dirty) + Math.min(confirmed, dirty)
        : Math.min(confirmed, t);

    return Math.max(0, Math.min(ready, t));
}

/**
 * Read the dirty-unit count and Redis confirmed counter for a scene and return
 * the deterministic ready count. Used for both scene IUs and cover IUs.
 *
 * @param {RedisClient} _redis   unused (kept: the player passes it)
 * @param {Object} sceneAssetsRepo  repo exposing getDirtyUnitIds()
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {number} total            total IUs for the scene
 * @returns {Promise<number>}
 */
async function computeIuReady(_redis, sceneAssetsRepo, bookId, chapterId, sceneId, total) {
    let dirtyCount = 0;
    try {
        const dirtyIds = await sceneAssetsRepo.getDirtyUnitIds(bookId, chapterId, sceneId);
        dirtyCount = dirtyIds ? dirtyIds.length : 0;
    } catch (_) {}

    const confirmedCount = 0;   // legacy Redis counter removed (see the header)

    return iuReadyFromCounters(total, dirtyCount, confirmedCount);
}

module.exports = { iuReadyFromCounters, computeIuReady };
