// ======================================================
// TXT Importer Service - v3.0.0
// ======================================================
// Pipeline:
//   1. Validate TXT (encoding, size)
//   2. Create draft (RAW_IMPORTED)
//   3. Bootstrap: quick analysis → AI refinement → create structure → BOOTSTRAPPED
//   4. Fallback to programmatic bootstrap if AI unavailable
//   5. Lazy parse further scenes on demand
// ======================================================

const characterStore = require('@animastor/vbook-runtime/character-store.cjs');
const fs = require('fs');
const config = require('../config/runtime-config');
const lazyBook = require('../book/lazy-book');
const aiService = require('./ai-service');
const encodingDetect = require('@animastor/parser/encoding-detect');
const bootstrapLock = require('./bootstrap-lock');

// ======================================================
// PROGRESS STAGES
// ======================================================

const ProgressStage = {
    VALIDATING: 'validating',
    LOADING: 'loading',
    ANALYZING: 'analyzing',
    EXTRACTING_CHARACTERS: 'extracting_characters',
    EXTRACTING_LOCATIONS: 'extracting_locations',
    AI_ANALYSIS: 'ai_analysis',
    CREATING_STRUCTURE: 'creating_structure',
    CREATING_SCENES: 'creating_scenes',
    COMPLETING: 'completing',
    DONE: 'done',
};

// ======================================================
// VALIDATION + ENCODING DETECTION
// ======================================================

function decodeTxtBuffer(buffer) {
    const result = { text: null, encoding: null, warnings: [], error: null };

    if (buffer.length > config.TXT_MAX_SIZE) {
        const maxMb = Math.floor(config.TXT_MAX_SIZE / (1024 * 1024));
        const actualMb = (buffer.length / (1024 * 1024)).toFixed(2);
        result.error = `File too large: ${actualMb} MB (max ${maxMb} MB)`;
        return result;
    }

    // Try to detect encoding and decode
    const detection = encodingDetect.decodeBuffer(buffer);
    if (detection.error) {
        result.error = detection.error;
        return result;
    }

    result.text = detection.text;
    result.encoding = detection.encoding;
    result.label = detection.label;
    result.warnings = detection.warnings || [];

    return result;
}

function validateAiText(text) {
    const errors = [];
    if (!text || typeof text !== 'string') { errors.push('No text provided'); return { valid: false, errors }; }
    if (Buffer.byteLength(text, 'utf8') > config.TXT_MAX_SIZE) {
        const maxMb = Math.floor(config.TXT_MAX_SIZE / (1024 * 1024));
        const actualMb = (Buffer.byteLength(text, 'utf8') / (1024 * 1024)).toFixed(2);
        errors.push(`Text too large: ${actualMb} MB (max ${maxMb} MB)`);
    }
    return { valid: errors.length === 0, errors };
}

// ======================================================
// FULL IMPORT PIPELINE
// ======================================================

async function importTxtFile(buffer, filename, progressCallback) {
    const progress = progressCallback || (() => {});

    progress(ProgressStage.VALIDATING, 'Decoding file...');
    const decoded = decodeTxtBuffer(buffer);
    if (decoded.error) {
        throw new Error('TXT import failed: ' + decoded.error);
    }

    // Report encoding info
    if (decoded.label && decoded.label !== 'UTF-8') {
        progress(ProgressStage.VALIDATING, `Detected encoding: ${decoded.label}`);
    }

    const sourceText = decoded.text;
    const title = require('path').basename(filename, '.txt');

    progress(ProgressStage.LOADING, 'Loading file...');
    const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title);

    const bookDir = lazyBook.getBookDir(draft.bookId);
    const mp = lazyBook.getManifestPath(bookDir);
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.import_meta.original_filename = filename;
    fs.writeFileSync(mp, JSON.stringify(m, null, 2));

    // Bootstrap: quick analysis → AI refinement → structure
    const bootstrapResult = await bootstrapImportedText(draft.bookId, progress);

    return {
        bookId: draft.bookId,
        title: bootstrapResult.title,
        author: bootstrapResult.author,
        language: bootstrapResult.language,
        state: lazyBook.BookState.BOOTSTRAPPED,
        characters: bootstrapResult.characters,
        locations: bootstrapResult.locations,
        scenes: bootstrapResult.scenes,
    };
}

