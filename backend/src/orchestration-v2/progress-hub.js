// ======================================================
// orchestration-v2/progress-hub — PG NOTIFY gen_progress → SSE clients, in process
// ======================================================
// ADR ORCHESTRATION_V2 §4.3, §9 (2026-11-27, generate API v2): progress of the
// generation travels ONLY through PG `LISTEN gen_progress`. The host keeps ONE
// listener (index.js); this hub fans its events out to the SSE clients of the
// book inside the backend process. Redis is not on the path (no pub/sub
// `animastor:progress:*` for v2): a stopped Redis does not stop the events.
//
// Two kinds of subscribers:
//   • aggregate (GET /generate/stream) — the §9 aggregate of the book, freshly
//     read from PG on every (coalesced) NOTIFY of that book;
//   • legacy   (GET /progress-stream, until step 5 of the legacy removal) —
//     the old event shapes of progress-adapter.onNotify
//     ({type:'progress', layer, command_id, ready, total} / generation_complete).
// No subscribers of a book → no PG read for it.
//
// Coalescing: NOTIFYs of one book within `coalesceMs` give one aggregate read
// (a whole-book command accepts many results per second); the event always
// carries the state read AFTER the last NOTIFY of the burst.

'use strict';

const DEFAULT_COALESCE_MS = 150;

function createProgressHub({ aggregate, legacyEvents, coalesceMs = DEFAULT_COALESCE_MS, warn = (m) => console.warn(m) }) {
    const aggSubs = new Map();      // book_id → Set<fn(event)>
    const legacySubs = new Map();   // book_id → Set<fn(payload)>
    const pending = new Map();      // book_id → {timer, commandIds:Set}

    function add(map, bookId, fn) {
        if (!map.has(bookId)) map.set(bookId, new Set());
        map.get(bookId).add(fn);
        return () => {
            const s = map.get(bookId);
            if (!s) return;
            s.delete(fn);
            if (s.size === 0) map.delete(bookId);
        };
    }

    const deliver = (set, payload) => {
        for (const fn of [...(set || [])]) {
            try { fn(payload); } catch (_) { /* one broken client must not stop the others */ }
        }
    };

    async function flush(bookId) {
        const p = pending.get(bookId);
        pending.delete(bookId);
        if (!p || !aggSubs.has(bookId)) return;
        const progress = await aggregate(bookId);
        deliver(aggSubs.get(bookId), { type: 'gen_progress', reason: 'notify', command_ids: [...p.commandIds], progress });
    }

    /** One NOTIFY gen_progress payload ({book_id, command_id}). */
    function onNotify(evt) {
        const bookId = evt && typeof evt.book_id === 'string' ? evt.book_id : null;
        if (!bookId) return;
        if (aggSubs.has(bookId)) {
            let p = pending.get(bookId);
            if (!p) {
                p = { commandIds: new Set(), timer: null };
                pending.set(bookId, p);
                p.timer = setTimeout(() => {
                    flush(bookId).catch((err) => warn(`[ORCH-V2] progress NOTIFY→SSE failed book=${bookId}: ${err && err.message}`));
                }, coalesceMs);
                if (typeof p.timer.unref === 'function') p.timer.unref();
            }
            if (evt.command_id) p.commandIds.add(evt.command_id);
        }
        if (legacySubs.has(bookId) && legacyEvents) {
            legacyEvents(evt, (_b, payload) => deliver(legacySubs.get(bookId), payload)).catch((err) => {
                warn(`[ORCH-V2] progress NOTIFY→SSE failed book=${bookId} command=${evt.command_id}: ${err && err.message}`);
            });
        }
    }

    /**
     * GET /generate/stream: the fresh aggregate right away (connect / reconnect),
     * then one per coalesced NOTIFY of the book.
     * @returns {Promise<() => void>} unsubscribe
     */
    async function subscribeAggregate(bookId, fn) {
        const off = add(aggSubs, bookId, fn);
        try {
            const progress = await aggregate(bookId);
            fn({ type: 'gen_progress', reason: 'connect', command_ids: [], progress });
        } catch (err) {
            off();
            throw err;
        }
        return off;
    }

    /** GET /progress-stream (old event shapes). @returns {() => void} unsubscribe */
    function subscribeLegacy(bookId, fn) {
        return add(legacySubs, bookId, fn);
    }

    function stop() {
        for (const p of pending.values()) clearTimeout(p.timer);
        pending.clear();
    }

    const stats = () => ({
        aggregate_books: aggSubs.size,
        aggregate_clients: [...aggSubs.values()].reduce((n, s) => n + s.size, 0),
        legacy_books: legacySubs.size,
        legacy_clients: [...legacySubs.values()].reduce((n, s) => n + s.size, 0),
    });

    return { onNotify, subscribeAggregate, subscribeLegacy, stop, stats };
}

module.exports = { createProgressHub, DEFAULT_COALESCE_MS };
