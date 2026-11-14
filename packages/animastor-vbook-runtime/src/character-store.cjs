// ======================================================
// character-store — characters/ on disk (VBOOK_FORMAT_V4 §3, §4, §10)
// ======================================================
// One file per hero: <bookDir>/characters/<id>.json. The directory is the
// source of truth for the cast; book.json's characters_order is only a display
// hint. This module is the ONLY writer of hero files.
//
// Paths. A hero file path is built from a canonical hero id — one lower-case
// snake_case segment — and joined with joinInside, so it cannot leave
// characters/. Neither the directory nor a hero file may be a symbolic link:
// links are never followed, on read or on write.
//
// Writes are atomic (§10.1): temp file in the same directory → fsync → rename
// over the target → fsync of the directory (best effort). A crash before the
// rename leaves the previous file intact; point writes of different heroes
// touch different files and cannot overwrite each other.
//
// A broken hero file (§10.3) never hides the rest of the book and is never
// touched: listing returns the healthy heroes plus `issues`, and every write
// aimed at the id of a broken file is refused with `hero_file_broken`.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isCanonicalHeroId, isReservedHeroId, sortHeroes, NARRATOR_ID } = require('./heroes.cjs');
const { validateCharacterFile } = require('./character-validator.cjs');
const { joinInside } = require('./safe-paths');

const CHARACTER_DIR = 'characters';
const TMP_MARK = '.tmp-';
const STALE_TMP_MS = 60 * 60 * 1000;
const MAX_CHARACTER_FILE_BYTES = 4 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

