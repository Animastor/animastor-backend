// ======================================================
// vbook-version — the ONE place that decides whether a book can be opened
// ======================================================
// VBook 4 is the only supported format; there is no migration from 3.1
// (VBOOK_FORMAT_V4 §1, §9). The loader, the draft loader, the importer and the
// host's restore of a saved book copy all call
// assertSupportedVbookVersion(manifest) and report the same
// typed error, which HTTP routes turn into one body:
//
//   { error: "unsupported_vbook_version", vbook_version: "3.1", supported: 4, message }
//
// Writers emit the integer 4. Readers accept 4, "4" and "4.x".

'use strict';

const SUPPORTED_VBOOK_VERSION = 4;
const SUPPORTED_RE = /^4(\.[0-9]+)?$/;

class BookModelError extends Error {
    /**
     * @param {string} code - stable machine-readable code
     *        (INVALID_BOOK_ID | INVALID_MODE | UNSUPPORTED_VBOOK_VERSION)
     * @param {string} message
     * @param {object} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BookModelError';
        this.code = code;
        Object.assign(this, details);
    }
}

/** The version exactly as the manifest states it, as a string; null when absent. */
function statedVersion(manifest) {
    const raw = manifest && typeof manifest === 'object' ? manifest.vbook_version : undefined;
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'number' || typeof raw === 'string') return String(raw);
    return JSON.stringify(raw);
}

function isSupportedVbookVersion(manifest) {
    const raw = manifest && typeof manifest === 'object' ? manifest.vbook_version : undefined;
    if (raw === SUPPORTED_VBOOK_VERSION) return true;
    return typeof raw === 'string' && SUPPORTED_RE.test(raw);
}

function isNewerVersion(version) {
    if (version === null) return false;
    const major = Number.parseInt(version, 10);
    return Number.isFinite(major) && major > SUPPORTED_VBOOK_VERSION;
}

const MESSAGES = {
    ru: {
        old: (v) => `Книга сохранена в формате VBook ${v}, который больше не поддерживается. Импортируйте исходный текст заново — книга будет создана в формате ${SUPPORTED_VBOOK_VERSION}.`,
        none: () => `Книга сохранена в формате VBook без номера версии, который не поддерживается. Импортируйте исходный текст заново — книга будет создана в формате ${SUPPORTED_VBOOK_VERSION}.`,
        newer: () => 'Книга создана более новой версией Animastor.',
    },
    en: {
        old: (v) => `This book is saved in VBook ${v}, which is no longer supported. Import the source text again — the book will be created in format ${SUPPORTED_VBOOK_VERSION}.`,
        none: () => `This book is saved in a VBook format without a version number, which is not supported. Import the source text again — the book will be created in format ${SUPPORTED_VBOOK_VERSION}.`,
        newer: () => 'This book was created by a newer version of Animastor.',
    },
};

/** @param {string|null} version  @param {string} [lang] 'ru' | 'en' (default 'en') */
function unsupportedVersionMessage(version, lang) {
    const set = MESSAGES[String(lang || '').toLowerCase().slice(0, 2)] || MESSAGES.en;
    if (version === null) return set.none();
    return isNewerVersion(version) ? set.newer() : set.old(version);
}

/**
 * @param {object} manifest  parsed manifest.json
 * @returns {object} the manifest
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION with
 *         { vbookVersion: string|null, supported: 4, newer: boolean }
 */
function assertSupportedVbookVersion(manifest) {
    if (isSupportedVbookVersion(manifest)) return manifest;
    const version = statedVersion(manifest);
    throw new BookModelError(
        'UNSUPPORTED_VBOOK_VERSION',
        unsupportedVersionMessage(version, 'en'),
        { vbookVersion: version, supported: SUPPORTED_VBOOK_VERSION, newer: isNewerVersion(version) },
    );
}

function isUnsupportedVersionError(err) {
    return !!err && err.code === 'UNSUPPORTED_VBOOK_VERSION';
}

/** The response body shared by import (422) and GET /book (409). */
function unsupportedVersionBody(err, lang) {
    const version = err && err.vbookVersion !== undefined ? err.vbookVersion : null;
    return {
        error: 'unsupported_vbook_version',
        vbook_version: version,
        supported: SUPPORTED_VBOOK_VERSION,
        message: unsupportedVersionMessage(version, lang),
    };
}

module.exports = {
    SUPPORTED_VBOOK_VERSION,
    BookModelError,
    isSupportedVbookVersion,
    assertSupportedVbookVersion,
    isUnsupportedVersionError,
    unsupportedVersionMessage,
    unsupportedVersionBody,
};
