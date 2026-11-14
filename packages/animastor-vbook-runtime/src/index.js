// ======================================================
// Book Module — VBook 4
// ======================================================
// Handles book loading, saving, and bundle operations.
// NOT stateful - just pure file/book operations.
//
// Format (architecture/VBOOK_FORMAT_V4.md §3) — the same flat layout on disk
// and inside a .vbook archive, addressed by EXACT path:
//
//   /data/books/<bookId>/
//     manifest.json         vbook_version: 4
//     book.json             structure.chapters_order + structure.characters_order
//     bible.json            (optional)
//     locations.json        (optional)
//     behaviour.json        book-level behaviour: defaults + global rules (§6.3)
//     characters/
//       narrator.json       the narrator is a hero; created with the book
//       <id>.json           one file per hero — animastor.character/1 (§4)
//     chapters/
//       ch-XXXXXXXX.json    one per chapter; the cover is a regular chapter
//     source.txt            (optional) source text, needed to continue analysis
//
// In memory (§8.1):
//   { manifest, book, bible, locations, behaviour, heroes[], hero_issues[], chapters[] }
// There are no characters / voices / behaviors / mentions maps: readers use the
// helpers in ./heroes.cjs, ./looks.cjs and the voice port (./voice).
//
// VBook 3.1 is not readable and there is no migration (§9): every loader and
// the importer call assertSupportedVbookVersion and fail with
// BookModelError('UNSUPPORTED_VBOOK_VERSION').
//
// One serializer: bundleFilesFromBook(book) turns the model into the exact
// file set. saveBookBundle writes that set, exportBookBundle zips it — so
// export → import → export yields the same files.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const safePaths = require('./safe-paths');
const {
    InvalidInputError, BUNDLE_LIMITS, CHAPTERS_PREFIX, CHARACTERS_PREFIX,
    assertBookId, assertBuildId, isValidBookId, joinInside, assertInside,
    isUnsafeEntryName, classifyBundleEntry, isChapterFileName,
} = safePaths;

const {
    validateBundleFile, validateCharacterFile, validateBehaviourGlobals,
} = require('./bundle-validator.cjs');
const { emptyBehaviourGlobals } = require('./character-validator.cjs');
const vbookVersion = require('./vbook-version.cjs');
const { assertSupportedVbookVersion, BookModelError, SUPPORTED_VBOOK_VERSION } = vbookVersion;
const voice = require('./voice');
const looks = require('./looks.cjs');
const heroes = require('./heroes.cjs');
const characterStore = require('./character-store.cjs');
const { HeroStoreError } = characterStore;
const { getBooksRoot } = require('./books-root');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const MANIFEST_FILE = 'manifest.json';
const BOOK_FILE = 'book.json';
const BIBLE_FILE = 'bible.json';
const LOCATIONS_FILE = 'locations.json';
const BEHAVIOUR_FILE = 'behaviour.json';
const SOURCE_FILE = 'source.txt';

const toJson = (value) => JSON.stringify(value, null, 2);

// ======================================================
// PATH HELPERS
// ======================================================

function getBooksDir() {
    // booksRoot port: the host (composition root) supplies the filesystem
    // root; this module never reads host env/config directly.
    return getBooksRoot();
}

function getBookDir(bookId) {
    assertBookId(bookId);
    return joinInside(getBooksDir(), bookId);
}

function getBookPath(bookId) {
    assertBookId(bookId);
    return joinInside(getBooksDir(), `${bookId}.json`);
}

function getChapterDir(bookDir) {
    return joinInside(bookDir, 'chapters');
}

// ======================================================
// VALIDATION BEFORE WRITE
// ======================================================

function heroProblemList(issues) {
    return issues.map((i) => `${i.file} (${i.code})`).join(', ');
}

