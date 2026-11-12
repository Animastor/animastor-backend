// ======================================================
// voice — the ONE port to a character's voice (VOICE_REFERENCES.md)
// ======================================================
// Every consumer (audio generation, voice-reference API, editor, analysis
// writer) reads and writes a character's voice ONLY through these functions.
// Storage today (format 3.1): voices.json[character_id] =
//   { timbre, manner, timbre_source, reference }
// Format v4 (VBOOK_FORMAT_V4, one file per character) moves the same object
// to characters/<id>.json → voice; only the two accessors below change.
//
// The narrator is a character with id "narrator".
// No legacy `instruction` field is read: voices of format «instruction only»
// are not supported (owner decision 2026-11-12 — books are regenerated).

'use strict';

const NARRATOR_ID = 'narrator';
const TIMBRE_SOURCES = Object.freeze(['cleaned', 'user', 'analysis']);
const REFERENCE_SOURCES = Object.freeze(['designed', 'uploaded']);
const VERIFICATION_STATES = Object.freeze(['passed', 'failed']);
const REFERENCE_FILE_RE = /^voices\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.wav$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// ── storage (the only place that knows where the voice lives) ───────────
function voiceStore(book, create) {
    if (!book || typeof book !== 'object') return null;
    if (!book.voices || typeof book.voices !== 'object' || Array.isArray(book.voices)) {
        if (!create) return null;
        book.voices = {};
    }
    return book.voices;
}

function rawVoice(book, characterId) {
    const store = voiceStore(book, false);
    const v = store ? store[characterId] : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// ── reference object ─────────────────────────────────────────────────────
/** @returns {string|null} reason the reference object is malformed, null when valid */
function referenceProblem(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 'reference must be an object';
    if (typeof ref.file !== 'string' || !REFERENCE_FILE_RE.test(ref.file)) return 'reference.file must be voices/<id>/<candidate>.wav';
    if (typeof ref.ref_text !== 'string' || !ref.ref_text.trim()) return 'reference.ref_text must be a non-empty string';
    if (!REFERENCE_SOURCES.includes(ref.source)) return `reference.source must be ${REFERENCE_SOURCES.join('|')}`;
    if (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256)) return 'reference.sha256 must be 64 lowercase hex';
    if (!VERIFICATION_STATES.includes(ref.verification)) return `reference.verification must be ${VERIFICATION_STATES.join('|')}`;
    if (typeof ref.locked !== 'boolean') return 'reference.locked must be boolean';
    if (ref.seed !== undefined && ref.seed !== null && !Number.isSafeInteger(ref.seed)) return 'reference.seed must be an integer';
    if (ref.model !== undefined && ref.model !== null && typeof ref.model !== 'string') return 'reference.model must be a string';
    return null;
}

function normaliseReference(ref) {
    if (!ref || referenceProblem(ref)) return null;
    const out = {
        file: ref.file,
        ref_text: ref.ref_text,
        source: ref.source,
        model: typeof ref.model === 'string' ? ref.model : null,
        seed: Number.isSafeInteger(ref.seed) ? ref.seed : null,
        sha256: ref.sha256,
        verification: ref.verification,
        locked: ref.locked,
    };
    if (typeof ref.candidate_id === 'string') out.candidate_id = ref.candidate_id;
    if (typeof ref.language === 'string') out.language = ref.language;
    return out;
}

// ── public port ───────────────────────────────────────────────────────────
/**
 * The voice of a character (narrator = "narrator").
 * @returns {null|{id:string, timbre:string, manner:string, timbre_source:string|null,
 *                 reference:object|null, reference_problem:string|null}}
 *          reference_problem ≠ null when a reference object is present but malformed.
 */
function getCharacterVoice(book, characterId) {
    if (typeof characterId !== 'string' || !characterId) return null;
    const v = rawVoice(book, characterId);
    if (!v) return null;
    const hasRef = v.reference !== undefined && v.reference !== null;
    return {
        id: characterId,
        timbre: str(v.timbre),
        manner: str(v.manner),
        timbre_source: TIMBRE_SOURCES.includes(v.timbre_source) ? v.timbre_source : null,
        reference: hasRef ? normaliseReference(v.reference) : null,
        reference_problem: hasRef ? referenceProblem(v.reference) : null,
    };
}

/** ids of every voice entry of the book (narrator included when present) */
function listVoiceIds(book) {
    const store = voiceStore(book, false);
    return store ? Object.keys(store).filter((id) => rawVoice(book, id)) : [];
}

/**
 * Set (or clear with null) the reference of an EXISTING voice. Mutates the
 * book object; the host persists it (bookModel commit).
 * @throws {Error} code 'voice_not_found' | 'bad_reference'
 */
