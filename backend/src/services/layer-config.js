// ======================================================
// Layer Config Service
// ======================================================
// Persists per-book defaults for initial/bulk generation:
//   - audio_enabled:  base layer, always true (audio is the story narration)
//   - image_enabled:  storyboard / IU images
//   - video_enabled:  full video composition (requires image_enabled to be true)
//
// Storage (ORCHESTRATION_V2 §11.1, 2026-11-27) — PG ONLY:
//   table book_layer_config (book_id PK → books ON DELETE CASCADE,
//   config jsonb = the normalized object below, updated_at timestamptz).
//   Redis is not used: the former per-book Redis key (layer-config family) is
//   neither read nor written, a FLUSHDB does not touch the config.
//
//   book.json `layer_config` stays a best-effort copy (export / portability):
//     - set() writes it after the PG upsert (an fs failure never fails set);
//     - get() reads it ONCE when the book has no PG row yet and seeds the row
//       from it (lazy migration of books created before the table); with no
//       row and no copy get() returns DEFAULTS and writes nothing.
//
// Signatures: get(bookId), set(bookId, partial), getChunkSize(bookId). The
// former (redis, bookId[, partial]) form is still accepted — the redis
// argument is ignored — so not-yet-migrated callers keep working.
//
// Used by:
//   - GET  /api/v1/book/:bookId/layer-config (read)
//   - PUT  /api/v1/book/:bookId/layer-config (write)
//   - orchestration-v2 isLayerEnabled / POST /book/:id/generate
//   - VBook agent (chunk_size, analysis_*), player playback queue
//   - legacy runtime through the O-10 LayerConfigPort (storage/layer-config-adapter)

const fs = require('fs');
const path = require('path');
const config = require('../config/runtime-config');

const SCOPES = Object.freeze({
    CURRENT_SCENE:      'current_scene',
    CURRENT_CHAPTER:    'current_chapter',
    FROM_CURRENT_SCENE: 'from_current_scene',
    WHOLE_BOOK:         'whole_book',
});

const ANALYSIS_MODES = Object.freeze({
    SEQUENTIAL: 'sequential',
    PARALLEL:   'parallel',
});

// Lazy: require.cache stubs of the repository keep working in tests.
const repo = () => require('../storage/postgres/repositories/layer-config-repo');

// (bookId) | (redis, bookId): the legacy redis argument is accepted, ignored.
function _bookIdArg(a, b) {
    return typeof a === 'string' && b === undefined ? a : b;
}

const DEFAULTS = Object.freeze({
    audio_enabled: true,
    image_enabled: true,
    video_enabled: true,

    // VBook AI agent: how many scenes to generate per pass (1-5, default 3)
    chunk_size: 3,

    // Parallel/Subagent AI Analysis (Reconnaissance plan, Milestone #1).
    // 'sequential' = legacy behavior (extract_characters → voices → locations, in order).
    // 'parallel'   = independent AI tasks (characters + locations) run concurrently,
    //                voices still runs sequentially after characters (it consumes them).
    // Default is sequential — existing users / configs must continue working unchanged.
    analysis_mode: ANALYSIS_MODES.SEQUENTIAL,

    // Max concurrent LLM requests in parallel analysis mode (1..8).
    // Caps the number of in-flight AI calls regardless of how many tasks are scheduled.
    // Sequential mode ignores this value (each step is awaited in turn).
    analysis_parallelism: 3,

    // Per-worker generation timeouts (minutes). Controls GPU_TIMEOUT_MS.
    // Used by dispatch-engine to set per-type timeout for gpu-hub tasks.
    audio_timeout_minutes: 30,
    image_timeout_minutes: 30,
    video_timeout_minutes: 60,
});