// Last line of defense before disk: everything saveBookBundle is about to
// write must satisfy the format. A failure THROWS before the FIRST write —
// the previous valid state on disk stays untouched and callers report the
// error instead of a successful save.
function assertBundleFilesWritable(book, bookDir) {
    assertSupportedVbookVersion(book.manifest);
    const candidates = [
        [MANIFEST_FILE, book.manifest],
        [BOOK_FILE, book.book ?? {}],
        [BIBLE_FILE, book.bible],
        [LOCATIONS_FILE, book.locations],
        [BEHAVIOUR_FILE, book.behaviour],
    ];
    for (const [filename, data] of candidates) {
        if (data === undefined || data === null) continue;
        const check = validateBundleFile(filename, data);
        if (!check.valid) {
            throw new Error(`Bundle validation failed (${filename}): ${check.errors.join('; ')}`);
        }
    }
    for (const key of ['characters', 'voices', 'behaviors', 'mentions']) {
        if (book[key] !== undefined) {
            throw new Error(`Bundle validation failed: book.${key} is not part of VBook 4 — heroes live in book.heroes`);
        }
    }

    if (book.heroes !== undefined) {
        if (!Array.isArray(book.heroes)) {
            throw new Error('Bundle validation failed (heroes): must be an array');
        }
        const seen = new Set();
        for (const hero of book.heroes) {
            const id = isPlainObject(hero) ? hero.id : undefined;
            if (!heroes.isCanonicalHeroId(id)) {
                throw new Error(`Bundle validation failed (heroes): invalid hero id ${JSON.stringify(id)}`);
            }
            const filename = `${CHARACTERS_PREFIX}${id}.json`;
            const check = validateBundleFile(filename, hero);
            if (!check.valid) {
                throw new Error(`Bundle validation failed (${filename}): ${check.errors.join('; ')}`);
            }
            if (seen.has(id)) {
                throw new Error(`Bundle validation failed (${filename}): duplicate hero id`);
            }
            seen.add(id);
            // A broken file under this id is never overwritten (§10.3).
            if (bookDir) {
                const found = characterStore.inspectCharacter(bookDir, id);
                if (found.state === 'broken') {
                    throw new HeroStoreError('hero_file_broken',
                        `Bundle validation failed (${filename}): the file on disk is broken (${found.issue.code}) — fix or delete it first`,
                        { hero_id: id, issues: [found.issue] });
                }
            }
        }
    }

    if (Array.isArray(book.chapters)) {
        for (let i = 0; i < book.chapters.length; i++) {
            const chapter = book.chapters[i];
            const label = `chapters/${chapter?.chapter_id ?? i}.json`;
            if (chapter === null || typeof chapter !== 'object' || Array.isArray(chapter)) {
                throw new Error(`Bundle validation failed (${label}): chapter must be an object`);
            }
            const check = validateBundleFile('chapter.json', chapter);
            if (!check.valid) {
                throw new Error(`Bundle validation failed (${label}): ${check.errors.join('; ')}`);
            }
            if (!safePaths.isSafeChapterFile(`${chapter.chapter_id}.json`)) {
                throw new InvalidInputError('INVALID_BUNDLE', 'invalid chapter id');
            }
        }
    }
}

// ======================================================
// BOOK BUNDLE OPERATIONS (.vbook archive)
// ======================================================

/**
 * List archive entries WITHOUT decompressing anything: names, sizes, flags.
 * Throws InvalidInputError for archives that must be refused as a whole
 * (unsafe names, symlinks, encryption, duplicates, size/count limits).
 * @param {Buffer} buffer
 * @returns {{ zip: AdmZip, entries: object[], payload: object[], skipped: number,
 *             skippedNames: string[], badCharacters: string[], hasRootManifest: boolean }}
 *          payload — whitelisted format-4 entries; badCharacters — entries below
 *          characters/ that are not a hero file (the importer refuses them)
 */
function inspectBookBundle(buffer, limits = BUNDLE_LIMITS) {
    let zip;
    try {
        zip = new AdmZip(buffer);
    } catch (_) {
        throw new InvalidInputError('INVALID_ARCHIVE', 'invalid archive');
    }
    const entries = zip.getEntries();
    if (entries.length > limits.maxEntries) {
        throw new InvalidInputError('ARCHIVE_TOO_MANY_ENTRIES', 'archive has too many entries');
    }
    const seen = new Set();
    const payload = [];
    const skippedNames = [];
    const badCharacters = [];
    let total = 0;
    for (const entry of entries) {
        const name = entry.entryName;
        if (isUnsafeEntryName(name)) {
            throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'archive contains an invalid entry name');
        }
        const mode = ((entry.header && entry.header.attr) >>> 16) & 0o170000;
        if (mode === 0o120000) {
            throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'archive contains a link entry');
        }
        if (entry.header && (entry.header.flags & 0x1)) {
            throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'archive contains an encrypted entry');
        }
        const key = name.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) {
            throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'archive contains duplicate entries');
        }
        seen.add(key);
        if (entry.isDirectory) continue;
        const kind = classifyBundleEntry(name);
        if (kind === 'bad_character') { badCharacters.push(name); continue; }
        if (kind === null) { skippedNames.push(name); continue; }
        const size = entry.header ? entry.header.size : 0;
        if (!(size >= 0) || size > limits.maxEntryBytes) {
            throw new InvalidInputError('ARCHIVE_TOO_LARGE', 'archive entry too large');
        }
        total += size;
        if (total > limits.maxTotalBytes) {
            throw new InvalidInputError('ARCHIVE_TOO_LARGE', 'archive too large');
        }
        payload.push(entry);
    }
    return {
        zip, entries, payload,
        skipped: skippedNames.length,
        skippedNames,
        badCharacters,
        hasRootManifest: payload.some((e) => e.entryName === MANIFEST_FILE),
    };
}

/** Decompress one entry with a hard output cap (declared sizes can lie). */
function readEntryCapped(entry, cap) {
    const method = entry.header ? entry.header.method : -1;
    const raw = entry.getCompressedData();
    let out;
    if (method === 0) {
        out = raw;
    } else if (method === 8) {
        try {
            out = zlib.inflateRawSync(raw, { maxOutputLength: cap + 1 });
        } catch (_) {
            throw new InvalidInputError('ARCHIVE_TOO_LARGE', 'archive entry too large or corrupt');
        }
    } else {
        throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'unsupported archive compression');
    }
    if (out.length > cap) {
        throw new InvalidInputError('ARCHIVE_TOO_LARGE', 'archive entry too large');
    }
    return out;
}

