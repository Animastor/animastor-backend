// ======================================================
// Book Module - v2.1.0
// ======================================================
// Handles book loading, saving, and bundle operations.
// NOT stateful - just pure file/book operations.
//
// Storage format (v2.1): multi-file directory structure
// Cover is a standard chapter stored in chapters/ directory
// with chapter_title: "Обложка". No standalone cover.json.
//
//   /data/books/<bookId>/
//     manifest.json
//     book.json
//     bible.json            (optional)
//     characters.json       (optional)
//     behavior.json         (always present — per-character behavior keyed by character_id, starts as {})
//     chapters/
//       ch-XXXXXXXX.json    (one per chapter, Cover is first)
//
// Legacy single-file format is still readable for migration:
//   /data/books/<bookId>.json
//
// ── behavior.json — schema v2 (see ./behavior-schema.cjs) ────────────────
// Disk and memory: {schema_version: 2, rules: [...], characters: {<id>: …}}.
// A file without schema_version is the legacy v2.1 flat map and is migrated
// on load (every top-level key = a character entry); saves are always v2.
// HTTP responses project it back to the flat map + read-only behavior_rules
// (projectBookBehaviorsForApi). Character entries (characters.<id>) follow
// the v2.1 Character Behavior contract below.
//
// Character entry: character_id → behavior object. The object is SCHEMA-TOLERANT:
// unknown keys (including future fields) are preserved on every load/save
// round-trip. Fields:
//
//   baseline    : string?                  — how the character behaves NORMALLY
//   quirks      : string[]?                — recurring habits (one entry each)
//   reactions   : [{trigger, reaction}]?   — trigger → reaction patterns
//                                            (trigger: what happens to/around
//                                             the character; reaction: what the
//                                             character does)
//
// Deliberately deferred (do NOT add in the editor pass): frequency/intensity,
// priority, extraction from book text, runtime interpretation, state machines.
// Editors (web + Android) edit quirks/reactions as line-based text: one entry
// per line, reactions use "trigger → reaction" (also "->"). An untouched card
// never rewrites the stored array, so future per-reaction keys added by other
// tools survive; the editor replaces the array only when its text changed.
// POST /behaviors seeds {baseline}; all other fields are edited via
// PATCH /behaviors/{characterId} (fields merged via setDeep, passthrough).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const safePaths = require('./safe-paths');
const {
    InvalidInputError, BUNDLE_LIMITS,
    assertBookId, assertBuildId, isValidBookId, joinInside, assertInside,
    isUnsafeEntryName, isAllowedBundleEntry, isChapterFileName,
} = safePaths;

const { validateBundleFile } = require('./bundle-validator.cjs');
const behaviorSchema = require('./behavior-schema.cjs');
const voice = require('./voice');
const looks = require('./looks.cjs');
const { getBooksRoot } = require('./books-root');

// Last line of defense before disk: every bundle resource that saveBookBundle
// is about to write must satisfy the canonical JSON contract. A failure THROWS
// before the FIRST write — previous valid state on disk stays untouched and
// callers report the error instead of a successful save.
function assertBundleFilesWritable(book) {
    const candidates = [
        ['manifest.json', book.manifest],
        ['book.json', book.book ?? {}],
        ['bible.json', book.bible],
        ['locations.json', book.locations],
        ['voices.json', book.voices],
        ['behavior.json', book.behaviors],
        ['characters.json', book.characters],
    ];
    for (const [filename, data] of candidates) {
        if (data === undefined || data === null) continue;
        const check = validateBundleFile(filename, data);
        if (!check.valid) {
            throw new Error(`Bundle validation failed (${filename}): ${check.errors.join('; ')}`);
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
        }
    }
}

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
    return path.join(bookDir, 'chapters');
}

function getChapterPath(bookDir, chapterFile) {
    return path.join(getChapterDir(bookDir), chapterFile);
}

// ======================================================
// BOOK BUNDLE OPERATIONS
// ======================================================

