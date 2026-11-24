// ======================================================
// Build id ownership — does another book name this build id?
// ======================================================
// OUTPUT_DIR/<build_id>/ is per build id; its build-scoped entries (voices/)
// do not carry a book id. A build id two books share therefore must never be
// removed as a whole directory (book-deletion.cjs, stage171 — its own copy,
// Book Model layer boundary) and must not be taken by an imported book
// (vbook-import.cjs, post171).
//
// Sources: every PG table that records a build_id next to a book_id
// (schema.js — book-repo.buildIdsNamedByOtherBooks, injected) and the
// manifests of the other books on disk. A failed PG read
// counts as "shared" — callers then keep a directory / issue a fresh id, never
// act blindly.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {object} ctx
 * @param {(buildIds: string[], bookId: string) => Promise<Set<string>>} ctx.pgOwners
 *        book-repo.buildIdsNamedByOtherBooks (raw SQL stays in the repository)
 * @param {string} ctx.booksDir  BOOKS_DIR
 * @param {string} bookId        the book asking (its own rows / manifest do not count)
 * @param {Iterable<string>} candidates
 * @returns {Promise<Set<string>>} the candidates another book also names
 */
async function buildIdsOfOtherBooks({ pgOwners, booksDir }, bookId, candidates) {
    const shared = new Set();
    const ids = [...new Set([...candidates].filter((b) => typeof b === 'string' && b))];
    if (ids.length === 0) return shared;
    try {
        for (const b of await pgOwners(ids, bookId)) shared.add(b);
    } catch (err) {
        console.warn(`[BUILD-ID] owner check: ${err.message} — treated as taken`);
        for (const b of ids) shared.add(b);
        return shared;
    }
    let entries = [];
    try { entries = fs.readdirSync(booksDir); } catch (_) { entries = []; }
    for (const e of entries) {
        if (e === bookId || e === `${bookId}.json` || e === `${bookId}.snapshot.json`) continue;
        const file = e.endsWith('.json') ? path.join(booksDir, e) : path.join(booksDir, e, 'manifest.json');
        let m = null;
        try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
        const b = m && (typeof m.build_id === 'string' ? m.build_id : (m.manifest && m.manifest.build_id));
        if (typeof b === 'string' && ids.includes(b)) shared.add(b);
    }
    return shared;
}

module.exports = { buildIdsOfOtherBooks };
