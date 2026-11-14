// ======================================================
// Lazy Book — Draft Management
// ======================================================

const fs = require('fs');
const path = require('path');
const {
    BookState, SceneStatus, SourceType,
} = require('./constants');
const {
    getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getBehaviourPath, getChapterDir,
    generateBookId,
} = require('./paths');
const languageDetector = require('@animastor/parser/language-detector');
const bookCore = require('../index');
const characterStore = require('../character-store.cjs');
const { emptyBehaviourGlobals, CHARACTER_SCHEMA } = require('../character-validator.cjs');
const { NARRATOR_ID } = require('../heroes.cjs');
const {
    BookModelError, assertSupportedVbookVersion, SUPPORTED_VBOOK_VERSION,
} = require('../vbook-version.cjs');

// The narrator is a hero and its file is created with the book
// (VBOOK_FORMAT_V4 §4). Default voice (VOICE_REFERENCES.md): timbre + constant
// narrator manner — the reference is designed from both, the clone copies the
// manner.
function defaultNarrator(language) {
    const voice = language === 'ru'
        ? { timbre: 'A mature Russian male voice. Deep, calm, reflective, slightly melancholic. Native Russian pronunciation.',
            manner: 'Slow literary narration, soft authority, philosophical tone.', timbre_source: 'analysis' }
        : { timbre: 'A mature male voice. Deep, calm, reflective. Native English pronunciation.',
            manner: 'Slow literary narration, soft authority.', timbre_source: 'analysis' };
    return { schema: CHARACTER_SCHEMA, id: NARRATOR_ID, role: NARRATOR_ID, voice };
}

/** Create characters/narrator.json when the book has none (a broken one is left alone). */
function ensureNarrator(bookDir, language) {
    if (characterStore.inspectCharacter(bookDir, NARRATOR_ID).state !== 'absent') return false;
    characterStore.writeCharacter(bookDir, defaultNarrator(language));
    return true;
}

/** Create behaviour.json when the book has none. */
function ensureBehaviourGlobals(bookDir) {
    const file = getBehaviourPath(bookDir);
    if (fs.existsSync(file)) return false;
    characterStore.atomicWriteJson(file, emptyBehaviourGlobals());
    return true;
}

// Detect the source language programmatically (tinyld — pure JS, no LLM) and
// persist it into book.json (`language` + `defaults.language`). Unknown/empty
// input falls back to 'en', never 'ru'. `language` is the SOURCE language; an
// explicit value is never overwritten by callers — draft creation starts with
// language: null, and the load backfill runs only when the field is empty.
function applyDetectedLanguage(bookMeta, sourceText, bookDir) {
    const detectedLanguage = languageDetector.detectLanguage(sourceText);
    bookMeta.language = detectedLanguage;
    if (!bookMeta.defaults) bookMeta.defaults = {};
    bookMeta.defaults.language = detectedLanguage;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));
    return detectedLanguage;
}

function createDraftBook(sourceText, sourceType, title) {
    const bookId = generateBookId(title || 'untitled');
    const bookDir = getBookDir(bookId);
    fs.mkdirSync(bookDir, { recursive: true });

    const buildId = `build_${bookId}`;
    const manifest = {
        vbook_version: SUPPORTED_VBOOK_VERSION,
        book_id: bookId,
        build_id: buildId,
        source: sourceType,
        state: BookState.RAW_IMPORTED,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        import_meta: {
            source_type: sourceType,
            original_size: Buffer.byteLength(sourceText, 'utf8'),
            import_timestamp: new Date().toISOString(),
        },
    };

    const bookMeta = {
        book_id: bookId,
        title: title || 'Imported Book',
        author: null,
        language: null,
        structure: {
            has_prologue: false,
            chapters_order: [],
            characters_order: [NARRATOR_ID],
        },
        defaults: {
            narration_voice: 'narrator',
            language: 'en',
            scene: { auto_anchors: true, spatial_lock: true },
            iu: { character_binding: true },
        },
        transitions: {
            chapter_intro_style: 'soviet_book_page',
            default_transition: 'cut',
            soft_transition: 'fade',
        },
    };

    // ── Language detection (TXT → language detection → book.json → pipeline) ──
    // Runs right after the raw text is read and BEFORE any scene/agent
    // generation (see applyDetectedLanguage above).
    const detectedLanguage = applyDetectedLanguage(bookMeta, sourceText, bookDir);

    characterStore.atomicWriteJson(getManifestPath(bookDir), manifest);
    fs.writeFileSync(getSourcePath(bookDir), sourceText, 'utf8');
    // A v4 book is born complete: the narrator's file and behaviour.json.
    ensureNarrator(bookDir, detectedLanguage);
    ensureBehaviourGlobals(bookDir);

    console.log(`[LAZY-BOOK] RAW_IMPORTED: ${bookId} (${sourceType}, ${manifest.import_meta.original_size} bytes, language=${detectedLanguage})`);
    return { bookId, manifest, book: bookMeta };
}