function normalize(raw) {
    if (!raw) return { ...DEFAULTS };
    let obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { obj = {}; }
    }
    return {
        audio_enabled: obj.audio_enabled !== false,
        image_enabled: obj.image_enabled !== false,
        video_enabled: obj.video_enabled !== false,

        chunk_size: _clampInt(obj.chunk_size, 1, 5, DEFAULTS.chunk_size),

        analysis_mode: _clampAnalysisMode(obj.analysis_mode),
        analysis_parallelism: _clampInt(obj.analysis_parallelism, 1, 8, DEFAULTS.analysis_parallelism),

        audio_timeout_minutes: _clampInt(obj.audio_timeout_minutes, 5, 120, DEFAULTS.audio_timeout_minutes),
        image_timeout_minutes: _clampInt(obj.image_timeout_minutes, 5, 120, DEFAULTS.image_timeout_minutes),
        video_timeout_minutes: _clampInt(obj.video_timeout_minutes, 10, 180, DEFAULTS.video_timeout_minutes),
    };
}

function _clampAnalysisMode(value) {
    if (value === ANALYSIS_MODES.PARALLEL) return ANALYSIS_MODES.PARALLEL;
    return ANALYSIS_MODES.SEQUENTIAL;
}

function _clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/**
 * Per-book layer config. PG row → normalize; no row → the durable book.json
 * copy, inserted into PG (ON CONFLICT DO NOTHING — a concurrent writer wins
 * and its row is returned); no copy either → DEFAULTS, nothing written.
 * A book without a books row (not registered in PG) gets its durable copy
 * or DEFAULTS and no row. PG errors propagate (fail loud, as Redis did).
 */
async function get(a, b) {
    const bookId = _bookIdArg(a, b);
    if (!bookId) return { ...DEFAULTS };
    const stored = await repo().getConfig(bookId);
    if (stored) return normalize(stored);

    const durable = _readDurable(bookId);
    if (!durable) return { ...DEFAULTS };
    try {
        const seeded = await repo().insertIfMissing(bookId, durable);
        if (seeded) return normalize(seeded);
    } catch (err) {
        if (err.code !== repo().FOREIGN_KEY_VIOLATION) throw err;
    }
    return durable;
}

/**
 * Внутренний helper: нормализованная durable layer_config из book.json или null.
 * Форматы: multi-file <BOOKS_DIR>/<bookId>/book.json и legacy <BOOKS_DIR>/<bookId>.json.
 * Используется get() (засев отсутствующей PG-строки) и set() (база для merge,
 * когда строки ещё нет).
 * Best-effort: сбой чтения/парсинга → null.
 */
function _readDurable(bookId) {
    if (!bookId) return null;
    try {
        const booksDir = config.BOOKS_DIR;
        if (!booksDir) return null;
        const dirMeta = path.join(booksDir, bookId, 'book.json');
        const legacyMeta = path.join(booksDir, `${bookId}.json`);
        const metaPath = fs.existsSync(dirMeta) ? dirMeta : (fs.existsSync(legacyMeta) ? legacyMeta : null);
        if (!metaPath) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (!meta.layer_config || typeof meta.layer_config !== 'object') return null;
        return normalize(meta.layer_config);
    } catch (_) {
        return null;
    }
}

/**
 * Durable-копия конфига в book.json (best-effort; экспорт / переносимость).
 *
 * Читает book.json на диске (multi-file: <BOOKS_DIR>/<bookId>/book.json,
 * legacy: <BOOKS_DIR>/<bookId>.json), кладёт туда layer_config и перезаписывает.
 * Если книга ещё не записана на диск — просто пропускает (PG остаётся
 * единственным источником; копия появится при следующем set()).
 *
 * @returns {boolean} true если durable-копия записана
 */