/**
 * List archive entries WITHOUT decompressing anything: names, sizes, flags.
 * Throws InvalidInputError for archives that must be refused as a whole
 * (unsafe names, symlinks, encryption, duplicates, size/count limits).
 * @param {Buffer} buffer
 * @returns {{ zip: AdmZip, entries: object[], payload: object[], skipped: number }}
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
    let skipped = 0;
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
        if (!isAllowedBundleEntry(name)) { skipped++; continue; }
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
    return { zip, entries, payload, skipped };
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

/**
 * Extract book bundle from buffer.
 * Only whitelisted format-3.1 entries are returned; other entries are
 * skipped (counted, never written). Unsafe archives are refused.
 * @param {Buffer} buffer - The zipped bundle buffer
 * @param {object} [opts] - { log?: (msg) => void, limits? }
 * @returns {Object} - Object with file contents keyed by filename (string values like backend expects)
 */
function extractBookBundle(buffer, opts = {}) {
    const limits = opts.limits || BUNDLE_LIMITS;
    const { payload, skipped } = inspectBookBundle(buffer, limits);
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
    if (skipped > 0) {
        const log = typeof opts.log === 'function' ? opts.log : console.warn;
        log(`[VBOOK] ${skipped} archive entr${skipped === 1 ? 'y' : 'ies'} outside the bundle format skipped`);
    }
    return files;
}

/**
 * Build book from extracted bundle.
 * @param {Object} rawFiles - Object with file contents keyed by filename
 * @returns {Object} - The built book object with full metadata
 */
function buildBookFromBundle(rawFiles) {
    const normalize = (p) =>
        p
            .replace(/\\\\/g, "/")
            .replace(/\r/g, "")
            .replace(/^(\.\/)+/, "")
            .trim()
    const files = {}
    Object.entries(rawFiles).forEach(([k, v]) => {
        files[normalize(k)] = v
    })
    const keys = Object.keys(files)

    const findFile = (name) =>
        keys.find(k => k.toLowerCase().endsWith(name))

    // Manifest
    const manifestKey = findFile("manifest.json")
    if (!manifestKey) {
        throw new Error("manifest.json not found. Files: " + keys.join(", "))
    }
    let manifest
    try {
        manifest = JSON.parse(files[manifestKey])
    } catch {
        throw new Error("Invalid JSON in manifest.json")
    }
    if (!manifest.book_id) {
        throw new Error("manifest.book_id missing")
    }
    assertBookId(manifest.book_id)
    if (manifest.build_id !== undefined && manifest.build_id !== null) {
        assertBuildId(manifest.build_id)
    }

    // Bible, locations & characters
    const bibleKey = findFile("bible.json")
    const locationsKey = findFile("locations.json")
    const charactersKey = findFile("characters.json")
    let bible = {}
    let characters = []
    if (bibleKey) {
        try {
            bible = JSON.parse(files[bibleKey])
        } catch {
            throw new Error("Invalid JSON in bible.json")
        }
    }
    let locations = {};
    if (locationsKey) {
        try {
            locations = JSON.parse(files[locationsKey]);
        } catch {
            throw new Error("Invalid JSON in locations.json")
        }
    }

    // Voices
    const voicesKey = findFile("voices.json");
    let voices = {};
    if (voicesKey) {
        try {
            voices = JSON.parse(files[voicesKey]);
        } catch {
            throw new Error("Invalid JSON in voices.json")
        }
    }

    // Behavior (optional, per-character behavior keyed by character_id)
    const behaviorKey = findFile("behavior.json");
    let behaviors = behaviorSchema.normalizeBehaviors({});
    if (behaviorKey) {
        try {
            behaviors = behaviorSchema.normalizeBehaviors(JSON.parse(files[behaviorKey]));
        } catch {
            throw new Error("Invalid JSON in behavior.json")
        }
    }
    if (charactersKey) {
        try {
            characters = JSON.parse(files[charactersKey])
        } catch {
            throw new Error("Invalid JSON in characters.json")
        }
    }

    // Book metadata
    const bookKey = findFile("book.json")
    if (!bookKey) {
        throw new Error("book.json not found. Files: " + keys.join(", "))
    }
    let parsedBook
    try {
        parsedBook = JSON.parse(files[bookKey])
    } catch {
        throw new Error("Invalid JSON in book.json")
    }
    if (!parsedBook.structure?.chapters_order) {
        throw new Error("book.structure.chapters_order missing")
    }

    // Chapters
    if (!Array.isArray(parsedBook.structure.chapters_order)) {
        throw new Error("book.structure.chapters_order must be an array")
    }
    const chapters = parsedBook.structure.chapters_order.map(file => {
        const base = typeof file === "string" ? file.replace(/^chapters\//, "") : ""
        if (!isChapterFileName(base)) {
            throw new InvalidInputError("INVALID_BUNDLE", "invalid chapter file name in chapters_order")
        }
        const fullKey = keys.find(k => k === "chapters/" + base) || keys.find(k => k === base)
        if (!fullKey) {
            throw new Error("Missing chapter file: " + file)
        }
        try {
            return JSON.parse(files[fullKey])
        } catch {
            throw new Error("Invalid JSON in " + fullKey)
        }
    })
    if (!chapters.length) {
        throw new Error("No chapters loaded")
    }

    // CANONICAL ID VALIDATION — format: sc-XXXXXXXX, ch-XXXXXXXX, iu-XXXXXXXX
    function assertCanonicalChapterId(id) {
        if (!id || !/^ch-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid chapter_id: " + id + " (expected: ch-XXXXXXXX)")
        }
    }
    function assertCanonicalSceneId(id) {
        if (!id || !/^sc-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid scene_id: " + id + " (expected: sc-XXXXXXXX)")
        }
    }
    function assertCanonicalUnitId(id) {
        if (!id || !/^iu-[a-f0-9]{6,}$/.test(id)) {
            throw new Error("Invalid unit_id: " + id + " (expected: iu-XXXXXXXX)")
        }
    }

    for (const chapter of chapters) {
        assertCanonicalChapterId(chapter.chapter_id)
        if (chapter.scenes) {
            for (const scene of chapter.scenes) {
                assertCanonicalSceneId(scene.scene_id)
                const allUnits = collectSceneUnits(scene)
                for (const unit of allUnits) {
                    assertCanonicalUnitId(unit.id)
                }
            }
        }
    }

    return {
        manifest,
        book: parsedBook,
        bible,
        characters,
        chapters,
        locations,
        voices,
        behaviors
    }
}

// ======================================================
// DIRECTORY HELPERS
// ======================================================

/**
 * Recursively add directory contents to a ZIP archive.
 * @param {AdmZip} zip
 * @param {string} dirPath - Absolute path on disk
 * @param {string} zipPath - Prefix path inside ZIP
 */
function addDirToZip(zip, dirPath, zipPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        // Dirent types come from lstat semantics: symlinks are neither
        // directories nor files here and are never followed or exported.
        if (entry.isSymbolicLink()) {
            continue;
        } else if (entry.isDirectory()) {
            addDirToZip(zip, fullPath, entryZipPath);
        } else if (entry.isFile()) {
            zip.addFile(entryZipPath, fs.readFileSync(fullPath));
        }
    }
}

