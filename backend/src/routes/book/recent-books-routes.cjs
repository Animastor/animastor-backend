// ======================================================
// Recent Books Route — GET /api/v1/books
// ======================================================
// Lets ANY client (native Android, mobile web, web) discover which books exist
// on the server, so a book imported/opened on one device can be restored on
// another. Backed by the book_source PG table (SHA-256 → book_id, registered on
// TXT import) plus a disk scan fallback for books not in PG (e.g. .vbook
// imports). Each entry is joined with the lazy-book manifest for display state,
// title and build_id.
//
// The route handler is exported separately as `collectRecentBooks` so unit
// tests can exercise the merge logic without PG or an HTTP server.
//
// Workspace ownership (Account System foundation):
// - When `workspaceId` is provided the list is restricted to books whose
//   books.workspace_id matches; PG rows are pre-filtered server-side
//   (book_source JOIN books), so no row can leak by anything but the filter.
// - The disk-scan fallback is skipped entirely under a workspace filter: a
//   disk-only book has no known owner in PG, and listing it would leak the
//   "knows the path → sees the book" assumption into a multi-tenant world.
// - Books whose registry row is missing workspace_id are self-healed through
//   an optional `resolveBookWorkspace` callback before filtering.
// - Pre-auth mode (no workspaceId) keeps today's behaviour: all books, with
//   workspace_id exposed as metadata on every entry.
//
// «Мои книги» (2026-11-22): each entry also carries vbook_version (the format;
// 3.1 = "устаревший формат"), last_opened_at (epoch ms, books.last_opened_at,
// written by POST /api/v1/book/:id/opened — registered here too) and
// has_generated_content (anything DELETE /book/:id/cache would remove).
// The list is ordered recently-opened first.
// ======================================================

const fs = require('fs');

const DEFAULT_LIMIT = 20;
/** «Мои книги» asks for the whole workspace list; a hard cap keeps one call bounded. */
const MAX_LIMIT = 500;
const SUPPORTED_VBOOK_VERSION = 4;

/**
 * A timestamp of any shape the sources use → epoch ms, or null.
 * manifest.updated_at is an ISO string; book_source.created_at and the books
 * table use epoch SECONDS; last_opened_at is epoch ms.
 */
function toEpochMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n < 1e12 ? n * 1000 : n; // seconds → ms
    }
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
}

/** vbook_version of a supported book, from its manifest; 4 when unreadable. */
function supportedVersionOf(lazyBook, bookId) {
    try {
        const manifest = readJsonQuiet(lazyBook.getManifestPath(lazyBook.getBookDir(bookId)));
        const v = manifest.vbook_version;
        if (typeof v === 'number' || (typeof v === 'string' && v)) return v;
    } catch (_) { /* fall through */ }
    return SUPPORTED_VBOOK_VERSION;
}

/**
 * manifest.created_at of a book (ISO) or null. A blank book (POST /book/blank)
 * has no manifest.updated_at until its first change — its list date falls back
 * to the creation time (post171).
 */
function createdAtOf(lazyBook, bookId) {
    try {
        const manifest = readJsonQuiet(lazyBook.getManifestPath(lazyBook.getBookDir(bookId)));
        return manifest.created_at || null;
    } catch (_) {
        return null;
    }
}