/**
 * Draft / in-progress view of a book: the same model as the full loader plus
 * `sourceText`, with chapters read from chapters/ as they are on disk.
 * @returns {Object|null} { manifest, book, sourceText, bible, locations,
 *          behaviour, heroes, hero_issues, chapters }; null when there is no such book
 * @throws {BookModelError} UNSUPPORTED_VBOOK_VERSION
 */
function loadDraftBook(bookId) {
    const bookDir = getBookDir(bookId);
    if (!fs.existsSync(bookDir)) return null;

    try {
        const head = bookCore.readBookHead(bookDir);
        if (!head) return null;
        const { manifest, bookMeta } = head;
        const sourceText = fs.existsSync(getSourcePath(bookDir))
            ? fs.readFileSync(getSourcePath(bookDir), 'utf8') : null;

        const body = bookCore.readBookBody(bookDir, bookMeta);

        // ── Lazy language backfill (legacy books) ──
        // Books imported before programmatic detection may carry an empty
        // book.language (the old pipeline never wrote it — and the pipeline
        // would silently fall back to a hardcoded 'ru', corrupting the
        // generation language for non-Russian books). Fill it ONCE from the
        // source text. An explicitly set value (including user-set via the
        // metadata PATCH) is never overwritten — backfill only when empty.
        if (!bookMeta.language && sourceText && typeof sourceText === 'string' && sourceText.trim()) {
            const detectedLanguage = applyDetectedLanguage(bookMeta, sourceText, bookDir);
            console.log(`[LAZY-BOOK] Backfilled language=${detectedLanguage} for ${bookId}`);
        }

        const chapters = [];
        const chDir = getChapterDir(bookDir);
        if (fs.existsSync(chDir)) {
            const chFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort();
            for (const cf of chFiles) {
                try { chapters.push(JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'))); }
                catch (e) { console.warn(`[LAZY-BOOK] Skipping bad chapter ${cf}: ${e.message}`); }
            }
        }

        return {
            manifest,
            book: bookMeta,
            sourceText,
            bible: body.bible,
            locations: body.locations,
            behaviour: body.behaviour,
            heroes: body.heroes,
            hero_issues: body.hero_issues,
            chapters,
        };
    } catch (err) {
        if (err instanceof BookModelError) throw err;
        console.error(`[LAZY-BOOK] Failed to load ${bookId}:`, err.message);
        return null;
    }
}

function updateBookState(bookId, newState) {
    const mp = getManifestPath(getBookDir(bookId));
    if (!fs.existsSync(mp)) throw new Error(`Book ${bookId} not found`);
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    assertSupportedVbookVersion(m);
    m.state = newState;
    m.updated_at = new Date().toISOString();
    characterStore.atomicWriteJson(mp, m);
    console.log(`[LAZY-BOOK] ${bookId}: ${newState}`);
    return m;
}

module.exports = {
    createDraftBook,
    loadDraftBook,
    updateBookState,
    defaultNarrator,
    ensureNarrator,
    ensureBehaviourGlobals,
};