// ======================================================
// BOOK PERSISTENCE (multi-file format, v2)
// ======================================================

/**
 * Save book bundle to disk using multi-file format.
 * @param {Object} book - The book object {manifest, book, bible, characters, chapters}
 * @param {Object|null} files - Optional raw file contents from extractBookBundle.
 *        When provided, files are written with original content preserving formatting.
 *        When null, book object is serialised into individual files.
 */
function saveBookBundle(book, files) {
    const bookId = book.manifest?.book_id;
    if (!bookId) {
        throw new Error('Book ID not found in manifest');
    }

    const booksDir = getBooksDir();
    if (!fs.existsSync(booksDir)) {
        fs.mkdirSync(booksDir, { recursive: true });
    }

    const bookDir = getBookDir(bookId);
    assertNotLink(bookDir);
    if (!fs.existsSync(bookDir)) {
        fs.mkdirSync(bookDir, { recursive: true });
    }

    // When raw files map is provided, write them in canonical multi-file format:
    // non-chapter files → book root, chapter files → chapters/ subdirectory.
    if (files && typeof files === 'object' && Object.keys(files).length > 0) {
        const normalize = (p) =>
            p.replace(/\\\\/g, "/").replace(/\r/g, "").replace(/^(\.\/)+/, "").trim()

        // Кирпич №2 (Persistent Layer Configuration): ре-импорт пишет book.json
        // verbatim из бандла, который может не содержать layer_config (экспорт
        // сделан до этого кирпича). Захватываем durable-копию ДО перезаписи,
        // чтобы после неё не потерять конфиг отключённых слоёв.
        let existingLayerConfig = null;
        const priorMetaPath = path.join(bookDir, 'book.json');
        if (fs.existsSync(priorMetaPath)) {
            try {
                const prior = JSON.parse(fs.readFileSync(priorMetaPath, 'utf8'));
                if (prior && prior.layer_config && typeof prior.layer_config === 'object') {
                    existingLayerConfig = prior.layer_config;
                }
            } catch (_) { /* best-effort */ }
        }

        // Determine which files are chapters from book.structure.chapters_order
        const chaptersOrder = book.book?.structure?.chapters_order || [];
        const chapterBasenames = new Set(
            chaptersOrder.map(cf => cf.split('/').pop())
        );
        const rootBasenames = new Set(
            ['manifest.json', 'book.json', 'bible.json', 'locations.json', 'voices.json', 'characters.json', 'behavior.json']
        );

        // Validate the complete write set BEFORE the first write: only
        // whitelisted format entries, every target strictly inside bookDir.
        const writes = [];
        let skippedEntries = 0;
        for (const [filePath, content] of Object.entries(files)) {
            if (isUnsafeEntryName(filePath)) {
                throw new InvalidInputError('INVALID_ARCHIVE_ENTRY', 'archive contains an invalid entry name');
            }
            const normalized = normalize(filePath);
            if (!isAllowedBundleEntry(normalized)) { skippedEntries++; continue; }
            const basename = normalized.split('/').pop();

            let targetPath;
            if (isChapterFileName(basename) && (chapterBasenames.has(basename) || normalized.startsWith('chapters/'))) {
                // Chapter file → chapters/ subdirectory
                targetPath = joinInside(bookDir, 'chapters', basename);
            } else if (isChapterFileName(basename)) {
                targetPath = joinInside(bookDir, 'chapters', basename);
            } else {
                targetPath = joinInside(bookDir, basename);
            }
            writes.push([targetPath, content]);
        }
        if (skippedEntries > 0) {
            console.warn(`[SAVE] ${bookId}: ${skippedEntries} non-format entr${skippedEntries === 1 ? 'y' : 'ies'} not written`);
        }
        for (const [targetPath, content] of writes) {
            const dir = path.dirname(targetPath);
            assertNotLink(dir);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            assertNotLink(targetPath);
            fs.writeFileSync(targetPath, content);
        }

        // Ensure chapters_order in book.json references filenames without path,
        // and restore the durable layer_config captured before the rewrite.
        const bookMetaPath = path.join(bookDir, 'book.json');
        if (fs.existsSync(bookMetaPath)) {
            try {
                const bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
                if (bookMeta.structure?.chapters_order) {
                    bookMeta.structure.chapters_order = bookMeta.structure.chapters_order.map(
                        cf => cf.split('/').pop()
                    );
                }
                // Кирпич №2: ре-импорт не должен уничтожать durable layer_config
                if (existingLayerConfig && !bookMeta.layer_config) {
                    bookMeta.layer_config = existingLayerConfig;
                }
                fs.writeFileSync(bookMetaPath, JSON.stringify(bookMeta, null, 2));
            } catch (e) {
                // Ignore book.json rewrite errors
            }
        }

        console.log(`[SAVE] Book: ${bookId} (from raw files, canonical format)`);
        return;
    }

    // Object-mode save: validate the complete bundle contract BEFORE the
    // first writeFileSync (validate → write, never write → discover).
    // Raw-files mode above is verbatim import content — validated at import.
    assertBundleFilesWritable(book);

    console.log(`[SAVE] Book: ${bookId}, chapters: ${book.chapters?.length}`);

    // Save manifest.json
    fs.writeFileSync(
        path.join(bookDir, 'manifest.json'),
        JSON.stringify(book.manifest, null, 2)
    );

    // Save book.json with chapters_order synced to actual chapters.
    // ⚠️ Only overwrite chapters_order when book.chapters is non-empty.
    // Lazy books keep chapters as files on disk; calling saveBookBundle
    // with an empty chapters array (e.g. from a stale GET response) would
    // destroy the existing chapters_order and make all chapters invisible.
    const bookMeta = book.book ? JSON.parse(JSON.stringify(book.book)) : {};
    if (!bookMeta.structure) bookMeta.structure = {};
    // Кирпич №2 (Persistent Layer Configuration): durable layer_config живёт в
    // book.json. Редактор может перезаписать book.json из объекта без этого
    // поля (например, закешированного до последнего PUT layer-config) — не
    // даём durable-копии потеряться при перезаписи.
    if (!bookMeta.layer_config) {
        try {
            const onDiskMetaPath = path.join(bookDir, 'book.json');
            if (fs.existsSync(onDiskMetaPath)) {
                const onDisk = JSON.parse(fs.readFileSync(onDiskMetaPath, 'utf8'));
                if (onDisk && onDisk.layer_config && typeof onDisk.layer_config === 'object') {
                    bookMeta.layer_config = onDisk.layer_config;
                }
            }
        } catch (_) { /* best-effort */ }
    }
    const chapterFilenames = (book.chapters || []).map(ch => `${ch.chapter_id}.json`);
    if (chapterFilenames.length > 0) {
        bookMeta.structure.chapters_order = chapterFilenames;
    }
    fs.writeFileSync(
        path.join(bookDir, 'book.json'),
        JSON.stringify(bookMeta, null, 2)
    );

    // Save bible.json (optional, without locations)
    const biblePath = path.join(bookDir, 'bible.json');
    if (book.bible && Object.keys(book.bible).length > 0) {
        const { locations: _bibleLocs, ...bibleWithoutLocations } = book.bible;
        fs.writeFileSync(biblePath, JSON.stringify(bibleWithoutLocations, null, 2));
    } else if (fs.existsSync(biblePath)) {
        fs.unlinkSync(biblePath);
    }

    // Save locations.json separately
    const locsPath = path.join(bookDir, 'locations.json');
    const hasLocations = book.locations && Object.keys(book.locations).length > 0;
    if (hasLocations) {
        fs.writeFileSync(locsPath, JSON.stringify(book.locations, null, 2));
    } else if (fs.existsSync(locsPath)) {
        fs.unlinkSync(locsPath);
    }

    // Save voices.json separately
    const voPath = path.join(bookDir, 'voices.json');
    const hasVoices = book.voices && Object.keys(book.voices).length > 0;
    if (hasVoices) {
        fs.writeFileSync(voPath, JSON.stringify(book.voices, null, 2));
    } else if (fs.existsSync(voPath)) {
        fs.unlinkSync(voPath);
    }

    // Save behavior.json — always persists, always schema v2 (a legacy v2.1
    // flat map is migrated here). Kept on disk even when empty so the
    // AI-agent can always discover and populate it via edit_book.
    const bhPath = path.join(bookDir, 'behavior.json');
    fs.writeFileSync(bhPath, JSON.stringify(behaviorSchema.normalizeBehaviors(book.behaviors), null, 2));

    // Save characters.json (optional)
    const charPath = path.join(bookDir, 'characters.json');
    if (book.characters && book.characters.length > 0) {
        fs.writeFileSync(charPath, JSON.stringify(book.characters, null, 2));
    } else if (fs.existsSync(charPath)) {
        fs.unlinkSync(charPath);
    }

    // Save chapters
    const chaptersDir = getChapterDir(bookDir);
    if (!fs.existsSync(chaptersDir)) {
        fs.mkdirSync(chaptersDir, { recursive: true });
    }

    const activeChapterFiles = new Set();
    for (const chapter of book.chapters || []) {
        const chapterFile = `${chapter.chapter_id}.json`;
        if (!safePaths.isSafeChapterFile(chapterFile)) {
            throw new InvalidInputError('INVALID_BUNDLE', 'invalid chapter id');
        }
        activeChapterFiles.add(chapterFile);
        fs.writeFileSync(
            joinInside(chaptersDir, chapterFile),
            JSON.stringify(chapter, null, 2)
        );
    }

    // Clean up orphaned chapter files — ONLY when we have a known chapter list.
    // If chapters array is empty (e.g. from a stale/corrupted load), we don't know
    // which files belong, so NEVER delete anything to avoid data loss.
    if (chapterFilenames.length > 0) {
        try {
            const existingFiles = fs.readdirSync(chaptersDir);
            for (const f of existingFiles) {
                if (!activeChapterFiles.has(f)) {
                    const fp = path.join(chaptersDir, f);
                    if (fs.statSync(fp).isFile()) {
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
 * Load book from disk (multi-file directory or legacy single JSON).
 * @param {string} bookId - The book ID to load
 * @returns {Object|null} - The loaded book {manifest, book, bible, characters, chapters}
 */
function loadBook(bookId) {
    if (!isValidBookId(bookId)) return null;
    const bookDir = getBookDir(bookId);
    const bookPath = getBookPath(bookId);

    // Multi-file directory format
    if (fs.existsSync(bookDir)) {
        try {
            const stat = fs.statSync(bookDir);
            if (stat.isDirectory()) {
                return loadBookFromDir(bookId, bookDir);
            }
        } catch (e) {
            // Fall through to single-file check
        }
    }

    // Legacy single-file format (for migration)
    if (fs.existsSync(bookPath)) {
        try {
            const content = fs.readFileSync(bookPath, 'utf8');
            return JSON.parse(content);
        } catch (err) {
            console.error(`Failed to load book ${bookId}:`, err.message);
            return null;
        }
    }

    return null;
}

/**
 * Load book from multi-file directory.
 * @param {string} bookId
 * @param {string} bookDir
 * @returns {Object|null}
 */
function loadBookFromDir(bookId, bookDir) {
    try {
        const manifestPath = path.join(bookDir, 'manifest.json');
        const bookMetaPath = path.join(bookDir, 'book.json');

        if (!fs.existsSync(manifestPath) || !fs.existsSync(bookMetaPath)) {
            return null;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));

        // Optional bible.json
        let bible = {};
        const biblePath = path.join(bookDir, 'bible.json');
        if (fs.existsSync(biblePath)) {
            bible = JSON.parse(fs.readFileSync(biblePath, 'utf8'));
        }

        // Optional locations.json — load as top-level key
        let locations = {};
        const locationsPath = path.join(bookDir, 'locations.json');
        if (fs.existsSync(locationsPath)) {
            locations = JSON.parse(fs.readFileSync(locationsPath, 'utf8'));
        }

        // Optional voices.json — load as top-level key
        let voices = {};
        const voicesPath = path.join(bookDir, 'voices.json');
        if (fs.existsSync(voicesPath)) {
            voices = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
        }

        // Optional behavior.json — load as top-level key (per-character behavior
        // keyed by character_id, same pattern as voices.json)
        // Migrated to schema v2 in memory (legacy v2.1 file → characters).
        let behaviors = behaviorSchema.normalizeBehaviors({});
        const behaviorPath = path.join(bookDir, 'behavior.json');
        if (fs.existsSync(behaviorPath)) {
            behaviors = behaviorSchema.normalizeBehaviors(JSON.parse(fs.readFileSync(behaviorPath, 'utf8')));
        }

        // Optional characters.json
        let characters = [];
        const charPath = path.join(bookDir, 'characters.json');
        if (fs.existsSync(charPath)) {
            characters = JSON.parse(fs.readFileSync(charPath, 'utf8'));
        }

        // Chapters: look in chapters/ subdirectory first, fall back to root
        const chaptersDir = getChapterDir(bookDir);
        const chapters = [];
        const chaptersOrder = bookMeta.structure?.chapters_order || [];

        for (const chapterFile of chaptersOrder) {
            const basename = chapterFile.split('/').pop();
            let cp = path.join(chaptersDir, basename);
            if (!fs.existsSync(cp)) {
                cp = path.join(bookDir, basename);
            }
            if (fs.existsSync(cp)) {
                chapters.push(JSON.parse(fs.readFileSync(cp, 'utf8')));
            }
        }

        return { manifest, book: bookMeta, bible, characters, chapters, locations, voices, behaviors };
    } catch (err) {
        console.error(`Failed to load book from dir ${bookId}:`, err.message);
        return null;
    }
}

/** Refuse to operate on a symlink (lstat, does not follow). */
function assertNotLink(p) {
    let st = null;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.isSymbolicLink()) {
        throw new InvalidInputError('PATH_IS_LINK', 'refusing to use a linked path');
    }
}

const BOOK_DIR_MARKERS = ['manifest.json', 'book.json', 'source.txt', 'chapters'];

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
    saveBookBundle,
    
    // Persistence
    loadBook,
    resetBook,
    
    // ZIP helpers
    addDirToZip,
    

    
    // Scene collection
    collectScenes,
    collectSceneList,
    collectSceneUnits,
    findSceneRuntimeData,

    // behavior.json schema v2 helpers (also at ./behavior-schema.cjs)
    behaviorSchema,

    // character voice port (also at ./voice) — VOICE_REFERENCES.md
    voice,

    // hero-look resolver (also at ./looks.cjs) — VBOOK_FORMAT_V4 §4a.5
    looks,

    // Path/input safety
    safePaths,
    getBookDir,
};