/** manifest.json / book.json of a book, read directly (no model load); {} when unreadable. */
function readJsonQuiet(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

/**
 * Resolve book status; never throws for a single missing/corrupt book.
 * A book that exists but is not VBook 4 (3.1, no version, newer — see
 * VBOOK_FORMAT_V4 §9) is still listed: `unsupported: true`, the title from
 * its own files, nothing else. The only thing a client can do with it is
 * delete it.
 */
function safeStatus(lazyBook, bookId) {
    try {
        return lazyBook.getBookStatus(bookId);
    } catch (err) {
        if (!err || err.code !== 'UNSUPPORTED_VBOOK_VERSION') return null;
        try {
            const dir = lazyBook.getBookDir(bookId);
            const manifest = readJsonQuiet(lazyBook.getManifestPath(dir));
            const meta = readJsonQuiet(lazyBook.getBookMetaPath(dir));
            return {
                unsupported: true,
                vbookVersion: err.vbookVersion == null ? null : err.vbookVersion,
                title: (typeof meta.title === 'string' && meta.title) || (typeof manifest.title === 'string' && manifest.title) || bookId,
                state: null,
                updatedAt: manifest.updated_at || null,
                buildId: typeof manifest.build_id === 'string' ? manifest.build_id : null,
                parsedChapters: 0,
                parsedScenes: 0,
            };
        } catch (_) {
            return null;
        }
    }
}

/** Resolve build_id from the lazy-book manifest; null when unavailable. */
function buildIdOf(lazyBook, bookId) {
    try {
        const d = lazyBook.loadDraftBook(bookId);
        return (d && d.manifest && d.manifest.build_id) || null;
    } catch (_) {
        return null;
    }
}

function toEntry(lazyBook, bookId, { title, state, sourceType, fileHash, updatedAt, parsedChapters, totalScenes, workspaceId, status }) {
    const unsupported = !!(status && status.unsupported);
    return {
        ...(unsupported ? { unsupported: true } : {}),
        // «Мои книги»: the format of the book (3.1 → "устаревший формат").
        vbook_version: unsupported ? status.vbookVersion : supportedVersionOf(lazyBook, bookId),
        book_id: bookId,
        build_id: unsupported ? status.buildId : buildIdOf(lazyBook, bookId),
        title: title || bookId,
        state: state || null,
        source_type: sourceType || 'txt',
        file_hash: fileHash || null,
        updated_at: updatedAt || 0,
        // The same moment normalized to epoch ms (updated_at keeps its source
        // shape — ISO string or epoch seconds — for older clients). No update
        // time (a blank book) → manifest.created_at; updated_at itself stays as
        // it was (0), so older clients see no new shape.
        updated_at_ms: toEpochMs(updatedAt) ?? toEpochMs(createdAtOf(lazyBook, bookId)),
        // When the owner last opened the book (POST /book/:id/opened), epoch ms.
        last_opened_at: null,
        parsed_chapters: parsedChapters || 0,
        total_scenes: totalScenes || 0,
        workspace_id: workspaceId || null,
    };
}

/**
 * Build the recent-books list.
 *
 * @param {object} deps
 * @param {object} deps.bookSourceRepo
 * @param {object} deps.lazyBook
 * @param {number} [deps.limit]
 * @param {string} [deps.workspaceId] - restrict the list to this workspace.
 *   Under a filter only PG-known books with ownership are eligible; the
 *   disk-scan fallback is skipped.
 * @param {function} [deps.resolveBookWorkspace] - async (bookId, title) =>
 *   workspaceId|null. Self-heals books whose registry row lacks a workspace
 *   (e.g. created before ownership existed or while PG was down). When set,
 *   every entry's workspace_id is resolved before (optional) filtering.
 * @param {function} [deps.hasGeneratedContent] - (bookId, buildId) => boolean:
 *   does the book have anything DELETE /book/:id/cache would remove. When
 *   absent, `has_generated_content` is null (unknown).
 * @returns {Promise<Array>} recently opened first (last_opened_at, else the
 *   last update), capped at `limit`.
 */
async function collectRecentBooks({ bookSourceRepo, lazyBook, limit = DEFAULT_LIMIT, workspaceId, resolveBookWorkspace, bookRepo, hasGeneratedContent }) {
    const lastOpened = new Map(); // book_id -> epoch ms (books.last_opened_at)
    const entries = new Map(); // book_id -> entry
    const seen = new Set();

    // ── Phase 1: PG book_source (fast path — TXT imports register here) ──
    let pgRows = [];
    try {
        pgRows = await bookSourceRepo.listRecent(limit * 2, { workspaceId });
    } catch (err) {
        // PG may be down; the disk scan below still yields something.
    }
    for (const row of pgRows || []) {
        seen.add(row.book_id);
        const status = safeStatus(lazyBook, row.book_id);
        if (!status) continue; // book no longer on disk — skip stale reference
        entries.set(row.book_id, toEntry(lazyBook, row.book_id, {
            status,
            title: status.title,
            state: status.state,
            sourceType: row.source_type || 'txt',
            fileHash: row.file_hash || null,
            workspaceId: row.workspace_id || null,
            // Prefer manifest update time; fall back to the PG import timestamp
            // so a book whose manifest lacks updated_at still ranks by recency.
            updatedAt: status.updatedAt != null ? status.updatedAt : row.created_at,
            parsedChapters: status.parsedChapters,
            totalScenes: status.parsedScenes,
        }));
    }

    // ── Phase 1.5: ownership registry merge (workspace-scoped only) ──
    // book_source indexes TXT imports only; blank books and .vbook imports have
    // ownership in the books table alone. Merge them so the workspace list is
    // complete. Never merged pre-auth (the books registry then adds nothing the
    // disk scan doesn't already cover, and keeps the disk-only path intact).
    if (workspaceId && bookRepo) {
        try {
            const ownedRows = await bookRepo.listBookIdsByWorkspace(workspaceId);
            for (const row of ownedRows || []) {
                if (seen.has(row.book_id)) continue;
                seen.add(row.book_id);
                const status = safeStatus(lazyBook, row.book_id);
                if (!status) continue; // book no longer on disk — skip stale reference
                entries.set(row.book_id, toEntry(lazyBook, row.book_id, {
                    status,
                    title: status.title,
                    state: status.state,
                    sourceType: 'registry',
                    fileHash: null,
                    workspaceId: row.workspace_id,
                    updatedAt: status.updatedAt,
                    parsedChapters: status.parsedChapters,
                    totalScenes: status.parsedScenes,
                }));
            }
        } catch (err) {
            // PG may be down; Phase 1 rows still apply.
        }
    }

    // ── Phase 2: disk scan — books not registered in PG (e.g. .vbook imports) ──
    // Skipped under a workspace filter: disk-only books have no owner record.
    if (!workspaceId) {
        const booksDir = lazyBook.getBooksDir();
        if (booksDir && fs.existsSync(booksDir)) {
            let dirNames = [];
            try {
                dirNames = fs.readdirSync(booksDir, { withFileTypes: true })
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
            } catch (_) { /* books dir unreadable */ }
            for (const bookId of dirNames) {
                if (seen.has(bookId)) continue;
                const status = safeStatus(lazyBook, bookId);
                if (!status) continue;
                entries.set(bookId, toEntry(lazyBook, bookId, {
                    status,
                    title: status.title,
                    state: status.state,
                    sourceType: 'disk',
                    fileHash: null,
                    updatedAt: status.updatedAt,
                    parsedChapters: status.parsedChapters,
                    totalScenes: status.parsedScenes,
                }));
            }
        }
    }

    let result = [...entries.values()];

    // ── Phase 3: workspace ownership resolution + filtering ──
    if (resolveBookWorkspace) {
        for (let i = 0; i < result.length; i++) {
            const entry = result[i];
            if (!entry.workspace_id) {
                try {
                    entry.workspace_id = await resolveBookWorkspace(entry.book_id, entry.title) || null;
                } catch (_) {
                    entry.workspace_id = null;
                }
            }
        }
        // Never leak books owned by another workspace.
        result = workspaceId
            ? result.filter(entry => entry.workspace_id === workspaceId)
            : result.filter(entry => entry.workspace_id != null);
    } else if (workspaceId) {
        result = result.filter(entry => entry.workspace_id === workspaceId);
    } else {
        // Anonymous (no identity): only show unowned books (workspace_id IS
        // NULL). Books belonging to a user/guest workspace must never leak to
        // unauthenticated visitors.
        result = result.filter(entry => !entry.workspace_id);
    }

    // «Мои книги»: when the owner last opened each book. A failure (PG down,
    // the MB-1 column not yet migrated) only loses the order, never the list.
    if (workspaceId && bookRepo && typeof bookRepo.lastOpenedByWorkspace === 'function') {
        try {
            const map = await bookRepo.lastOpenedByWorkspace(workspaceId);
            for (const [id, at] of map || []) {
                const ms = toEpochMs(at);
                if (ms != null) lastOpened.set(id, ms);
            }
        } catch (_) { /* order by last update only */ }
    }
    for (const entry of result) {
        entry.last_opened_at = lastOpened.has(entry.book_id) ? lastOpened.get(entry.book_id) : null;
        let generated = null;
        if (typeof hasGeneratedContent === 'function') {
            try { generated = !!hasGeneratedContent(entry.book_id, entry.build_id); } catch (_) { generated = null; }
        }
        entry.has_generated_content = generated;
    }

    // Recently opened first; a book never opened ranks by its last update.
    const sortKey = (entry) => entry.last_opened_at || entry.updated_at_ms || 0;
    return result
        .sort((a, b) => sortKey(b) - sortKey(a))
        .slice(0, Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT)));
}

