// ======================================================
// Orphan Books Audit — read-only cross-source drift detection (stage 52)
// ======================================================
// `scenes` is a LAZILY materialized derived table:
//   - `runtime-persistence-adapter.listBooks` = SELECT DISTINCT book_id FROM scenes
//     (worklist rebuild / reconciliation-engine discovery entry point);
//   - import and /regenerate never INSERT into scenes;
//   - rows only appear via editor-save reconcile (book-sync.updateSceneHashes)
//     and scene-assets-repo.ensureSceneRow (unit-dirty / now also /regenerate);
//   - a derived-state cleanup (DELETE /book/:id/cache, book-sync purge,
//     guest-workspace purge) can delete scenes/scene_assets WITHOUT deleting
//     the canonical bundle on disk — and nothing re-creates the rows.
//
// Result: a book with live assets/tasks/IO becomes invisible to listBooks and
// C8/recovery can never pick it up again (production case
// `import_1786345731767_1786345734345`, 2026-08-10…08-13).
//
// This module only READS (SELECT + fs listing). It never mutates PG/Redis/FS.

const fs = require('fs');
const path = require('path');
const config = require('../config/runtime-config');

// NOTE: no direct postgres/database import here — SQL boundary (services must
// go through repositories or an injected read-only query fn; the CLI wrapper
// scripts/audit-orphan-books.js injects the pool query).

const ORPHAN_CLASS = {
    INVISIBLE: 'books_without_scenes',       // derived rows exist, scenes empty → absent from listBooks
    GHOST_SCENES: 'scenes_without_books',    // scenes rows for books deleted from books/disk
    DISK_HIDDEN: 'disk_books_without_scenes',// canonical bundle on disk, absent from listBooks
    NULL_BUILD_DUPLICATES: 'null_build_id_duplicates',
};

/**
 * Cross-check every source of truth for book identity / scene / asset state.
 * READ-ONLY: issues SELECT statements only, via the injected query fn.
 * @param {object} opts
 * @param {Function} opts.query read-only query fn (SELECT …) → { rows }
 * @param {string} [opts.booksDir] canonical bundle dir (default: config.BOOKS_DIR)
 * @returns {Promise<{
 *   booksWithoutScenes: Array<{book_id:string, assets:number, tasks:number, image_units:number, in_books:boolean, on_disk:boolean}>,
 *   scenesWithoutBooks: Array<{book_id:string, scenes:number, on_disk:boolean}>,
 *   diskBooksWithoutScenes: Array<{book_id:string}>,
 *   nullBuildDuplicates: Array<{book_id:string, chapter_id:string, scene_id:string, asset_type:string, rows:number}>,
 *   stats: object
 * }>}
 */