function manifestNotInRoot() {
    return new InvalidInputError('MANIFEST_NOT_IN_ROOT',
        'manifest.json must be in the archive root (a .vbook has no top-level folder)');
}

function brokenHeroesError(issues) {
    return new InvalidInputError('HERO_FILE_BROKEN',
        `broken hero file${issues.length === 1 ? '' : 's'}: ${heroProblemList(issues)}`,
        { status: 422, issues });
}

/**
 * Extract a .vbook archive into { <exact path>: <text> }.
 * Only whitelisted format-4 entries are returned; other entries are skipped
 * (counted, never written). Refused as a whole: unsafe archives, an archive
 * without manifest.json in its root (MANIFEST_NOT_IN_ROOT) and an archive with
 * something below characters/ that is not a hero file (HERO_FILE_BROKEN).
 * @param {Buffer} buffer - The zipped bundle buffer
 * @param {object} [opts] - { log?: (msg) => void, limits? }
 * @returns {Object} file contents keyed by exact archive path
 */
function extractBookBundle(buffer, opts = {}) {
    const limits = opts.limits || BUNDLE_LIMITS;
    const { payload, skipped, badCharacters, hasRootManifest } = inspectBookBundle(buffer, limits);
    if (!hasRootManifest) throw manifestNotInRoot();
    const files = {};
    let total = 0;
    for (const entry of payload) {
        const data = readEntryCapped(entry, limits.maxEntryBytes);
        total += data.length;
        if (total > limits.maxTotalBytes) {
            throw new InvalidInputError('ARCHIVE_TOO_LARGE', 'archive too large');
        }
        files[entry.entryName] = data.toString('utf8');
    }
    if (badCharacters.length > 0) {
        // Version first: a 3.1 archive must be told "unsupported version", not
        // "broken hero file", whatever else it carries.
        assertSupportedVbookVersion(parseManifest(files));
        throw brokenHeroesError(badCharacters.map((name) => ({
            file: name, code: 'filename_mismatch', message: 'a hero file must be named characters/<id>.json', blocking: true,
        })));
    }
    if (skipped > 0) {
        const log = typeof opts.log === 'function' ? opts.log : console.warn;
        log(`[VBOOK] ${skipped} archive entr${skipped === 1 ? 'y' : 'ies'} outside the bundle format skipped`);
    }
    return files;
}

function parseJsonFile(files, name) {
    try {
        return JSON.parse(files[name]);
    } catch {
        throw new Error(`Invalid JSON in ${name}`);
    }
}

function parseManifest(files) {
    if (typeof files[MANIFEST_FILE] !== 'string') throw manifestNotInRoot();
    const manifest = parseJsonFile(files, MANIFEST_FILE);
    if (!isPlainObject(manifest)) throw new Error('manifest.json must contain a JSON object');
    return manifest;
}

// CANONICAL ID VALIDATION — format: sc-XXXXXXXX, ch-XXXXXXXX, iu-XXXXXXXX
function assertCanonicalIds(chapters) {
    for (const chapter of chapters) {
        const cid = chapter && chapter.chapter_id;
        if (!cid || !/^ch-[a-f0-9]{6,}$/.test(cid)) {
            throw new Error("Invalid chapter_id: " + cid + " (expected: ch-XXXXXXXX)");
        }
        if (!chapter.scenes) continue;
        for (const scene of chapter.scenes) {
            const sid = scene && scene.scene_id;
            if (!sid || !/^sc-[a-f0-9]{6,}$/.test(sid)) {
                throw new Error("Invalid scene_id: " + sid + " (expected: sc-XXXXXXXX)");
            }
            for (const unit of collectSceneUnits(scene)) {
                if (!unit.id || !/^iu-[a-f0-9]{6,}$/.test(unit.id)) {
                    throw new Error("Invalid unit_id: " + unit.id + " (expected: iu-XXXXXXXX)");
                }
            }
        }
    }
}

/**
 * Build the in-memory book from extracted archive files.
 * Exact paths only: files are never searched by suffix or under a prefix.
 * @param {Object} files - { <exact path>: <text> } from extractBookBundle
 * @returns {Object} { manifest, book, bible, locations, behaviour, heroes,
 *                     hero_issues, chapters, sourceText? }
 * @throws {InvalidInputError} MANIFEST_NOT_IN_ROOT | INVALID_BOOK_ID | INVALID_BUNDLE |
 *                             HERO_FILE_BROKEN (status 422, .issues)
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION (3.1, no version, newer)
 */
