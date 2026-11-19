// ======================================================
// VBook version gate — one 409 for a book of an unsupported format
// ======================================================
// VBOOK_FORMAT_V4 §9: a VBook 3.1 book (no version, or newer than 4) lying on
// the server does not open. GET /book answers 409 `unsupported_vbook_version`;
// the same body — byte for byte the one of GET /book and of the importer —
// is the answer of generation, analysis, the editor and the assistant for such
// a book. Only deleting the book is allowed (§9: "доступно только удаление").
//
// The gate reads manifest.json only (no chapters, no heroes). A book without a
// manifest is not this gate's business: the route answers 404 as before.

'use strict';

const { isUnsupportedVersionError, unsupportedVersionBody, assertSupportedVbookVersion } = require('@animastor/vbook-runtime/vbook-version.cjs');

function requestLanguage(req) {
    const header = req && req.headers ? req.headers['accept-language'] : '';
    return /^\s*ru/i.test(String(header || '')) ? 'ru' : 'en';
}

/**
 * The 409 body for a book id, or null when the book is absent or supported.
 * @param {(bookId: string) => object|null} getBookManifest
 */
function unsupportedBodyFor(getBookManifest, bookId, lang) {
    let manifest = null;
    try { manifest = getBookManifest(bookId); } catch (_) { manifest = null; }
    if (!manifest) return null;
    try {
        assertSupportedVbookVersion(manifest);
        return null;
    } catch (err) {
        if (isUnsupportedVersionError(err)) return unsupportedVersionBody(err, lang);
        throw err;
    }
}

/**
 * Gate for app.use('/api/v1/book/:bookId', …): every route of the book except
 * DELETE of the book itself.
 * @param {{ getBookManifest: Function, skip?: Set<string> }} deps
 */
function createBookVersionGate({ getBookManifest, skip = new Set() }) {
    if (typeof getBookManifest !== 'function') throw new Error('vbook-version-gate: getBookManifest is required');
    return function bookVersionGate(req, res, next) {
        const bookId = req.params && req.params.bookId;
        if (!bookId || skip.has(bookId)) return next();
        const isBookItself = req.path === '/' || req.path === '';
        if (req.method === 'DELETE' && isBookItself) return next();
        const body = unsupportedBodyFor(getBookManifest, bookId, requestLanguage(req));
        return body ? res.status(409).json(body) : next();
    };
}

/**
 * Gate for the assistant (/api/v1/ai): the book is the one the AI book guard
 * resolved (req.scopedBookId). Deleting a chat session stays allowed.
 */
function createScopedBookVersionGate({ getBookManifest }) {
    if (typeof getBookManifest !== 'function') throw new Error('vbook-version-gate: getBookManifest is required');
    return function scopedBookVersionGate(req, res, next) {
        const bookId = req.scopedBookId;
        if (!bookId || req.method === 'DELETE') return next();
        const body = unsupportedBodyFor(getBookManifest, bookId, requestLanguage(req));
        return body ? res.status(409).json(body) : next();
    };
}

module.exports = { createBookVersionGate, createScopedBookVersionGate, unsupportedBodyFor };