function setCharacterVoiceReference(book, characterId, reference) {
    const v = rawVoice(book, characterId);
    if (!v) throw Object.assign(new Error(`voice ${characterId} not found`), { code: 'voice_not_found' });
    if (reference === null) { delete v.reference; return null; }
    const problem = referenceProblem(reference);
    if (problem) throw Object.assign(new Error(problem), { code: 'bad_reference' });
    v.reference = normaliseReference(reference);
    return v.reference;
}

/**
 * Create / update the description part of a voice (timbre, manner).
 * Creates the entry when missing. Mutates the book object.
 */
function setCharacterVoiceDescription(book, characterId, { timbre, manner, timbre_source } = {}) {
    if (typeof characterId !== 'string' || !characterId) throw Object.assign(new Error('characterId required'), { code: 'bad_request' });
    const store = voiceStore(book, true);
    const v = rawVoice(book, characterId) || (store[characterId] = {});
    if (timbre !== undefined) v.timbre = str(timbre);
    if (manner !== undefined) v.manner = str(manner);
    if (timbre_source !== undefined) {
        if (timbre_source !== null && !TIMBRE_SOURCES.includes(timbre_source)) {
            throw Object.assign(new Error(`timbre_source must be ${TIMBRE_SOURCES.join('|')}`), { code: 'bad_request' });
        }
        if (timbre_source === null) delete v.timbre_source; else v.timbre_source = timbre_source;
    }
    return getCharacterVoice(book, characterId);
}

/**
 * The narrator voice id of a scene: scene.audio.voice unless it is a scene-type
 * marker ("dialogue" / "narration"), else book.defaults.narration_voice, else "narrator".
 */
function narratorVoiceId(scene, book) {
    const raw = scene && scene.audio ? scene.audio.voice : null;
    if (typeof raw === 'string' && raw && raw !== 'dialogue' && raw !== 'narration') return raw;
    const d = book && book.book && book.book.defaults ? book.book.defaults.narration_voice : null;
    return typeof d === 'string' && d ? d : NARRATOR_ID;
}

/**
 * Text given to VoiceDesign for a reference candidate.
 * Narrator: the FULL description — timbre + narrator manner (constant, the
 * clone copies it). Characters: timbre only (neutral reference).
 */
function voiceDesignDescription(voice) {
    if (!voice) return '';
    if (voice.id === NARRATOR_ID) return [voice.timbre, voice.manner].filter(Boolean).join(' ').trim();
    return voice.timbre;
}

// ── rule-based cleanup of an analysis description (no LLM) ──────────────
// A description written by analysis may carry situational / plot directions
// ("cheerful inflection on 'поехали?'", "When the interlocutor is a close
// friend, …"). A reference must be neutral, so such sentences are dropped:
//   • sentences containing quoted text («…», “…”, "…", '…' around a word);
//   • conditional sentences (when / whenever / if / unless / as soon as,
//     когда / если / как только, wenn / falls / sobald).
// The result is shown to the user and may be edited (timbre_source 'cleaned' →
// 'user'). Rule changes bump CLEANUP_RULES_VERSION.
const CLEANUP_RULES_VERSION = 1;
const QUOTED_RE = /[«“„]|"[^"]+"|(^|[\s(])'[^'\s][^']*'/u;
const CONDITIONAL_RE = /(^|[^\p{L}])(when|whenever|if|unless|as soon as|когда|если|как только|wenn|falls|sobald)(?=$|[^\p{L}])/iu;

function splitSentences(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"“'(])/u)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * @returns {{timbre:string, removed:string[], rules_version:number}}
 */
function cleanVoiceDescription(text) {
    const kept = [];
    const removed = [];
    for (const s of splitSentences(text)) {
        if (QUOTED_RE.test(s) || CONDITIONAL_RE.test(s)) removed.push(s);
        else kept.push(s);
    }
    return { timbre: kept.join(' '), removed, rules_version: CLEANUP_RULES_VERSION };
}

/** A voice entry created from an analysis description (cleaned, not yet reviewed). */
function voiceFromDescription(text) {
    const { timbre } = cleanVoiceDescription(text);
    return { timbre, manner: '', timbre_source: 'cleaned' };
}

module.exports = {
    NARRATOR_ID,
    TIMBRE_SOURCES,
    REFERENCE_SOURCES,
    CLEANUP_RULES_VERSION,
    getCharacterVoice,
    listVoiceIds,
    setCharacterVoiceReference,
    setCharacterVoiceDescription,
    narratorVoiceId,
    voiceDesignDescription,
    cleanVoiceDescription,
    voiceFromDescription,
    referenceProblem,
};