function buildBookFromBundle(files) {
    if (!isPlainObject(files)) throw manifestNotInRoot();
    const keys = Object.keys(files);

    const manifest = parseManifest(files);
    if (!manifest.book_id) {
        throw new Error("manifest.book_id missing");
    }
    assertBookId(manifest.book_id);
    if (manifest.build_id !== undefined && manifest.build_id !== null) {
        assertBuildId(manifest.build_id);
    }
    assertSupportedVbookVersion(manifest);

    if (typeof files[BOOK_FILE] !== 'string') {
        throw new Error("book.json not found. Files: " + keys.join(", "));
    }
    const parsedBook = parseJsonFile(files, BOOK_FILE);
    if (!parsedBook || !parsedBook.structure?.chapters_order) {
        throw new Error("book.structure.chapters_order missing");
    }
    if (!Array.isArray(parsedBook.structure.chapters_order)) {
        throw new Error("book.structure.chapters_order must be an array");
    }

    let bible = {};
    if (typeof files[BIBLE_FILE] === 'string') {
        bible = parseJsonFile(files, BIBLE_FILE);
        if (!isPlainObject(bible)) throw new Error('bible.json must contain a JSON object');
    }
    let locations = {};
    if (typeof files[LOCATIONS_FILE] === 'string') {
        locations = parseJsonFile(files, LOCATIONS_FILE);
        if (!isPlainObject(locations)) throw new Error('locations.json must contain a JSON object');
    }

    let behaviour = emptyBehaviourGlobals();
    if (typeof files[BEHAVIOUR_FILE] === 'string') {
        behaviour = parseJsonFile(files, BEHAVIOUR_FILE);
        const check = validateBehaviourGlobals(behaviour);
        if (!check.valid) {
            throw new InvalidInputError('INVALID_BUNDLE',
                `behaviour.json: ${check.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`);
        }
    }

    // Heroes: one file each. An archive with a broken hero file is refused
    // as a whole — import is an explicit act on a file that can be fixed.
    const heroList = [];
    const heroWarnings = [];
    const broken = [];
    for (const key of keys.filter((k) => k.startsWith(CHARACTERS_PREFIX)).sort()) {
        if (classifyBundleEntry(key) !== 'character') {
            if (classifyBundleEntry(key) === 'bad_character') {
                broken.push({ file: key, code: 'filename_mismatch', message: 'a hero file must be named characters/<id>.json', blocking: true });
            }
            continue;
        }
        const entry = characterStore.parseCharacterText(key.slice(CHARACTERS_PREFIX.length), files[key]);
        if (entry.issue) broken.push(entry.issue);
        else { heroList.push(entry.hero); heroWarnings.push(...entry.warnings); }
    }
    if (broken.length > 0) throw brokenHeroesError(broken);

    const chapters = parsedBook.structure.chapters_order.map(file => {
        if (!isChapterFileName(file)) {
            throw new InvalidInputError("INVALID_BUNDLE", "invalid chapter file name in chapters_order");
        }
        const key = CHAPTERS_PREFIX + file;
        if (typeof files[key] !== 'string') {
            throw new Error("Missing chapter file: " + key);
        }
        return parseJsonFile(files, key);
    });
    if (!chapters.length) {
        throw new Error("No chapters loaded");
    }
    assertCanonicalIds(chapters);

    const book = {
        manifest,
        book: parsedBook,
        bible,
        locations,
        behaviour,
        heroes: heroes.sortHeroes(heroList, parsedBook.structure.characters_order),
        hero_issues: [],
        chapters,
    };
    book.hero_issues = [...heroWarnings, ...heroes.collectBookHeroIssues(book)];
    if (typeof files[SOURCE_FILE] === 'string') book.sourceText = files[SOURCE_FILE];
    return book;
}

// ======================================================
// THE ONE SERIALIZER: model → exact file set
// ======================================================

/**
 * The canonical files of a book: { <exact path>: <text> }, in archive order.
 * Used by saveBookBundle (what gets written) and exportBookBundle (what gets
 * zipped). Rules:
 *  - manifest.vbook_version "4" is written as the integer 4;
 *  - book.json: chapters_order follows book.chapters (when there are any) and
 *    characters_order follows book.heroes (when heroes are given);
 *  - bible.json is written without `locations`, and neither bible.json nor
 *    locations.json is written when empty;
 *  - behaviour.json and one characters/<id>.json per hero;
 *  - hero_issues is never written.
 * @param {Object} book
 * @param {{ bookMeta?: object }} [options] bookMeta — a prepared copy of book.json
 */