async function collectOrphanReport(opts) {
    if (!opts || typeof opts.query !== 'function') {
        throw new TypeError('collectOrphanReport: opts.query (read-only SELECT fn) is required');
    }
    const query = opts.query;
    const booksDir = opts.booksDir || config.BOOKS_DIR;

    // ── 1. identity sets ────────────────────────────────────────────────
    const booksRows = await query('SELECT book_id FROM books');
    const scenesRows = await query('SELECT book_id, COUNT(*)::int AS n FROM scenes GROUP BY book_id');
    const inBooks = new Set(booksRows.rows.map(r => r.book_id));
    const sceneCountByBook = new Map(scenesRows.rows.map(r => [r.book_id, r.n]));

    // ── 2. derived-state row counts per book ────────────────────────────
    const assetRows = await query(
        'SELECT book_id, COUNT(*)::int AS n FROM scene_assets GROUP BY book_id');
    const taskRows = await query(
        'SELECT book_id, COUNT(*)::int AS n FROM generation_tasks GROUP BY book_id');
    const iuRows = await query(
        'SELECT book_id, COUNT(*)::int AS n FROM image_units GROUP BY book_id');

    const derivedByBook = new Map();
    const bump = (bookId, field, n) => {
        if (!bookId) return;
        const cur = derivedByBook.get(bookId) || { assets: 0, tasks: 0, image_units: 0, in_books: false, on_disk: false };
        cur[field] += n;
        derivedByBook.set(bookId, cur);
    };
    assetRows.rows.forEach(r => bump(r.book_id, 'assets', r.n));
    taskRows.rows.forEach(r => bump(r.book_id, 'tasks', r.n));
    iuRows.rows.forEach(r => bump(r.book_id, 'image_units', r.n));
    derivedByBook.forEach((v, k) => { v.in_books = inBooks.has(k); });

    // ── 3. canonical bundle on disk (book.json / manifest.json) ─────────
    let onDisk = new Set();
    try {
        onDisk = new Set(
            fs.readdirSync(booksDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name)
                .filter(name =>
                    fs.existsSync(path.join(booksDir, name, 'book.json')) ||
                    fs.existsSync(path.join(booksDir, name, 'manifest.json')))
        );
    } catch (_) { /* booksDir unreadable → report disk-less view */ }
    derivedByBook.forEach((v, k) => { v.on_disk = onDisk.has(k); });

    // ── 4. Class I/III: books present in a source of truth but with NO
    //        scenes rows → invisible to listBooks (SELECT DISTINCT book_id FROM scenes)
    const booksWithoutScenes = [];
    const seenNoScenes = new Set();
    for (const [bookId, v] of derivedByBook) {
        if (sceneCountByBook.has(bookId)) continue;
        seenNoScenes.add(bookId);
        booksWithoutScenes.push({ book_id: bookId, ...v });
    }
    for (const bookId of inBooks) {
        if (sceneCountByBook.has(bookId) || seenNoScenes.has(bookId)) continue;
        booksWithoutScenes.push({
            book_id: bookId, assets: 0, tasks: 0, image_units: 0,
            in_books: true, on_disk: onDisk.has(bookId),
        });
    }
    booksWithoutScenes.sort((a, b) => (b.assets + b.tasks + b.image_units) - (a.assets + a.tasks + a.image_units));

    // ── 5. Class II: scenes rows whose book is gone from books/disk ─────
    const scenesWithoutBooks = scenesRows.rows
        .filter(r => !inBooks.has(r.book_id))
        .map(r => ({ book_id: r.book_id, scenes: r.n, on_disk: onDisk.has(r.book_id) }))
        .sort((a, b) => b.scenes - a.scenes);

    // ── 6. Class III: canonical bundle on disk but registered nowhere in PG
    //        (no scenes, no books row, no derived rows) — disjoint from Class I ─
    const diskBooksWithoutScenes = [...onDisk]
        .filter(id => !sceneCountByBook.has(id))
        .filter(id => !inBooks.has(id))
        .filter(id => !derivedByBook.has(id))
        .sort()
        .map(id => ({ book_id: id }));

    // ── 7. NULL build_id duplicates (unique constraint cannot dedupe) ───
    const nullDup = await query(`
        SELECT book_id, chapter_id, scene_id, asset_type, COUNT(*)::int AS rows
        FROM scene_assets
        WHERE build_id IS NULL
        GROUP BY book_id, chapter_id, scene_id, asset_type
        HAVING COUNT(*) > 1
        ORDER BY rows DESC, book_id
    `);
    const nullTotals = await query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE build_id IS NULL)::int AS null_build,
               COUNT(DISTINCT (book_id, chapter_id, scene_id, asset_type))
                   FILTER (WHERE build_id IS NULL)::int AS null_keys
        FROM scene_assets
    `);

    const stats = {
        books_rows: inBooks.size,
        scene_books: sceneCountByBook.size,
        scene_rows: [...sceneCountByBook.values()].reduce((a, b) => a + b, 0),
        disk_bundles: onDisk.size,
        scene_assets_total: nullTotals.rows[0].total,
        scene_assets_null_build: nullTotals.rows[0].null_build,
        scene_assets_null_keys: nullTotals.rows[0].null_keys,
        null_build_redundant_rows: nullTotals.rows[0].null_build - nullTotals.rows[0].null_keys,
    };

    return {
        booksWithoutScenes,
        scenesWithoutBooks,
        diskBooksWithoutScenes,
        nullBuildDuplicates: nullDup.rows,
        stats,
    };
}

/** Total number of drift findings (classes I–III + NULL-build duplicates). */
function countIssues(report) {
    return report.booksWithoutScenes.length
        + report.scenesWithoutBooks.length
        + report.diskBooksWithoutScenes.length
        + report.nullBuildDuplicates.length;
}

module.exports = { collectOrphanReport, countIssues, ORPHAN_CLASS };