async function importAiText(text, title, progressCallback) {
    const progress = progressCallback || (() => {});

    progress(ProgressStage.VALIDATING, 'Validating text...');
    const validation = validateAiText(text);
    if (!validation.valid) {
        throw new Error('Text validation failed: ' + validation.errors.join('; '));
    }

    progress(ProgressStage.LOADING, 'Loading text...');
    const draft = lazyBook.createDraftBook(text, lazyBook.SourceType.AI_IMPORT, title || 'Imported Text');

    const bootstrapResult = await bootstrapImportedText(draft.bookId, progress);

    return {
        bookId: draft.bookId,
        title: bootstrapResult.title,
        author: bootstrapResult.author,
        language: bootstrapResult.language,
        state: lazyBook.BookState.BOOTSTRAPPED,
        characters: bootstrapResult.characters,
        locations: bootstrapResult.locations,
        scenes: bootstrapResult.scenes,
    };
}

// ======================================================
// BOOTSTRAP INTERNAL — Two-stage pipeline
// ======================================================

// Bootstrap idempotency (2026-11-26, animastor-docs
// architecture/BOOTSTRAP_IDEMPOTENCY.md): every run of the first window or of
// a next window holds the per-book bootstrap lock (services/bootstrap-lock.js).
// The state check, the partial-artifact cleanup and the run itself happen
// UNDER the lock — a parallel run can no longer delete files of another run
// or mint a second chapter 0.

/**
 * First window. Takes the book's bootstrap lock; busy → BootstrapInProgressError.
 * Already BOOTSTRAPPED/ACTIVE with chapters → no-op (already_bootstrapped: true).
 */
async function bootstrapImportedText(bookId, progress, publishProgress, redis) {
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);
    return bootstrapLock.withBootstrapLock(redis, bookId,
        () => bootstrapImportedTextUnderLock(bookId, progress, publishProgress, redis));
}

function _chapterFiles(bookId) {
    const chDir = lazyBook.getChapterDir(lazyBook.getBookDir(bookId));
    return fs.existsSync(chDir) ? fs.readdirSync(chDir).filter(f => f.endsWith('.json')) : [];
}

/** The book as it is now — the no-op answer of a repeated bootstrap. */
function _currentState(bookId, draft) {
    const chapters = (draft.chapters || []).filter(ch => ch && ch.type !== 'cover');
    const scenes = (draft.chapters || []).reduce((sum, ch) => sum + ((ch && ch.scenes) ? ch.scenes.length : 0), 0);
    return {
        bookId,
        state: draft.manifest.state,
        title: draft.book?.title || 'Unknown',
        author: draft.book?.author || null,
        language: draft.book?.language || null,
        characters: null,
        locations: null,
        scenes,
        already_bootstrapped: true,
        chapters_summary: chapters.map(ch => ({
            chapter_id: ch.chapter_id,
            chapter_title: ch.chapter_title || null,
            chapter_index: ch.chapter_index,
            status: ch.status,
            scene_count: ch.scenes ? ch.scenes.length : 0,
        })),
    };
}

/**
 * First window, the caller already holds the bootstrap lock (routes that do
 * post-processing — chunks, PG window row — under the same lock).
 */
async function bootstrapImportedTextUnderLock(bookId, progress, publishProgress, redis) {
    const path = require('path');

    // Re-read the book AFTER taking the lock: the state on entry may be stale
    // (another run may have finished while this request waited).
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    const st = draft.manifest?.state;
    if (st === lazyBook.BookState.BOOTSTRAPPED || st === lazyBook.BookState.ACTIVE) {
        if (_chapterFiles(bookId).length > 0) {
            console.log(`[BOOTSTRAP] ${bookId} already ${st} with chapters — no-op`);
            return _currentState(bookId, draft);
        }
        console.log(`[BOOTSTRAP] ${bookId} stuck in ${st} with no chapters, re-bootstrapping...`);
    }

    // Clean up partial bootstrap artifacts from previous failed attempts.
    // Safe only under the lock: no other run of this book is alive.
    const bookDir = lazyBook.getBookDir(bookId);
    const chDir = lazyBook.getChapterDir(bookDir);
    const biblePath = lazyBook.getBiblePath(bookDir);

    if (fs.existsSync(chDir)) {
        const partialChapters = fs.readdirSync(chDir).filter(f => f.endsWith('.json'));
        if (partialChapters.length > 0) {
            console.log(`[BOOTSTRAP] Cleaning ${partialChapters.length} partial chapter files...`);
            for (const f of partialChapters) {
                fs.unlinkSync(path.join(chDir, f));
            }
        }
    }
    // Heroes of the failed attempt (VBook 4: one file per hero). The narrator
    // is created with the book and stays; broken files are never touched.
    const partialHeroes = characterStore.listCharacters(bookDir).heroes.filter(h => h.id !== 'narrator');
    if (partialHeroes.length > 0) {
        console.log(`[BOOTSTRAP] Removing ${partialHeroes.length} partial hero file(s)...`);
        for (const hero of partialHeroes) characterStore.removeCharacter(bookDir, hero.id);
    }
    if (fs.existsSync(biblePath)) {
        console.log('[BOOTSTRAP] Removing partial bible.json...');
        fs.unlinkSync(biblePath);
    }

    // Use the new agent pipeline (pass publishProgress for SSE)
    const agentService = require('./agent-service');
    const result = await agentService.bootstrapWithAgent(bookId, progress, publishProgress, redis);

    return {
        ...result,
        locations: result.locations || 0,
    };
}