function persistToBook(bookId, cfg) {
    if (!bookId || !cfg) return false;
    try {
        const booksDir = config.BOOKS_DIR;
        if (!booksDir) return false;

        const dirPath = path.join(booksDir, bookId);
        const metaPath = path.join(dirPath, 'book.json');
        if (!fs.existsSync(metaPath)) {
            // Legacy single-file format
            const legacyPath = path.join(booksDir, `${bookId}.json`);
            if (!fs.existsSync(legacyPath)) return false;
            const meta = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
            meta.layer_config = { ...cfg, updated_at: Date.now() };
            fs.writeFileSync(legacyPath, JSON.stringify(meta, null, 2));
            return true;
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.layer_config = { ...cfg, updated_at: Date.now() };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        return true;
    } catch (_) {
        // Best-effort: сбой диска не должен ломать живой set()
        return false;
    }
}

function _merge(current, partial) {
    return {
        audio_enabled: partial.audio_enabled !== undefined ? !!partial.audio_enabled : current.audio_enabled,
        image_enabled: partial.image_enabled !== undefined ? !!partial.image_enabled : current.image_enabled,
        video_enabled: partial.video_enabled !== undefined ? !!partial.video_enabled : current.video_enabled,

        chunk_size: partial.chunk_size !== undefined
            ? _clampInt(partial.chunk_size, 1, 5, current.chunk_size)
            : current.chunk_size,

        analysis_mode: partial.analysis_mode !== undefined
            ? _clampAnalysisMode(partial.analysis_mode)
            : current.analysis_mode,
        analysis_parallelism: partial.analysis_parallelism !== undefined
            ? _clampInt(partial.analysis_parallelism, 1, 8, current.analysis_parallelism)
            : current.analysis_parallelism,

        audio_timeout_minutes: partial.audio_timeout_minutes !== undefined
            ? _clampInt(partial.audio_timeout_minutes, 5, 120, current.audio_timeout_minutes)
            : current.audio_timeout_minutes,

        image_timeout_minutes: partial.image_timeout_minutes !== undefined
            ? _clampInt(partial.image_timeout_minutes, 5, 120, current.image_timeout_minutes)
            : current.image_timeout_minutes,

        video_timeout_minutes: partial.video_timeout_minutes !== undefined
            ? _clampInt(partial.video_timeout_minutes, 10, 180, current.video_timeout_minutes)
            : current.video_timeout_minutes,
    };
}

/**
 * Atomic partial update: one transaction, serialized per book by an advisory
 * lock (two concurrent set() on different fields both survive). Base for the
 * merge = the PG row, else the durable book.json copy, else DEFAULTS. The
 * book.json copy is written while the lock is held, so copies land in the
 * same order as the PG writes (best-effort: an fs failure is ignored).
 * A book without a books row (not registered in PG — e.g. an import whose
 * workspace could not be resolved): no PG row can exist, so the merged config
 * goes to the book.json copy only (best-effort, not serialized) and is
 * returned as before; get() seeds the PG row from it once the book is
 * registered. The API answer does not change.
 */
async function set(a, b, c) {
    const [bookId, partial] = typeof a === 'string' ? [a, b] : [b, c];
    if (!bookId) return { ...DEFAULTS };
    try {
        return await repo().update(
            bookId,
            (stored) => _merge(
                stored ? normalize(stored) : (_readDurable(bookId) || { ...DEFAULTS }),
                partial || {}),
            (next) => { persistToBook(bookId, next); }
        );
    } catch (err) {
        if (err.code !== repo().FOREIGN_KEY_VIOLATION) throw err;
        const next = _merge(_readDurable(bookId) || { ...DEFAULTS }, partial || {});
        persistToBook(bookId, next);
        console.warn(`[LAYER-CONFIG] ${bookId}: no books row — config kept in book.json only until the book is registered`);
        return next;
    }
}

function isValidScope(value) {
    return Object.values(SCOPES).includes(value);
}

/**
 * Per-book VBook window size (scenes per pass) — the effective chunk size the
 * AI pipeline actually uses. Reads layer-config chunk_size (1..5) and falls
 * back to MAX_SCENES_PER_CHUNK when unset/unavailable. Single source of truth
 * shared by bootstrap._readChunkSize (what the pipeline processes) and the
 * /agent-status route (what the frontend progress counter displays) so the two
 * can never drift apart.
 */
async function getChunkSize(a, b) {
    const { MAX_SCENES_PER_CHUNK } = require('./agent-prompts');
    const bookId = _bookIdArg(a, b);
    try {
        if (bookId) {
            const cfg = await get(bookId);
            if (cfg && cfg.chunk_size >= 1 && cfg.chunk_size <= 5) {
                return cfg.chunk_size;
            }
        }
    } catch (_) { /* best-effort */ }
    return MAX_SCENES_PER_CHUNK;
}

module.exports = {
    SCOPES,
    ANALYSIS_MODES,
    DEFAULTS,
    get,
    set,
    normalize,
    isValidScope,
    getChunkSize,
    persistToBook,
};
