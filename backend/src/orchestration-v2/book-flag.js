// ======================================================
// orchestration-v2/book-flag — «is this book on orchestration v2?»
// ======================================================
// The ONE host predicate behind every legacy/v2 split (ADR ORCHESTRATION_V2
// §12 этап 1: books.orchestration = 'v2'). Consumers:
//   • the legacy package via the optional PersistencePort op
//     orchestration.isV2Book (command gate, reconcile, scheduler, scene window);
//   • host legacy services (gpu-retry-policy, startup-resume, window-generator);
//   • routes (/regenerate, cancel-*, layer-config, progress, delete).
// Semantics:
//   • column missing (42703: the v2 migration never ran) → not v2;
//   • unknown book → not v2;
//   • any other PG error → THROWS; isV2BookFailClosed() maps it to true
//     (legacy keeps its hands off when the answer is unknown).
// Short TTL cache (the flag changes by an explicit SQL switch, see ADR §12).

'use strict';

const TTL_MS = 5000;
const cache = new Map();
let repoOverride = null;

function repo() {
    return repoOverride || require('../storage/postgres/repositories/book-repo');
}

async function isV2Book(bookId) {
    if (!bookId || typeof bookId !== 'string') return false;
    const hit = cache.get(bookId);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.v2;
    let v2;
    try {
        v2 = (await repo().getOrchestration(bookId)) === 'v2';
    } catch (err) {
        if (err && err.code === '42703') v2 = false;           // no v2 schema → no v2 books
        else throw err;
    }
    cache.set(bookId, { v2, ts: Date.now() });
    return v2;
}

async function isV2BookFailClosed(bookId) {
    try { return await isV2Book(bookId); } catch (err) {
        console.warn(`[ORCH-V2] isV2Book(${bookId}) failed: ${err && err.message} — treated as v2 (fail-closed)`);
        return true;
    }
}

function invalidate(bookId) { if (bookId) cache.delete(bookId); else cache.clear(); }

/** Test hooks. */
function _setRepoForTest(r) { repoOverride = r; cache.clear(); }

module.exports = { isV2Book, isV2BookFailClosed, invalidate, _setRepoForTest, TTL_MS };