class HeroStoreError extends Error {
    /**
     * @param {string} code  invalid_hero_id | reserved_id | invalid_character |
     *                       hero_file_broken | narrator_required | path_is_link
     * @param {string} message
     * @param {object} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'HeroStoreError';
        this.code = code;
        this.details = details;
    }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch (_) { return null; }
}

function charactersDir(bookDir) {
    return joinInside(bookDir, CHARACTER_DIR);
}

function assertHeroId(heroId) {
    if (!isCanonicalHeroId(heroId)) {
        throw new HeroStoreError('invalid_hero_id', `vbook: invalid hero id ${JSON.stringify(heroId)}`);
    }
    return heroId;
}

function characterFile(bookDir, heroId) {
    assertHeroId(heroId);
    return joinInside(charactersDir(bookDir), `${heroId}.json`);
}

// characters/ must be a real directory inside the book: a link here would
// redirect every hero read and write somewhere else.
function assertDirNotLink(dir) {
    const st = lstatOrNull(dir);
    if (st && st.isSymbolicLink()) {
        throw new HeroStoreError('path_is_link', 'vbook: characters directory is a symbolic link');
    }
    if (st && !st.isDirectory()) {
        throw new HeroStoreError('path_is_link', 'vbook: characters is not a directory');
    }
    return st;
}

/** The exact bytes a hero is stored as (also what "changed on disk?" compares). */
function serializeCharacter(hero) {
    return JSON.stringify(hero, null, 2);
}

// ── atomic write ─────────────────────────────────────────────────────────

/**
 * Write `data` to `file` atomically. The temp file lives in the same directory
 * (so the rename stays on one filesystem), is created exclusively and without
 * following links, and is removed when anything fails before the rename.
 * `io` is the fs surface; tests replace single calls to simulate a crash.
 */
function atomicWriteFile(file, data, io = fs) {
    const dir = path.dirname(file);
    io.mkdirSync(dir, { recursive: true });
    const target = lstatOrNull(file);
    if (target && !target.isFile()) {
        throw new HeroStoreError('path_is_link', `vbook: refusing to replace a non-regular file: ${path.basename(file)}`);
    }
    const tmp = path.join(
        dir,
        `.${path.basename(file)}${TMP_MARK}${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
    );
    let fd;
    try {
        fd = io.openSync(
            tmp,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
            0o666,
        );
        io.writeFileSync(fd, data);
        io.fsyncSync(fd);
        io.closeSync(fd);
        fd = undefined;
        io.renameSync(tmp, file);
    } catch (err) {
        if (fd !== undefined) { try { io.closeSync(fd); } catch (_) { /* already closed */ } }
        try { io.unlinkSync(tmp); } catch (_) { /* never created or already renamed */ }
        throw err;
    }
    // Make the rename itself durable. Not every filesystem allows fsync on a
    // directory, so a failure here does not undo a completed write.
    try {
        const dfd = io.openSync(dir, fs.constants.O_RDONLY);
        try { io.fsyncSync(dfd); } finally { io.closeSync(dfd); }
    } catch (_) { /* best effort */ }
}

function atomicWriteJson(file, value, io = fs) {
    atomicWriteFile(file, JSON.stringify(value, null, 2), io);
}

/** Remove leftover temp files older than an hour (§10.1). Never throws. */
function cleanStaleTempFiles(dir, now = Date.now()) {
    let removed = 0;
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return removed; }
    for (const name of names) {
        if (!name.startsWith('.') || !name.includes(TMP_MARK)) continue;
        const full = path.join(dir, name);
        const st = lstatOrNull(full);
        if (!st || !st.isFile() || now - st.mtimeMs < STALE_TMP_MS) continue;
        try { fs.unlinkSync(full); removed++; } catch (_) { /* raced with another cleanup */ }
    }
    return removed;
}

// ── reading ──────────────────────────────────────────────────────────────

function fileIdOf(name) {
    if (!name.endsWith('.json')) return null;
    const id = name.slice(0, -'.json'.length);
    return isCanonicalHeroId(id) ? id : null;
}

function issue(name, code, message, extra = {}) {
    const out = { file: `${CHARACTER_DIR}/${name}` };
    const heroId = fileIdOf(name);
    if (heroId) out.hero_id = heroId;
    return { ...out, code, message, blocking: true, ...extra };
}

/**
 * Read one entry of characters/.
 * @returns {{ hero: object, warnings: object[] } | { issue: object }}
 */
function readEntry(dir, name) {
    const full = path.join(dir, name);
    const st = lstatOrNull(full);
    if (!st) return { issue: issue(name, 'unreadable', 'file disappeared while reading') };
    if (st.isSymbolicLink()) return { issue: issue(name, 'unreadable', 'symbolic links are not followed') };
    if (!st.isFile()) return { issue: issue(name, 'unreadable', 'not a regular file') };
    if (!name.endsWith('.json')) {
        return { issue: issue(name, 'filename_mismatch', 'a hero file must be named <id>.json') };
    }
    if (st.size > MAX_CHARACTER_FILE_BYTES) {
        return { issue: issue(name, 'unreadable', `file is larger than ${MAX_CHARACTER_FILE_BYTES} bytes`) };
    }

    let raw;
    try {
        const fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW);
        try { raw = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    } catch (err) {
        return { issue: issue(name, 'unreadable', err.code || err.message) };
    }

    return parseCharacterText(name, raw);
}

/**
 * Read the cast of a book.
 * Order: the narrator first, then ids listed in `charactersOrder` (a hint —
 * unknown and missing ids are not an error), then the rest alphabetically.
 * Entries of characters/ starting with a dot are service files and skipped.
 *
 * @returns {{ heroes: object[], issues: object[] }} issues: {file, hero_id?,
 *          code, message, blocking}; blocking codes — unreadable | invalid_json |
 *          schema | filename_mismatch; non-blocking — unknown_key.
 */
function listCharacters(bookDir, options = {}) {
    const dir = charactersDir(bookDir);
    const heroes = [];
    const issues = [];
    const dirStat = lstatOrNull(dir);
    if (!dirStat) return { heroes, issues };
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        issues.push({
            file: CHARACTER_DIR, code: 'unreadable', blocking: true,
            message: dirStat.isSymbolicLink() ? 'symbolic links are not followed' : 'not a directory',
        });
        return { heroes, issues };
    }

    const names = fs.readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
    for (const name of names) {
        const entry = readEntry(dir, name);
        if (entry.issue) {
            issues.push(entry.issue);
        } else {
            heroes.push(entry.hero);
            issues.push(...entry.warnings);
        }
    }

    return { heroes: sortHeroes(heroes, options.charactersOrder), issues };
}

/**
 * State of one hero file without throwing:
 *   { state: 'absent' } | { state: 'ok', hero } | { state: 'broken', issue }
 */
function inspectCharacter(bookDir, heroId) {
    const file = characterFile(bookDir, heroId);
    const dir = path.dirname(file);
    const dirStat = lstatOrNull(dir);
    if (!dirStat) return { state: 'absent' };
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        return { state: 'broken', issue: { file: CHARACTER_DIR, code: 'unreadable', message: 'characters is not a real directory', blocking: true } };
    }
    if (!lstatOrNull(file)) return { state: 'absent' };
    const entry = readEntry(dir, path.basename(file));
    return entry.issue ? { state: 'broken', issue: entry.issue } : { state: 'ok', hero: entry.hero };
}

function brokenError(heroId, problem) {
    return new HeroStoreError(
        'hero_file_broken',
        `vbook: hero file ${CHARACTER_DIR}/${heroId}.json is broken (${problem.code}) — fix or delete it first`,
        { hero_id: heroId, issue: problem },
    );
}

/**
 * Read one hero.
 * @returns {object|null} null when the file does not exist
 * @throws {HeroStoreError} hero_file_broken when the file exists but is broken
 */
function readCharacter(bookDir, heroId) {
    const found = inspectCharacter(bookDir, heroId);
    if (found.state === 'absent') return null;
    if (found.state === 'broken') throw brokenError(heroId, found.issue);
    return found.hero;
}

// ── writing ──────────────────────────────────────────────────────────────

function assertWritable(bookDir, hero) {
    if (!isPlainObject(hero)) throw new HeroStoreError('invalid_character', 'vbook: character must be a JSON object');
    assertHeroId(hero.id);
    if (isReservedHeroId(hero.id)) {
        throw new HeroStoreError('reserved_id', `vbook: hero id "${hero.id}" is reserved`, { hero_id: hero.id });
    }
    const check = validateCharacterFile(hero, { filename: `${hero.id}.json` });
    if (!check.valid) {
        const message = check.errors.slice(0, 5)
            .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
            .join('; ');
        throw new HeroStoreError('invalid_character', `vbook: invalid character "${hero.id}": ${message}`,
            { hero_id: hero.id, errors: check.errors });
    }
    const found = inspectCharacter(bookDir, hero.id);
    if (found.state === 'broken') throw brokenError(hero.id, found.issue);
    return found;
}

/**
 * Create or replace one hero file. The hero is validated first; a broken file
 * under the same id is never overwritten.
 * @returns {object} the hero as written
 */
function writeCharacter(bookDir, hero, io = fs) {
    assertWritable(bookDir, hero);
    const file = characterFile(bookDir, hero.id);
    io.mkdirSync(path.dirname(file), { recursive: true });
    assertDirNotLink(path.dirname(file));
    atomicWriteFile(file, serializeCharacter(hero), io);
    return hero;
}

/**
 * Point update: read → mutate → validate → atomic write, synchronously (no
 * await between the read and the write). The mutator gets a private copy and
 * returns the next hero (or mutates the copy in place); the id cannot change.
 * @returns {object|null} the stored hero, or null when the hero does not exist
 * @throws {HeroStoreError} hero_file_broken | invalid_character
 */
function updateCharacter(bookDir, heroId, mutate, io = fs) {
    const current = readCharacter(bookDir, heroId);
    if (!current) return null;
    const draft = JSON.parse(JSON.stringify(current));
    const returned = typeof mutate === 'function' ? mutate(draft) : draft;
    const next = returned === undefined ? draft : returned;
    if (!isPlainObject(next)) throw new HeroStoreError('invalid_character', 'vbook: updateCharacter mutator must return an object');
    if (next.id !== heroId) throw new HeroStoreError('invalid_character', 'vbook: updateCharacter cannot change the hero id');
    writeCharacter(bookDir, next, io);
    return next;
}

/**
 * Delete a hero file.
 *  - the narrator cannot be deleted (narrator_required);
 *  - a broken file is deleted only with { broken: true } — the explicit way
 *    out of §10.3 — and that also applies to a broken narrator.json.
 * @returns {boolean} false when there was nothing to delete
 */
function removeCharacter(bookDir, heroId, options = {}) {
    const found = inspectCharacter(bookDir, heroId);
    if (found.state === 'absent') return false;
    if (found.state === 'broken') {
        if (!options.broken) throw brokenError(heroId, found.issue);
        if (found.issue.file === CHARACTER_DIR) throw brokenError(heroId, found.issue);
    } else if (heroId === NARRATOR_ID) {
        throw new HeroStoreError('narrator_required', 'vbook: the narrator cannot be deleted', { hero_id: heroId });
    }
    const file = characterFile(bookDir, heroId);
    const st = lstatOrNull(file);
    if (st && st.isDirectory()) throw brokenError(heroId, found.issue);
    fs.unlinkSync(file); // unlink removes a link itself, never its target
    return true;
}

/** Parse and validate hero-file text that did not come from characters/ (an archive entry). */
function parseCharacterText(name, raw) {
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (err) {
        return { issue: issue(name, 'invalid_json', err.message) };
    }
    const check = validateCharacterFile(doc, { filename: name });
    if (!check.valid) {
        const misnamedOnly = check.errors.every((e) => e.code === 'filename_mismatch');
        const message = check.errors.slice(0, 5)
            .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
            .join('; ');
        return { issue: issue(name, misnamedOnly ? 'filename_mismatch' : 'schema', message, { errors: check.errors }) };
    }
    const warnings = check.warnings.map((w) => ({
        file: `${CHARACTER_DIR}/${name}`,
        hero_id: doc.id,
        code: w.code,
        message: w.path ? `${w.path}: ${w.message}` : w.message,
        blocking: false,
    }));
    return { hero: doc, warnings };
}

module.exports = {
    CHARACTER_DIR,
    HeroStoreError,
    parseCharacterText,
    charactersDir,
    characterFile,
    serializeCharacter,
    atomicWriteFile,
    atomicWriteJson,
    cleanStaleTempFiles,
    listCharacters,
    inspectCharacter,
    readCharacter,
    writeCharacter,
    updateCharacter,
    removeCharacter,
};