// ======================================================
// BOOTSTRAP NEXT WINDOW — process subsequent scene windows
// ======================================================

/** Next window. Takes the book's bootstrap lock; busy → BootstrapInProgressError. */
async function bootstrapNextWindow(bookId, progress, publishProgress, redis) {
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) {
        throw new Error(`Book ${bookId} not found`);
    }
    return bootstrapLock.withBootstrapLock(redis, bookId,
        () => bootstrapNextWindowUnderLock(bookId, progress, publishProgress, redis));
}

/** Next window, the caller already holds the bootstrap lock. */
async function bootstrapNextWindowUnderLock(bookId, progress, publishProgress, redis) {
    const _progress = progress || (() => {});

    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) {
        throw new Error(`Book ${bookId} not found`);
    }

    const agentService = require('./agent-service');
    const result = await agentService.bootstrapNextWindow(bookId, _progress, publishProgress, redis);

    return {
        book_id: result.bookId,
        title: result.title,
        state: result.state,
        characters: result.characters || 0,
        locations: result.locations || 0,
        scenes: result.scenes || 0,
        added_scenes: result.added_scenes || 0,
        remaining_cached: result.remaining_cached || 0,
        all_done: result.all_done || false,
        cached: result.cached || false,
        chapters: result.chapter ? [{
            chapter_id: result.chapter.chapter_id,
            chapter_title: result.chapter.chapter_title,
            chapter_index: result.chapter.chapter_index,
            status: result.chapter.status,
            scene_count: result.chapter.scenes ? result.chapter.scenes.length : 0,
        }] : [],
    };
}

// ======================================================
// LAZY PARSE WRAPPERS
// ======================================================

function lazyParseNext(bookId, windowSize) {
    return lazyBook.lazyParseNextWindow(bookId, windowSize || lazyBook.DEFAULT_WINDOW_SIZE);
}

function lazyParseToPosition(bookId, chapterIndex, windowSize) {
    const ws = windowSize || lazyBook.DEFAULT_WINDOW_SIZE;
    const result = lazyBook.lazyParseChapter(bookId, chapterIndex);

    if (!result.wasExisting) {
        const draft = lazyBook.loadDraftBook(bookId);
        const parsedIndices = new Set(
            draft.chapters.filter(c => c.chapter_index !== undefined).map(c => c.chapter_index)
        );
        let parsed = 1;
        for (let i = chapterIndex + 1; i < chapterIndex + ws && i < (draft.sourceText ? lazyBook.splitIntoChapters(draft.sourceText).length : 0); i++) {
            if (!parsedIndices.has(i)) {
                lazyBook.lazyParseChapter(bookId, i);
                parsed++;
            }
        }
        return { chapter: result.chapter, wasExisting: false, preParsedAhead: parsed - 1 };
    }

    return result;
}

function getParsedChaptersSummary(bookId) {
    return lazyBook.getChaptersSummary(bookId);
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    ProgressStage,
    decodeTxtBuffer,
    validateAiText,
    importTxtFile,
    importAiText,
    bootstrapImportedText,
    bootstrapImportedTextUnderLock,
    bootstrapNextWindow,
    bootstrapNextWindowUnderLock,
    lazyParseNext,
    lazyParseToPosition,
    getParsedChaptersSummary,
};
