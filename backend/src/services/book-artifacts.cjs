// ======================================================
// Book artifacts on disk — scoped removal
// ======================================================
// Removes a book's generated artifacts from the output root without
// touching anything that belongs to another book:
//   - build ids are validated and resolved strictly inside OUTPUT_DIR;
//   - an entry belongs to the book whose id is the LONGEST known book id
//     that prefixes the entry name followed by "_" (artifact names start
//     with the book id), so book "ba" never claims "ba_1788…_ch-…";
//   - a build directory is removed as a whole only when nothing of another
//     book is left in it; otherwise only this book's entries are removed.

'use strict';

const fs = require('fs');
const path = require('path');
const { isValidBookId, isValidBuildId, joinInside } = require('@animastor/vbook-runtime/safe-paths');

function listBookIds(booksDir) {
    const ids = new Set();
    try {
        for (const e of fs.readdirSync(booksDir)) {
            const id = e.endsWith('.json') ? e.replace(/(\.snapshot)?\.json$/, '') : e;
            if (isValidBookId(id)) ids.add(id);
        }
    } catch (_) { /* no books dir */ }
    return ids;
}

/** Owner of an artifact name among `bookIds` (longest prefix match) or null. */
function ownerOf(name, bookIds) {
    let best = null;
    for (const id of bookIds) {
        if (name === id || name.startsWith(`${id}_`)) {
            if (!best || id.length > best.length) best = id;
        }
    }
    return best;
}

function isPlainDir(p) {
    try {
        const st = fs.lstatSync(p);
        return st.isDirectory() && !st.isSymbolicLink();
    } catch (_) {
        return false;
    }
}

/**
 * @param {object} opts
 * @param {string} opts.outputDir
 * @param {string} opts.booksDir
 * @param {string} opts.bookId
 * @param {Iterable<string>} [opts.buildIds]  build ids recorded for the book
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ removedDirs: number, removedEntries: number, skipped: number }}
 */
function removeBookArtifacts({ outputDir, booksDir, bookId, buildIds = [], log = () => {} }) {
    const out = { removedDirs: 0, removedEntries: 0, skipped: 0 };
    if (!isValidBookId(bookId) || !outputDir) return out;
    const bookIds = listBookIds(booksDir);
    bookIds.add(bookId);
    const mine = (name) => ownerOf(name, bookIds) === bookId;

    const cleanBuildDir = (buildId) => {
        if (!isValidBuildId(buildId)) { out.skipped++; log('[ARTIFACTS] invalid build id skipped'); return; }
        let buildPath;
        try { buildPath = joinInside(outputDir, buildId); } catch (_) { out.skipped++; return; }
        if (!isPlainDir(buildPath)) return;
        const entries = fs.readdirSync(buildPath);
        const foreign = entries.filter((e) => !e.startsWith('.') && !mine(e));
        if (foreign.length === 0) {
            fs.rmSync(buildPath, { recursive: true, force: true });
            out.removedDirs++;
            return;
        }
        for (const e of entries) {
            if (e.startsWith('.') || !mine(e)) continue;
            try { fs.rmSync(path.join(buildPath, e), { recursive: true, force: true }); out.removedEntries++; } catch (_) { /* best effort */ }
        }
        log(`[ARTIFACTS] ${buildId}: kept ${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} of other books`);
    };

    const seen = new Set();
    for (const b of buildIds) { if (!seen.has(b)) { seen.add(b); cleanBuildDir(b); } }
    const conventional = `build_${bookId}`;
    if (!seen.has(conventional)) cleanBuildDir(conventional);

    // Legacy flat layout: artifact FILES of this book directly in OUTPUT_DIR.
    let rootEntries = [];
    try { rootEntries = fs.readdirSync(outputDir, { withFileTypes: true }); } catch (_) { rootEntries = []; }
    for (const d of rootEntries) {
        if (!d.isFile() || !mine(d.name)) continue;
        try { fs.unlinkSync(path.join(outputDir, d.name)); out.removedEntries++; } catch (_) { /* best effort */ }
    }
    return out;
}

module.exports = { removeBookArtifacts, ownerOf, listBookIds };