function bundleFilesFromBook(book, options = {}) {
    const files = {};

    const manifest = { ...book.manifest };
    if (manifest.vbook_version === String(SUPPORTED_VBOOK_VERSION)) manifest.vbook_version = SUPPORTED_VBOOK_VERSION;
    files[MANIFEST_FILE] = toJson(manifest);

    const bookMeta = options.bookMeta
        ? options.bookMeta
        : (book.book ? JSON.parse(JSON.stringify(book.book)) : {});
    if (!isPlainObject(bookMeta.structure)) bookMeta.structure = {};
    // ⚠️ Only overwrite chapters_order when book.chapters is non-empty.
    // Lazy books keep chapters as files on disk; a save with an empty chapters
    // array (e.g. from a stale GET response) would otherwise destroy the
    // existing chapters_order and make all chapters invisible.
    const chapterFilenames = (book.chapters || []).map(ch => `${ch.chapter_id}.json`);
    if (chapterFilenames.length > 0) bookMeta.structure.chapters_order = chapterFilenames;
    if (Array.isArray(book.heroes)) bookMeta.structure.characters_order = book.heroes.map((h) => h.id);
    files[BOOK_FILE] = toJson(bookMeta);

    if (book.bible && Object.keys(book.bible).length > 0) {
        const { locations: _bibleLocs, ...bibleWithoutLocations } = book.bible;
        files[BIBLE_FILE] = toJson(bibleWithoutLocations);
    }
    if (book.locations && Object.keys(book.locations).length > 0) {
        files[LOCATIONS_FILE] = toJson(book.locations);
    }
    files[BEHAVIOUR_FILE] = toJson(isPlainObject(book.behaviour) ? book.behaviour : emptyBehaviourGlobals());

    for (const hero of Array.isArray(book.heroes) ? book.heroes : []) {
        files[`${CHARACTERS_PREFIX}${hero.id}.json`] = characterStore.serializeCharacter(hero);
    }
    for (const chapter of book.chapters || []) {
        files[`${CHAPTERS_PREFIX}${chapter.chapter_id}.json`] = toJson(chapter);
    }
    if (typeof book.sourceText === 'string') files[SOURCE_FILE] = book.sourceText;
    return files;
}

// ======================================================
// BOOK PERSISTENCE
// ======================================================

function readTextNoFollow(file) {
    const st = lstatOrNull(file);
    if (!st || !st.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
}

function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch (_) { return null; }
}

/**
 * Save the book to disk. Object path only: the model is validated as a whole
 * BEFORE the first write, then written through the one serializer.
 *
 *  - manifest.json, book.json, bible.json, locations.json and behaviour.json
 *    are written atomically (temp file → fsync → rename);
 *  - heroes go through the character store: a hero file is written only when
 *    its serialization differs from disk, and removed only when it reads
 *    successfully and its id is not in book.heroes. The narrator's file and
 *    broken files are never removed here;
 *  - `book.heroes === undefined` leaves the cast on disk untouched;
 *  - source.txt is written only when book.sourceText is a string, never removed.
 *
 * @param {Object} book - { manifest, book, bible, locations, behaviour, heroes, chapters }
 */
