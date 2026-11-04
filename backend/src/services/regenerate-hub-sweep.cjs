// ======================================================
// /regenerate — post-release GPU hub sweep plan (2026-11-04)
// ======================================================
// reports/2026-11-04/regenerate-sweep-fix.md. Incident: a one-scene audio
// /regenerate (scope current_scene) ended with a BOOK-WIDE
// `DELETE /queue/clear?book_id=` (Stage 122 N1 resolution of an empty id
// list); the hub removed a RUNNING image job of another scene (its result
// was rejected 409 and lost) and a QUEUED one (back only after 7 min of
// stale-lease recovery).
//
// Rule (fail-closed):
//   • the sweep targets ONLY the dispatch ids this call actually reset
//     (orchestrator.resetScenes → dispatchIds: the cancelled leases of the
//     reset scene×stage pairs);
//   • a book-wide sweep is allowed ONLY for a full restart of the whole book:
//     scope whole_book + rebuild_all + every ENABLED layer of the book is in
//     the command. Anything narrower (a scene, a chapter, from-scene, one
//     layer of the whole book) never sweeps the book — other scenes and other
//     layers may have jobs in flight;
//   • explicit cancellation (/cancel-generation), cache clear and book
//     deletion keep their own book-wide hub clear — they are not here.
//
// Pure: no Redis, no HTTP. The route executes the plan.

'use strict';

/**
 * @param {object} p
 * @param {string}   p.scope                 effective scope of the command
 * @param {boolean}  p.rebuildAll            rebuild_all of the request
 * @param {string[]} p.requestedWorkerTypes  layers of the command (disabled dropped)
 * @param {string[]} p.enabledWorkerTypes    layers enabled in the book's layer-config
 * @param {string[]} p.dispatchIds           dispatch ids reset by this call
 * @returns {{ mode: 'book'|'dispatch'|'none', book_sweep: boolean, dispatch_ids: string[], full_book_restart: boolean }}
 */
function planRegenerateHubSweep(p = {}) {
    const ids = [...new Set((Array.isArray(p.dispatchIds) ? p.dispatchIds : []).filter(id => typeof id === 'string' && id))];
    const requested = new Set(Array.isArray(p.requestedWorkerTypes) ? p.requestedWorkerTypes : []);
    const enabled = Array.isArray(p.enabledWorkerTypes) ? p.enabledWorkerTypes : [];
    const fullBookRestart = p.scope === 'whole_book'
        && p.rebuildAll === true
        && enabled.length > 0
        && enabled.every(type => requested.has(type));
    if (fullBookRestart) {
        return { mode: 'book', book_sweep: true, dispatch_ids: ids, full_book_restart: true };
    }
    if (ids.length > 0) {
        return { mode: 'dispatch', book_sweep: false, dispatch_ids: ids, full_book_restart: false };
    }
    return { mode: 'none', book_sweep: false, dispatch_ids: [], full_book_restart: false };
}

/** One log line: scope, dispatch ids, book_sweep (§9.6 of the stall report). */
function formatSweepLog(bookId, scopeDisplay, plan) {
    return `[REGENERATE] ${bookId}: hub sweep scope=${scopeDisplay} ` +
        `dispatch_ids=[${plan.dispatch_ids.join(',')}] book_sweep=${plan.book_sweep} mode=${plan.mode}`;
}

module.exports = { planRegenerateHubSweep, formatSweepLog };
