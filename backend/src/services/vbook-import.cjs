// ======================================================
// vbook-import — the ONE way a .vbook archive becomes a book on disk
// ======================================================
// POST /api/v1/book/import, POST /api/v1/book/load-vbook and POST
// /api/v1/generate used to carry three copies of the same ~70 lines
// (VBOOK_FORMAT_V4 §11.2, Н15). They now call importVbookArchive.
//
// Order of work — nothing is written before every check has passed:
//   1. list and extract the archive (limits, unsafe names, links, whitelist);
//      manifest.json must be in the archive root;
//   2. build the VBook 4 model: version gate, exact paths, hero files;
//   3. validate the whole model against the bundle contract;
//   4. ownership: a bundle's book_id is client-controlled and must never
//      touch a book of another workspace;
//   5. an existing book with this id is kept as it is (never overwritten);
//      otherwise the book is saved by the object path — saveBookBundle(book).
//      Archive entries are never written to disk as they came.
//
// Every refusal is a plain { status, body } with a stable `error` code, and
// the disk is exactly as it was.

'use strict';

const {
    isUnsupportedVersionError, unsupportedVersionBody,
} = require('@animastor/vbook-runtime/vbook-version.cjs');
const { validateBundleObject } = require('@animastor/vbook-runtime/bundle-validator.cjs');

function requestLanguage(req) {
    const header = req && req.headers ? req.headers['accept-language'] : '';
    return /^\s*ru/i.test(String(header || '')) ? 'ru' : 'en';
}

function publicIssues(issues) {
    return (Array.isArray(issues) ? issues : []).map((i) => ({
        file: i.file,
        ...(i.hero_id ? { hero_id: i.hero_id } : {}),
        code: i.code,
        message: i.message,
    }));
}

/**
 * Turn an import error into an HTTP answer.
 * @param {Error} err
 * @param {object} req  for the language of the message
 * @param {number} [unsupportedStatus] 422 for an uploaded archive, 409 for a book already on the server
 * @returns {{status: number, body: object}}
 */
function importRefusal(err, req, unsupportedStatus = 422) {
    if (isUnsupportedVersionError(err)) {
        return { status: unsupportedStatus, body: unsupportedVersionBody(err, requestLanguage(req)) };
    }
    const code = err && typeof err.code === 'string' ? err.code : null;
    if (code === 'MANIFEST_NOT_IN_ROOT') {
        return { status: 400, body: { error: 'manifest_not_in_root', code: 'manifest_not_in_root', message: err.message } };
    }
    if (code === 'HERO_FILE_BROKEN' || code === 'hero_file_broken') {
        const issues = err.issues || (err.details && err.details.issues) || [];
        return { status: 422, body: { error: 'hero_file_broken', code: 'hero_file_broken', message: err.message, issues: publicIssues(issues) } };
    }
    if (err && err.name === 'InvalidInputError') {
        return { status: err.status || 400, body: { error: err.message || 'invalid input', code: String(code || 'invalid_input').toLowerCase() } };
    }
    return { status: 400, body: { error: (err && err.message) || 'unknown error' } };
}

/**
 * @param {object} deps
 * @param {object} deps.book               @animastor/vbook-runtime
 * @param {function} deps.importBookAllowed async (req, bookId, {diskCopyExists}) → {allowed, status, error}
 * @param {function} [deps.log]
 */
function createVbookImporter({ book, importBookAllowed, log = () => {} }) {
    // Dependencies are checked when an archive actually arrives: routes are
    // registered in processes (and tests) that never import a book.
    function assertWired() {
        if (!book || typeof book.saveBookBundle !== 'function') throw new Error('vbook-import: book runtime is required');
        if (typeof importBookAllowed !== 'function') throw new Error('vbook-import: importBookAllowed is required');
    }

    /**
     * @param {object} req     express request (identity, language)
     * @param {Buffer} buffer  the uploaded archive
     * @param {{tag?: string}} [options]
     * @returns {Promise<
     *   { ok: false, status: number, body: object } |
     *   { ok: true, bookId: string, buildId: string, bookData: object,
     *     loadedBook: object, wasExisting: boolean }>}
     *   bookData — the model built from the archive; loadedBook — the book as
     *   it is on disk now (the kept existing one, or the freshly saved one).
     */
    async function importVbookArchive(req, buffer, options = {}) {
        const tag = options.tag || 'VBOOK-IMPORT';
        assertWired();
        let bookData;
        try {
            const files = book.extractBookBundle(buffer, { log });
            log(`[${tag}] vbook bundle loaded:`, Object.keys(files));
            bookData = book.buildBookFromBundle(files);
            const verdict = validateBundleObject(bookData);
            if (!verdict.valid) {
                return { ok: false, status: 400, body: { error: `Bundle validation failed: ${verdict.errors.slice(0, 5).join('; ')}`, code: 'invalid_bundle' } };
            }
        } catch (err) {
            const refusal = importRefusal(err, req, 422);
            log(`[${tag}] refused: ${refusal.body.code || refusal.body.error}`);
            return { ok: false, ...refusal };
        }

        const bookId = bookData.manifest.book_id;
        const buildId = bookData.manifest.build_id || 'default';

        // The copy already on the server, if any. A book that exists but is
        // not VBook 4 cannot be kept (it does not open) and is not silently
        // replaced either: 409, the owner deletes it first.
        let existingBook = null;
        let existingUnsupported = null;
        try {
            existingBook = book.loadBook(bookId);
        } catch (err) {
            if (!isUnsupportedVersionError(err)) throw err;
            existingUnsupported = err;
        }

        // Cross-workspace guard (authenticated): a bundle re-import must never
        // touch or reveal a book that belongs elsewhere — neither the disk copy
        // nor the ownership registry. Checked BEFORE anything is said about
        // the copy on disk.
        const check = await importBookAllowed(req, bookId, { diskCopyExists: !!existingBook || !!existingUnsupported });
        if (!check.allowed) {
            log(`[${tag}] Book ${bookId} import rejected (${check.error})`);
            return { ok: false, status: check.status, body: { error: check.error } };
        }
        if (existingUnsupported) {
            return { ok: false, ...importRefusal(existingUnsupported, req, 409) };
        }

        if (existingBook) {
            log(`[${tag}] Book ${bookId} already exists — keeping existing (edited) version`);
            return { ok: true, bookId, buildId, bookData, loadedBook: existingBook, wasExisting: true };
        }

        try {
            await book.resetBook(bookId);
            book.saveBookBundle(bookData);
        } catch (err) {
            const refusal = importRefusal(err, req, 422);
            log(`[${tag}] save refused: ${refusal.body.code || refusal.body.error}`);
            return { ok: false, ...refusal };
        }
        const loadedBook = book.loadBook(bookId);
        log(`[${tag}] Loaded book from disk: ${bookId}, chapters: ${loadedBook?.chapters?.length}`);
        return { ok: true, bookId, buildId, bookData, loadedBook, wasExisting: false };
    }

    return { importVbookArchive };
}

module.exports = { createVbookImporter, importRefusal, requestLanguage };