module.exports = function registerRecentBooksRoutes(app, _redis, deps) {
    const { bookSourceRepo, lazyBook } = deps;
    const log = (deps.utils && deps.utils.log) || (() => {});
    const bookRepo = require('../../storage/postgres/repositories/book-repo');
    const workspaceOwnership = deps.workspaceOwnership
        || require('../../middleware/workspace-ownership');
    const bookArtifacts = require('../../services/book-artifacts.cjs');
    const { PRESERVED_ENTRIES } = require('../../utils/build-dir');
    const config = deps.config || {};

    /** One listing of the books dir per request (ownership of shared build dirs). */
    function generatedContentProbe() {
        if (!config.OUTPUT_DIR) return undefined;
        const bookIds = bookArtifacts.listBookIds(config.BOOKS_DIR);
        return (bookId, buildId) => bookArtifacts.hasBookArtifacts({
            outputDir: config.OUTPUT_DIR, booksDir: config.BOOKS_DIR, bookId,
            buildIds: buildId ? [buildId] : [], buildScoped: PRESERVED_ENTRIES,
            preserve: PRESERVED_ENTRIES, bookIds,
        });
    }

    // POST /api/v1/book/:bookId/opened — «Мои книги»: the owner opened the
    // book. Records books.last_opened_at and NOTHING else: no generation, no
    // analysis, no snapshot, no change of the book files or updated_at.
    // Access: the /api/v1/book/:bookId guard of backend.cjs (requireBookAccess:
    // anonymous 401, a stranger 403) and the VBook version gate (a 3.1 book
    // answers 409 — nothing but deletion is allowed for it, §9).
    app.post('/api/v1/book/:bookId/opened', async (req, res) => {
        try {
            const at = Date.now();
            const ok = await bookRepo.markOpened(req.params.bookId, at);
            if (!ok) return res.status(404).json({ error: 'book_not_found' });
            res.json({ book_id: req.params.bookId, last_opened_at: at });
        } catch (err) {
            console.error('[RECENT-BOOKS] opened:', err.message);
            res.status(500).json({ error: 'opened_failed' });
        }
    });

    app.get('/api/v1/books', async (req, res) => {
        // The recent-books list is identity-scoped (workspace-filtered) and must
        // never be replayed from the browser HTTP cache after logout/login.
        res.setHeader('Cache-Control', 'no-store');
        try {
            // The list is always scoped to the caller's workspace; a request
            // without identity (no workspace) sees no books.
            const workspaceId = req.workspace?.id || null;
            if (!workspaceId) return res.json({ books: [] });

            const books = await collectRecentBooks({
                bookSourceRepo,
                lazyBook,
                limit: parseInt(req.query.limit, 10) || DEFAULT_LIMIT,
                workspaceId,
                bookRepo: workspaceId ? bookRepo : undefined,
                hasGeneratedContent: generatedContentProbe(),
                // Self-heal ownership rows under a workspace scope; pre-auth keeps
                // listing everything so a brief PG outage never empties the page.
                ...(workspaceId ? {
                    resolveBookWorkspace: (bookId, title) => workspaceOwnership
                        .resolveWorkspaceForBook(bookId, { bookTitle: title, preferredWorkspaceId: workspaceId }),
                } : {}),
            });
            res.json({ books });
        } catch (err) {
            console.error('[RECENT-BOOKS] Error:', err.message);
            res.status(500).json({ error: err.message || 'unknown error' });
        }
    });

    log('[ROUTES] Recent books route loaded');
};

module.exports.collectRecentBooks = collectRecentBooks;
module.exports.toEpochMs = toEpochMs;
