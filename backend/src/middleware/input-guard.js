// ======================================================
// Input guard — ids that end up in filesystem paths
// ======================================================
// Book ids and build ids from the URL, query string or JSON body are checked
// against the storage grammar (@animastor/vbook-runtime/safe-paths) before
// any route runs. Invalid values get a plain 400 — no handler, no disk.

'use strict';

const { isValidBookId, isValidBuildId } = require('@animastor/vbook-runtime/safe-paths');
// Hero ids (VBOOK_FORMAT_V4 §4): ONE grammar — the runtime's canonical
// snake_case, up to 64 characters, one segment (no dot, no separator). It is
// the file name characters/<id>.json, so nothing else may reach a route.
const { isCanonicalHeroId, CANONICAL_ID_RE } = require('@animastor/vbook-runtime/heroes.cjs');

const BOOK_KEYS = ['bookId', 'book_id'];
const BUILD_KEYS = ['buildId', 'build_id'];

// Every other route parameter / id field may also reach a file name
// (artifact file names are built from the book, chapter and scene ids): it
// must be a single path segment — no separators, no NUL/control chars, no `..`.
const SEGMENT_PARAMS = ['chapterId', 'sceneId', 'iuId', 'unitId', 'characterId', 'locationId',
    'voiceId', 'name', 'id', 'jobId', 'workerId', 'endpointId', 'connectorId', 'ruleId'];

// Look ids are snake_case too (§4a.2) — the same canonical grammar, ≤ 64.
function isLookId(v) {
    return typeof v === 'string' && v.length <= 64 && CANONICAL_ID_RE.test(v);
}
const SEGMENT_FIELDS = ['chapter_id', 'scene_id', 'unit_id', 'iu_id', 'chapterId', 'sceneId', 'unitId', 'iuId'];

function isSafeSegment(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 200
        && !/[\/\\\x00-\x1f\x7f]/.test(v) && v !== '.' && !v.includes('..');
}

// Book-creation sub-paths of /api/v1/book/:bookId (not ids).
const CREATE_BOOK_SUBPATHS = new Set(['import', 'blank']);

const REJECT_CODES = { 'book id': 'invalid_book_id', 'build id': 'invalid_build_id', 'hero id': 'invalid_hero_id', 'look id': 'invalid_look_id', id: 'invalid_id' };
function reject(res, what) {
    return res.status(400).json({ error: `invalid ${what}`, code: REJECT_CODES[what] || 'invalid_id' });
}

function badValue(value, validator) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.some((v) => badValue(v, validator));
    return !(typeof value === 'string' && validator(value));
}

/** app.param handlers: every route param named bookId/book_id/buildId/build_id. */
function registerParamGuards(app) {
    for (const key of BOOK_KEYS) {
        app.param(key, (req, res, next, value) => {
            if (CREATE_BOOK_SUBPATHS.has(value)) return next();
            return isValidBookId(value) ? next() : reject(res, 'book id');
        });
    }
    for (const key of BUILD_KEYS) {
        app.param(key, (req, res, next, value) => (isValidBuildId(value) ? next() : reject(res, 'build id')));
    }
    for (const key of SEGMENT_PARAMS) {
        app.param(key, (req, res, next, value) => (isSafeSegment(value) ? next() : reject(res, 'id')));
    }
    app.param('heroId', (req, res, next, value) => (isCanonicalHeroId(value) ? next() : reject(res, 'hero id')));
    app.param('lookId', (req, res, next, value) => (isLookId(value) ? next() : reject(res, 'look id')));
}

/** Query string + JSON body ids (mounted after the body parser on /api/v1). */
function requestIdsGuard(req, res, next) {
    const sources = [req.query, req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null];
    for (const src of sources) {
        if (!src) continue;
        for (const k of BOOK_KEYS) if (badValue(src[k], isValidBookId)) return reject(res, 'book id');
        for (const k of BUILD_KEYS) if (badValue(src[k], isValidBuildId)) return reject(res, 'build id');
        for (const k of SEGMENT_FIELDS) if (badValue(src[k], isSafeSegment)) return reject(res, 'id');
    }
    return next();
}

/** Path-prefix guard for app.use('/…/:bookId', …) mounts (params of use() layers). */
function bookIdPathGuard(req, res, next) {
    const value = req.params && req.params.bookId;
    if (value === undefined || CREATE_BOOK_SUBPATHS.has(value)) return next();
    return isValidBookId(value) ? next() : reject(res, 'book id');
}

// Upload limits for book archives / text files (the archive itself is
// additionally limited in entry count and unpacked size by vbook-runtime).
const UPLOAD_LIMITS = Object.freeze({ fileSize: 64 * 1024 * 1024, files: 1, fields: 20, parts: 24 });

/**
 * multer single-file upload with limits; limit errors → 413/400, never 500.
 * `options.fileSize` lowers the file limit for a route (never raises it above
 * UPLOAD_LIMITS.fileSize). The file stays in memory (req.file.buffer).
 */
function singleUpload(field = 'file', options = {}) {
    const multer = require('multer');
    const fileSize = Number.isSafeInteger(options.fileSize) && options.fileSize > 0
        ? Math.min(options.fileSize, UPLOAD_LIMITS.fileSize) : UPLOAD_LIMITS.fileSize;
    const mw = multer({ limits: { ...UPLOAD_LIMITS, fileSize } }).single(field);
    return (req, res, next) => mw(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large', code: 'file_too_large' });
        return res.status(400).json({ error: 'invalid upload', code: 'invalid_upload' });
    });
}

/** Signed-in user required (no guest, no anonymous). */
function requireUser(req, res, next) {
    if (req.user) return next();
    return res.status(401).json({ error: 'Sign in required', code: 'login_required' });
}

module.exports = {
    CREATE_BOOK_SUBPATHS,
    registerParamGuards,
    requestIdsGuard,
    bookIdPathGuard,
    requireUser,
    isSafeSegment,
    isLookId,
    singleUpload,
    UPLOAD_LIMITS,
};
