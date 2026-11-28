// ======================================================
// services/book-snapshot — <book_id>.snapshot.json of a book
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 этап 4, шаг 7): moved verbatim out of the
// deleted services/task-handler.cjs (protocol-2 result handling); the only
// live caller is POST /book/:id/parse-full (routes/book/parse-routes.cjs).
//
// The snapshot is the serialized book model, so it carries the format
// version in manifest.vbook_version. It is written only for a VBook 4 book
// (loadBook refuses anything else); hero_issues is load-time state and is
// not stored.

'use strict';

const fs = require('fs');
const { isValidBookId, joinInside } = require('@animastor/vbook-runtime/safe-paths');

function createBookSnapshot({ book, config, log = console.log }) {
    function snapshotPathOf(bookId) {
        if (!isValidBookId(bookId)) return null;
        return joinInside(config.BOOKS_DIR, `${bookId}.snapshot.json`);
    }

    async function saveBookSnapshot(bookId) {
        try {
            const snapshotPath = snapshotPathOf(bookId);
            if (!snapshotPath) {
                log(`⚠️ saveBookSnapshot: invalid book id`);
                return null;
            }
            const bookData = book.loadBook(bookId);
            if (!bookData) {
                log(`⚠️ saveBookSnapshot: book ${bookId} not found`);
                return null;
            }
            const { hero_issues: _loadTimeOnly, ...snapshot } = bookData;
            fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
            log(`💾 Book snapshot saved: ${bookId} (vbook_version ${snapshot.manifest && snapshot.manifest.vbook_version})`);
            return snapshotPath;
        } catch (err) {
            console.error(`❌ saveBookSnapshot failed for ${bookId}:`, err.message);
            return null;
        }
    }

    return { saveBookSnapshot };
}

module.exports = { createBookSnapshot };