function saveBookBundle(book, ...rest) {
    if (rest.length > 0 && rest[0] !== undefined && rest[0] !== null) {
        // The raw-files mode of 3.1 wrote archive entries to disk verbatim.
        throw new Error('saveBookBundle(book, files) is gone: VBook 4 saves the book object only');
    }
    const bookId = book.manifest?.book_id;
    if (!bookId) {
        throw new Error('Book ID not found in manifest');
    }

    const booksDir = getBooksDir();
    const bookDir = getBookDir(bookId);
    assertNotLink(bookDir);

    // Validate the complete bundle BEFORE the first write (validate → write,
    // never write → discover).
    assertBundleFilesWritable(book, bookDir);

    if (!fs.existsSync(booksDir)) {
        fs.mkdirSync(booksDir, { recursive: true });
    }
    if (!fs.existsSync(bookDir)) {
        fs.mkdirSync(bookDir, { recursive: true });
    }
    const charactersDir = characterStore.charactersDir(bookDir);
    assertNotLink(charactersDir);
    characterStore.cleanStaleTempFiles(bookDir);
    characterStore.cleanStaleTempFiles(charactersDir);

    console.log(`[SAVE] Book: ${bookId}, chapters: ${book.chapters?.length}`);

    // Кирпич №2 (Persistent Layer Configuration): durable layer_config живёт в
    // book.json. Редактор может перезаписать book.json из объекта без этого
    // поля (например, закешированного до последнего PUT layer-config) — не
    // даём durable-копии потеряться при перезаписи.
    const bookMeta = book.book ? JSON.parse(JSON.stringify(book.book)) : {};
    if (!bookMeta.layer_config) {
        try {
            const onDiskText = readTextNoFollow(joinInside(bookDir, BOOK_FILE));
            const onDisk = onDiskText ? JSON.parse(onDiskText) : null;
            if (onDisk && onDisk.layer_config && typeof onDisk.layer_config === 'object') {
                bookMeta.layer_config = onDisk.layer_config;
            }
        } catch (_) { /* best-effort */ }
    }

    const files = bundleFilesFromBook(book, { bookMeta });
    const writeRoot = (name) => {
        const target = joinInside(bookDir, name);
        if (files[name] !== undefined) {
            characterStore.atomicWriteFile(target, files[name]);
        } else if ((name === BIBLE_FILE || name === LOCATIONS_FILE) && lstatOrNull(target)) {
            assertNotLink(target);
            fs.unlinkSync(target);
        }
    };
    writeRoot(MANIFEST_FILE);
    writeRoot(BOOK_FILE);
    writeRoot(BIBLE_FILE);
    writeRoot(LOCATIONS_FILE);
    // behaviour.json: an explicit value is written; without one the file on
    // disk stays, and a missing file is created so a book always has it.
    if (isPlainObject(book.behaviour) || !lstatOrNull(joinInside(bookDir, BEHAVIOUR_FILE))) {
        writeRoot(BEHAVIOUR_FILE);
    }
    if (files[SOURCE_FILE] !== undefined) {
        const target = joinInside(bookDir, SOURCE_FILE);
        if (readTextNoFollow(target) !== files[SOURCE_FILE]) {
            characterStore.atomicWriteFile(target, files[SOURCE_FILE]);
        }
    }

    // Heroes — only through the character store.
    if (Array.isArray(book.heroes)) {
        const wanted = new Set();
        for (const hero of book.heroes) {
            wanted.add(hero.id);
            const onDisk = readTextNoFollow(characterStore.characterFile(bookDir, hero.id));
            if (onDisk !== characterStore.serializeCharacter(hero)) {
                characterStore.writeCharacter(bookDir, hero);
            }
        }
        for (const onDisk of characterStore.listCharacters(bookDir).heroes) {
            if (wanted.has(onDisk.id) || onDisk.id === heroes.NARRATOR_ID) continue;
            characterStore.removeCharacter(bookDir, onDisk.id);
        }
    }

    // Chapters
    const chaptersDir = getChapterDir(bookDir);
    assertNotLink(chaptersDir);
    if (!fs.existsSync(chaptersDir)) {
        fs.mkdirSync(chaptersDir, { recursive: true });
    }

    const activeChapterFiles = new Set();
    for (const chapter of book.chapters || []) {
        const chapterFile = `${chapter.chapter_id}.json`;
        activeChapterFiles.add(chapterFile);
        const target = joinInside(chaptersDir, chapterFile);
        assertNotLink(target);
        fs.writeFileSync(target, files[`${CHAPTERS_PREFIX}${chapterFile}`]);
    }

    // Clean up orphaned chapter files — ONLY when we have a known chapter list.
    // If chapters array is empty (e.g. from a stale/corrupted load), we don't know
    // which files belong, so NEVER delete anything to avoid data loss.
    if (activeChapterFiles.size > 0) {
        try {
            const existingFiles = fs.readdirSync(chaptersDir);
            for (const f of existingFiles) {
                if (!activeChapterFiles.has(f)) {
                    const fp = path.join(chaptersDir, f);
                    if (fs.lstatSync(fp).isFile()) {
                        fs.unlinkSync(fp);
                    }
                }
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Load book from disk.
 * @param {string} bookId - The book ID to load
 * @returns {Object|null} { manifest, book, bible, locations, behaviour, heroes,
 *          hero_issues, chapters }; null ONLY when there is no such book (or it
 *          cannot be read at all)
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION — the book exists but is
 *         VBook 3.1, has no version or was written by a newer Animastor
 */
function loadBook(bookId) {
    if (!isValidBookId(bookId)) return null;
    const bookDir = getBookDir(bookId);
    const bookPath = getBookPath(bookId);

    const dirStat = lstatOrNull(bookDir);
    if (dirStat && dirStat.isDirectory()) {
        return loadBookFromDir(bookId, bookDir);
    }

    // Pre-3.1 single-file books (<bookId>.json): never VBook 4.
    const fileStat = lstatOrNull(bookPath);
    if (fileStat && fileStat.isFile()) {
        let legacy = null;
        try {
            legacy = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
        } catch (err) {
            console.error(`Failed to load book ${bookId}:`, err.message);
            return null;
        }
        assertSupportedVbookVersion(legacy && legacy.manifest);
        return null;
    }

    return null;
}

/**
 * Read manifest.json + book.json of a book directory and check the version.
 * @returns {{ manifest: object, bookMeta: object }|null} null when either file is absent
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION
 */
function readBookHead(bookDir) {
    const manifestText = readTextNoFollow(joinInside(bookDir, MANIFEST_FILE));
    const bookMetaText = readTextNoFollow(joinInside(bookDir, BOOK_FILE));
    if (manifestText === null || bookMetaText === null) return null;
    const manifest = JSON.parse(manifestText);
    assertSupportedVbookVersion(manifest);
    return { manifest, bookMeta: JSON.parse(bookMetaText) };
}

/**
 * Read the parts of a book that the full loader and the draft loader share:
 * bible, locations, behaviour and the cast (heroes + hero_issues).
 */
function readBookBody(bookDir, bookMeta) {
    const readObject = (name, fallback) => {
        const text = readTextNoFollow(joinInside(bookDir, name));
        return text === null ? fallback : JSON.parse(text);
    };
    const bible = readObject(BIBLE_FILE, {});
    const locations = readObject(LOCATIONS_FILE, {});
    const behaviour = readObject(BEHAVIOUR_FILE, null) ?? emptyBehaviourGlobals();
    const behaviourCheck = validateBehaviourGlobals(behaviour);
    if (!behaviourCheck.valid) {
        throw new Error(`behaviour.json: ${behaviourCheck.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`);
    }

    const cast = characterStore.listCharacters(bookDir, {
        charactersOrder: bookMeta && bookMeta.structure ? bookMeta.structure.characters_order : null,
    });
    const body = { bible, locations, behaviour, heroes: cast.heroes, hero_issues: [] };
    body.hero_issues = [...cast.issues, ...heroes.collectBookHeroIssues(body)];
    for (const problem of cast.issues) {
        if (problem.blocking) console.warn(`[VBOOK] broken hero file ${problem.file}: ${problem.code} — ${problem.message}`);
    }
    return body;
}

/**
 * Load book from its directory.
 * @param {string} bookId
 * @param {string} bookDir
 * @returns {Object|null}
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION
 */
function loadBookFromDir(bookId, bookDir) {
    try {
        const head = readBookHead(bookDir);
        if (!head) return null;
        const { manifest, bookMeta } = head;
        const body = readBookBody(bookDir, bookMeta);

        // Chapters: exact files chapters/<name> listed in chapters_order.
        const chaptersDir = getChapterDir(bookDir);
        const chapters = [];
        const chaptersOrder = bookMeta.structure?.chapters_order || [];
        for (const chapterFile of chaptersOrder) {
            if (!safePaths.isSafeChapterFile(chapterFile)) continue;
            const text = readTextNoFollow(joinInside(chaptersDir, chapterFile));
            if (text !== null) chapters.push(JSON.parse(text));
        }

        return {
            manifest,
            book: bookMeta,
            bible: body.bible,
            locations: body.locations,
            behaviour: body.behaviour,
            heroes: body.heroes,
            hero_issues: body.hero_issues,
            chapters,
        };
    } catch (err) {
        if (err instanceof BookModelError) throw err;
        console.error(`Failed to load book from dir ${bookId}:`, err.message);
        return null;
    }
}

/**
 * Export a book as a .vbook archive — by the format whitelist, through the
 * same serializer as saveBookBundle (never "the directory as it is").
 * @param {string} bookId
 * @param {{ skipBroken?: boolean }} [options]
 * @returns {{ buffer: Buffer, files: string[], skipped: object[] }|null} null when there is no such book
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION
 * @throws {HeroStoreError} hero_file_broken (.details.issues) unless skipBroken
 */
function exportBookBundle(bookId, options = {}) {
    const book = loadBook(bookId);
    if (!book) return null;
    const broken = book.hero_issues.filter((i) => i.blocking && i.file && i.code !== 'narrator_missing');
    if (broken.length > 0 && !options.skipBroken) {
        throw new HeroStoreError('hero_file_broken',
            `broken hero file${broken.length === 1 ? '' : 's'}: ${heroProblemList(broken)}`,
            { issues: broken });
    }
    const sourceText = readTextNoFollow(joinInside(getBookDir(bookId), SOURCE_FILE));
    const files = bundleFilesFromBook(sourceText === null ? book : { ...book, sourceText });
    const zip = new AdmZip();
    for (const [name, text] of Object.entries(files)) {
        zip.addFile(name, Buffer.from(text, 'utf8'));
    }
    return { buffer: zip.toBuffer(), files: Object.keys(files), skipped: broken };
}

/** Refuse to operate on a symlink (lstat, does not follow). */
function assertNotLink(p) {
    let st = null;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.isSymbolicLink()) {
        throw new InvalidInputError('PATH_IS_LINK', 'refusing to use a linked path');
    }
}

const BOOK_DIR_MARKERS = ['manifest.json', 'book.json', 'source.txt', 'chapters', 'characters'];

/**
 * Reset book (delete from disk).
 * Only a validated book id, only a directory strictly inside the books root
 * that carries book markers; never a symlink. A non-book directory under that
 * name is refused (throws) instead of being removed.
 * @param {string} bookId - The book ID to delete
 */
async function resetBook(bookId) {
    const booksDir = getBooksDir();
    const bookDir = getBookDir(bookId);          // asserts id + containment
    const bookPath = getBookPath(bookId);

    let st = null;
    try { st = fs.lstatSync(bookDir); } catch (_) { st = null; }
    if (st) {
        if (st.isSymbolicLink()) {
            throw new InvalidInputError('PATH_IS_LINK', 'refusing to remove a linked path');
        }
        if (st.isDirectory()) {
            assertInside(booksDir, bookDir);
            if (path.resolve(bookDir) === path.resolve(booksDir)) {
                throw new InvalidInputError('PATH_OUTSIDE_ROOT', 'path outside storage root');
            }
            const entries = fs.readdirSync(bookDir);
            const isBook = entries.length === 0 || BOOK_DIR_MARKERS.some((m) => entries.includes(m));
            if (!isBook) {
                throw new InvalidInputError('NOT_A_BOOK_DIR', 'refusing to remove a non-book directory');
            }
            fs.rmSync(bookDir, { recursive: true, force: true });
            return;
        }
    }

    let fst = null;
    try { fst = fs.lstatSync(bookPath); } catch (_) { fst = null; }
    if (fst && fst.isFile()) {
        fs.unlinkSync(bookPath);
    }
}

// ======================================================
// SCENE COLLECTION
// ======================================================

/**
 * Collect a flat scene list in book order (server-computed, thin-client contract).
 *
 * Every client (Android, Web, ...) builds playback queues and navigation from
 * this list instead of re-implementing chapter→scene traversal. Cover detection
 * is also centralized: the first entry with type "cover" is the book cover.
 *
 * @param {Object} book - The loaded book object
 * @returns {Array} - [{ chapter_id, scene_id, type }] in book order
 */
function collectSceneList(book) {
    const list = [];
    if (!book || !Array.isArray(book.chapters)) return list;
    for (const ch of book.chapters) {
        if (!ch.scenes || !Array.isArray(ch.scenes)) continue;
        for (const sc of ch.scenes) {
            list.push({
                // chapter_id for modern lazy-book chapters, `chapter` for legacy.
                chapter_id: ch.chapter_id ?? ch.chapter,
                scene_id: sc.scene_id,
                type: sc.type || 'narration',
            });
        }
    }
    return list;
}

/**
 * Collect all scenes from book chapters.
 * Cover is now a regular chapter (chapters[0]), no special handling needed.
 * @param {Object} book - The loaded book object
 * @returns {Array} - Array of scene runtime entries
 */
function collectScenes(book) {
    const scenes = [];
    
    if (!book || !Array.isArray(book.chapters)) {
        return scenes;
    }

    for (const chapter of book.chapters) {
        if (!chapter.scenes || !Array.isArray(chapter.scenes)) {
            continue;
        }
        
        for (let scIndex = 0; scIndex < chapter.scenes.length; scIndex++) {
            const scene = chapter.scenes[scIndex];
            scenes.push({
                book_id: book.manifest?.book_id,
                // chapter_id for modern lazy-book chapters, `chapter` for legacy.
                chapter_id: chapter.chapter_id ?? chapter.chapter,
                scene_id: scene.scene_id,
                runtime_type: 'scene',
                scene_type: scene.type || 'narration',
                location: scene.location || null,
                participants: scene.participants || [],
                chapter: chapter,
                scene: scene,
                sceneIndex: scIndex,
                scene_order: scenes.length + 1,
                payload: scene
            });
        }
    }
    
    return scenes;
}

// ======================================================
// IU HELPERS
// ======================================================

/**
 * Collect scene units from scene payload.
 * @param {Object} scenePayload - The scene payload object
 * @returns {Array} - Array of unit objects
 */
function collectSceneUnits(scenePayload) {
    const result = [];
    if (scenePayload?.units?.length) {
        for (const unit of scenePayload.units) {
            if (unit && unit.id) {
                result.push(unit);
            }
        }
    }
    if (scenePayload?.dialogue_blocks?.length) {
        for (const block of scenePayload.dialogue_blocks) {
            if (block?.units?.length) {
                for (const unit of block.units) {
                    if (unit && unit.id) {
                        result.push(unit);
                    }
                }
            }
        }
    }
    return result;
}

/**
 * Find scene runtime data by chapter and scene ID.
 * @param {Object} loadedBook - The loaded book object
 * @param {string} chapterId - The chapter ID
 * @param {string} sceneId - The scene ID
 * @returns {Object|null} - The scene data or null if not found
 */
function findSceneRuntimeData(loadedBook, chapterId, sceneId) {
    if (!loadedBook || !Array.isArray(loadedBook.chapters)) {
        return null;
    }

    const bookId = loadedBook.manifest?.book_id;

    for (const chapter of loadedBook.chapters) {
        if (chapter.chapter_id !== chapterId) continue;

        if (!chapter.scenes || !Array.isArray(chapter.scenes)) {
            continue;
        }

        for (let scIndex = 0; scIndex < chapter.scenes.length; scIndex++) {
            const scene = chapter.scenes[scIndex];
            if (scene.scene_id === sceneId) {
                return {
                    runtime_type: 'scene',
                    book_id: bookId,
                    chapter_id: chapter.chapter_id ?? chapter.chapter,
                    scene_id: scene.scene_id,
                    scene_type: scene.type || 'narration',
                    location: scene.location || null,
                    participants: scene.participants || [],
                    chapter: chapter,
                    scene: scene,
                    sceneIndex: scIndex,
                    scene_order: scIndex + 1,
                    payload: scene
                };
            }
        }
    }
    
    return null;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Bundle operations
    inspectBookBundle,
    extractBookBundle,
    buildBookFromBundle,
    bundleFilesFromBook,
    exportBookBundle,
    saveBookBundle,

    // Persistence
    loadBook,
    resetBook,
    readBookHead,
    readBookBody,

    // Scene collection
    collectScenes,
    collectSceneList,
    collectSceneUnits,
    findSceneRuntimeData,

    // format version gate (also at ./vbook-version.cjs) — VBOOK_FORMAT_V4 §9
    vbookVersion,
    assertSupportedVbookVersion,
    BookModelError,

    // character voice port (also at ./voice) — VOICE_REFERENCES.md
    voice,

    // hero-look resolver (also at ./looks.cjs) — VBOOK_FORMAT_V4 §4a.5
    looks,

    // hero readers (also at ./heroes.cjs) — VBOOK_FORMAT_V4 §8.1
    heroes,

    // characters/ store (also at ./character-store.cjs) — VBOOK_FORMAT_V4 §3, §4, §10
    characterStore,

    // Path/input safety
    safePaths,
    getBookDir,
};
