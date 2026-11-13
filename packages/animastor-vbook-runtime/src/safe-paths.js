// ======================================================
// Input validation for on-disk paths (book ids, build ids, bundle entries)
// ======================================================
// Every value that becomes part of a filesystem path and may originate
// outside the server (URL, request body, bundle manifest, archive entry
// name) is checked here BEFORE any disk access, and every resolved path is
// re-checked to stay inside its root.

'use strict';

const path = require('path');

// Book ids: generated ids are `<slug>_<ms>` where the slug may contain Latin
// or Cyrillic letters (lazy-book/paths.js generateBookId); imported ids use
// the same alphabet. No dots, no separators.
const BOOK_ID_RE = /^[A-Za-z0-9Ѐ-ӿ][A-Za-z0-9Ѐ-ӿ_-]{0,159}$/u;

// Build ids: `build_<bookId>`, `default`, `demo_static_007`, … — conservative
// charset (dots allowed for historical ids, but never a `..` sequence).
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

const CHAPTER_FILE_RE = /^ch-[a-f0-9]{6,64}\.json$/;

class InvalidInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'InvalidInputError';
        this.code = code;
        this.status = 400;
    }
}

function isValidBookId(id) {
    return typeof id === 'string' && BOOK_ID_RE.test(id);
}

function isValidBuildId(id) {
    return typeof id === 'string' && BUILD_ID_RE.test(id) && !id.includes('..');
}

function assertBookId(id) {
    if (!isValidBookId(id)) throw new InvalidInputError('INVALID_BOOK_ID', 'invalid book id');
    return id;
}

function assertBuildId(id) {
    if (!isValidBuildId(id)) throw new InvalidInputError('INVALID_BUILD_ID', 'invalid build id');
    return id;
}

/** True when `target` is `root` itself or below it (after resolution). */
function isInside(root, target) {
    const r = path.resolve(root);
    const t = path.resolve(target);
    const rel = path.relative(r, t);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve `target` and require it to be inside `root`; returns the resolved path. */
function assertInside(root, target) {
    if (typeof root !== 'string' || !root || typeof target !== 'string' || !target) {
        throw new InvalidInputError('PATH_OUTSIDE_ROOT', 'path outside storage root');
    }
    if (!isInside(root, target)) {
        throw new InvalidInputError('PATH_OUTSIDE_ROOT', 'path outside storage root');
    }
    return path.resolve(target);
}

/** path.join(root, ...segments) that must stay strictly below `root`. */
function joinInside(root, ...segments) {
    for (const s of segments) {
        if (typeof s !== 'string' || s === '' || s.includes('\0')) {
            throw new InvalidInputError('PATH_OUTSIDE_ROOT', 'path outside storage root');
        }
    }
    const target = path.resolve(root, ...segments);
    if (target === path.resolve(root)) {
        throw new InvalidInputError('PATH_OUTSIDE_ROOT', 'path outside storage root');
    }
    return assertInside(root, target);
}

// ── .vbook (format 3.1) archive entries ─────────────────────────────────
const BUNDLE_ROOT_FILES = new Set([
    'manifest.json', 'book.json', 'bible.json', 'locations.json', 'voices.json',
    'characters.json', 'behavior.json', 'mentions.json', 'source.txt',
]);

const BUNDLE_LIMITS = Object.freeze({
    maxEntries: 2000,            // all entries incl. directories
    maxEntryBytes: 32 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
});

/** Names that are rejected outright (the whole archive is refused). */
function isUnsafeEntryName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 512) return true;
    if (name.includes('\0') || name.includes('\\')) return true;
    if (/[\x00-\x1f\x7f]/.test(name)) return true;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
    const parts = name.replace(/\/+$/, '').split('/');
    return parts.some((p) => p === '..' || p === '.' || p === '');
}

/** Whitelisted payload entries of format 3.1 (others are skipped, not written). */
function isAllowedBundleEntry(name) {
    if (BUNDLE_ROOT_FILES.has(name)) return true;
    if (name.startsWith('chapters/')) return CHAPTER_FILE_RE.test(name.slice('chapters/'.length));
    return CHAPTER_FILE_RE.test(name); // legacy: chapter files at the bundle root
}

function isChapterFileName(name) {
    return typeof name === 'string' && CHAPTER_FILE_RE.test(name);
}

// Server-side (object-mode) chapter files: any single safe path segment.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;
function isSafeChapterFile(name) {
    return typeof name === 'string' && SAFE_SEGMENT_RE.test(name);
}

module.exports = {
    BOOK_ID_RE, BUILD_ID_RE, CHAPTER_FILE_RE, BUNDLE_ROOT_FILES, BUNDLE_LIMITS,
    InvalidInputError,
    isValidBookId, isValidBuildId, assertBookId, assertBuildId,
    isInside, assertInside, joinInside,
    isUnsafeEntryName, isAllowedBundleEntry, isChapterFileName, isSafeChapterFile,
};
