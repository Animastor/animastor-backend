// ======================================================
// voice — the ONE port to a character's voice (VOICE_REFERENCES.md)
// ======================================================
// Every consumer (audio generation, voice-reference API, editor, analysis
// writer) reads and writes a character's voice ONLY through these functions.
//
// Storage (VBOOK_FORMAT_V4 §5): the hero file characters/<id>.json →
//   voice: { timbre, manner, timbre_source?, reference? }
// in memory book.heroes[].voice. Only the accessors of the "storage" block
// below know that; the port's names, fields and checks are the ones of the
// voice-reference task. The 3.1 map voices.json / book.voices is gone.
//
// The narrator is the hero with id "narrator".
// There is no `instruction` field in VBook 4 and none is read.
//
// The audio reference itself is content, not part of the .vbook: it lives in
// build_<book_id>/voices/<hero id>/. resolveReferenceFile is the only way a
// stored link becomes a path, and it refuses anything outside that folder.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { findHero, isValidHeroId } = require('./heroes.cjs');
const { CHARACTER_SCHEMA, VOICE_REFERENCE_FILE_RE } = require('./character-validator.cjs');
const { joinInside, assertInside } = require('./safe-paths');

const NARRATOR_ID = 'narrator';
const TIMBRE_SOURCES = Object.freeze(['cleaned', 'user', 'analysis']);
const REFERENCE_SOURCES = Object.freeze(['designed', 'uploaded']);
// Automatic transcript check of a designed reference. An uploaded sample may
// instead carry 'user' — a person confirmed the text — or no value at all
// (owner's decision В1, 14.11; the hero-file schema states the same).
const VERIFICATION_STATES = Object.freeze(['passed', 'failed']);
const UPLOADED_VERIFICATION_STATES = Object.freeze(['passed', 'failed', 'user']);
const REFERENCE_FILE_RE = /^voices\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.wav$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// ── storage (the only place that knows where the voice lives) ───────────
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function rawVoice(book, characterId) {
    const hero = findHero(book, characterId);
    return hero && isPlainObject(hero.voice) ? hero.voice : null;
}

/** The hero's voice object, created when missing (and the hero with it). */
function ensureVoice(book, characterId) {
    if (!book || typeof book !== 'object') throw Object.assign(new Error('book required'), { code: 'bad_request' });
    let hero = findHero(book, characterId);
    if (!hero) {
        // A speaker with a voice of its own is a hero without a passport (§7).
        if (!isValidHeroId(characterId)) {
            throw Object.assign(new Error(`invalid character id ${JSON.stringify(characterId)}`), { code: 'bad_request' });
        }
        hero = { schema: CHARACTER_SCHEMA, id: characterId };
        if (characterId === NARRATOR_ID) hero.role = NARRATOR_ID;
        if (!Array.isArray(book.heroes)) book.heroes = [];
        book.heroes.push(hero);
    }
    if (!isPlainObject(hero.voice)) hero.voice = {};
    return hero.voice;
}

function voiceIds(book) {
    const list = book && Array.isArray(book.heroes) ? book.heroes : [];
    return list.filter((h) => isPlainObject(h) && typeof h.id === 'string' && isPlainObject(h.voice)).map((h) => h.id);
}

/** voices/<id>/… — the folder segment of a reference link, or null */
function referenceDir(ref) {
    const file = ref && typeof ref.file === 'string' ? ref.file : '';
    const parts = file.split('/');
    return parts.length === 3 && parts[0] === 'voices' ? parts[1] : null;
}

// ── reference object ─────────────────────────────────────────────────────
/** @returns {string|null} reason the reference object is malformed, null when valid */
function referenceProblem(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 'reference must be an object';
    if (typeof ref.file !== 'string' || !REFERENCE_FILE_RE.test(ref.file)) return 'reference.file must be voices/<id>/<candidate>.wav';
    if (typeof ref.ref_text !== 'string' || !ref.ref_text.trim()) return 'reference.ref_text must be a non-empty string';
    if (!REFERENCE_SOURCES.includes(ref.source)) return `reference.source must be ${REFERENCE_SOURCES.join('|')}`;
    if (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256)) return 'reference.sha256 must be 64 lowercase hex';
    if (ref.source === 'designed') {
        if (!VERIFICATION_STATES.includes(ref.verification)) return `reference.verification must be ${VERIFICATION_STATES.join('|')}`;
    } else if (ref.verification !== undefined && ref.verification !== null && !UPLOADED_VERIFICATION_STATES.includes(ref.verification)) {
        return `reference.verification must be ${UPLOADED_VERIFICATION_STATES.join('|')}`;
    }
    if (typeof ref.locked !== 'boolean') return 'reference.locked must be boolean';
    if (ref.seed !== undefined && ref.seed !== null && !Number.isSafeInteger(ref.seed)) return 'reference.seed must be an integer';
    if (ref.model !== undefined && ref.model !== null && typeof ref.model !== 'string') return 'reference.model must be a string';
    if (ref.source_timbre_sha256 !== undefined && ref.source_timbre_sha256 !== null
        && (typeof ref.source_timbre_sha256 !== 'string' || !SHA256_RE.test(ref.source_timbre_sha256))) {
        return 'reference.source_timbre_sha256 must be 64 lowercase hex';
    }
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
        verification: ref.verification === undefined ? null : ref.verification,
        locked: ref.locked,
    };
    if (typeof ref.candidate_id === 'string') out.candidate_id = ref.candidate_id;
    if (typeof ref.language === 'string') out.language = ref.language;
    if (typeof ref.source_timbre_sha256 === 'string') out.source_timbre_sha256 = ref.source_timbre_sha256;
    return out;
}

/**
 * sha256 of a timbre text as it is compared (owner's decision 18.11): UTF-8 of
 * the trimmed string; an empty or absent timbre hashes the empty string.
 */
function timbreSha256(timbre) {
    return crypto.createHash('sha256').update(str(timbre), 'utf8').digest('hex');
}

/**
 * Was the reference made from another timbre than the one the hero has now?
 * Only a reference that remembers its timbre (source_timbre_sha256, written on
 * pinning since 18.11) can be outdated; without it the answer is false.
 * Nothing is regenerated automatically — the API only reports it.
 */
function isReferenceOutdated(voice) {
    const ref = voice && isPlainObject(voice.reference) ? voice.reference : null;
    if (!ref || typeof ref.source_timbre_sha256 !== 'string') return false;
    return ref.source_timbre_sha256 !== timbreSha256(voice.timbre);
}

/**
 * May this reference be used for synthesis as far as verification goes?
 * designed → the automatic check passed; uploaded → passed, or confirmed by a
 * person ('user').
 */
function isReferenceVerified(ref) {
    if (!ref) return false;
    if (ref.verification === 'passed') return true;
    return ref.source === 'uploaded' && ref.verification === 'user';
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
    let problem = hasRef ? referenceProblem(v.reference) : null;
    // a hero's reference lives in that hero's folder, nobody else's
    if (hasRef && !problem && referenceDir(v.reference) !== characterId) {
        problem = `reference.file must be inside voices/${characterId}/`;
    }
    return {
        id: characterId,
        timbre: str(v.timbre),
        manner: str(v.manner),
        timbre_source: TIMBRE_SOURCES.includes(v.timbre_source) ? v.timbre_source : null,
        reference: hasRef && !problem ? normaliseReference(v.reference) : null,
        reference_problem: problem,
    };
}

/** ids of every voice entry of the book (narrator included when present) */
function listVoiceIds(book) {
    return voiceIds(book);
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
    if (referenceDir(reference) !== characterId) {
        throw Object.assign(new Error(`reference.file must be inside voices/${characterId}/`), { code: 'bad_reference' });
    }
    const normalised = normaliseReference(reference);
    // The hero file follows animastor.character/1, where model is a string and
    // seed an integer: "no value" (an uploaded sample has neither) is stored
    // as an absent key, not as null. Readers still get null from
    // getCharacterVoice, exactly as before.
    const stored = { ...normalised };
    if (stored.model === null) delete stored.model;
    if (stored.seed === null) delete stored.seed;
    if (stored.verification === null) delete stored.verification;
    v.reference = stored;
    return normalised;
}

/**
 * Create / update the description part of a voice (timbre, manner).
 * Creates the entry when missing. Mutates the book object.
 */
function setCharacterVoiceDescription(book, characterId, { timbre, manner, timbre_source } = {}) {
    if (typeof characterId !== 'string' || !characterId) throw Object.assign(new Error('characterId required'), { code: 'bad_request' });
    const v = ensureVoice(book, characterId);
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

// ── reference file on disk (content folder, never the .vbook) ───────────
/**
 * Absolute path of a stored reference link.
 * The link must be voices/<hero id>/<name>.wav, relative to
 * `buildDir` (= <output>/build_<book_id>). Absolute paths, "..", "." and
 * backslashes are refused, and the resolved path is re-checked to lie inside
 * <buildDir>/voices/<hero id>/.
 * @param {string} buildDir
 * @param {{file: string}} reference
 * @param {string} [characterId] when given, the link must point into this hero's folder
 * @returns {string}
 * @throws {Error} code 'bad_reference'
 */
function resolveReferenceFile(buildDir, reference, characterId) {
    const bad = (why) => Object.assign(new Error(`bad reference link: ${why}`), { code: 'bad_reference' });
    const file = reference && typeof reference === 'object' ? reference.file : undefined;
    if (typeof file !== 'string' || !file) throw bad('file is missing');
    if (file.includes('\\') || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) throw bad('not a relative link');
    if (file.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') || file.includes('..')) throw bad('path traversal');
    if (!VOICE_REFERENCE_FILE_RE.test(file)) throw bad('must be voices/<hero id>/<name>.wav');
    const [, heroId, name] = file.split('/');
    if (!isValidHeroId(heroId)) throw bad('invalid hero id');
    if (characterId !== undefined && heroId !== characterId) throw bad(`must be inside voices/${characterId}/`);
    try {
        const voiceDir = joinInside(buildDir, 'voices', heroId);
        return assertInside(voiceDir, joinInside(voiceDir, name));
    } catch (_) {
        throw bad('outside the voices folder');
    }
}

/**
 * Computed state of a reference (never stored): 'ok' — the file exists and its
 * sha256 matches; 'missing' — no link, a bad link or no regular file there;
 * 'mismatch' — the file changed. Symbolic links are not followed.
 */
function referenceState(buildDir, reference, characterId) {
    let file;
    try {
        file = resolveReferenceFile(buildDir, reference, characterId);
    } catch (_) {
        return 'missing';
    }
    let st = null;
    try { st = fs.lstatSync(file); } catch (_) { st = null; }
    if (!st || !st.isFile()) return 'missing';
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return sha === reference.sha256 ? 'ok' : 'mismatch';
}

// ── rule-based cleanup of an analysis description (no LLM) ──────────────
// A description written by analysis may carry situational / plot directions
// ("cheerful inflection on 'поехали?'", "When the interlocutor is a close
// friend, …"). A reference must be neutral, so such text is dropped:
//   • sentences containing quoted text («…», “…”, "…", '…' around a word);
//   • sentences tied to particular words of the text, quoted or not
//     ("on the word …", "на слове …", "на фразе …", "beim Wort …") — since v2;
//   • conditions (when / whenever / if / unless / as soon as, когда / если /
//     как только, wenn / falls / sobald). Since v4 the CONDITIONAL CLAUSE is
//     cut and the main part stays ("Confident and lecturing, with an
//     authoritative, steady pace; becomes hurried and tremulous when anxious."
//     → "Confident and lecturing, with an authoritative, steady pace."). A
//     sentence that STARTS with the condition ("When angry, he shouts.") is
//     conditional as a whole and is dropped; so is a clause that only states
//     the other case ("otherwise …", "иначе …"). Up to v3 the whole sentence
//     went;
//   • episodic physical states — hiccups, drunkenness, crying, illness, being
//     out of breath: a moment of the plot, not the voice. The CLAUSE that
//     names the state is cut, the rest of the sentence stays ("Impulsive and
//     irritable, with frequent hiccups …" → "Impulsive and irritable.") — v3;
//   • timbre only, v4: appearance that is not the voice. Sex, age and build
//     (tall, thin, plump, broad-shouldered) may stay — they tell what the
//     voice is. Hair and baldness, beard and moustache, glasses, clothes and
//     other looks are cut ("of a small, plump bald man" → "of a small, plump
//     man"; "in a grey suit", "в сером костюме" — removed).
// The result is shown to the user and may be edited (timbre_source 'cleaned' →
// 'user'). Rule changes bump CLEANUP_RULES_VERSION.
//
// v3 also owns the pronunciation suffix of timbre (voiceFromAnalysis with the
// book language): "Native <language of the book> pronunciation." — never
// another language, and none at all when the timbre names an accent (an accent
// is a legitimate part of timbre). This is normalisation, not a removal: it does
// not turn timbre_source into 'cleaned'.
const CLEANUP_RULES_VERSION = 4;
const ON_WORD_RE = /(^|[^\p{L}])(on the (word|words|phrase|line)|at the (word|words|phrase|line)|на (слове|словах|фразе|реплике)|beim wort|bei den worten)(?=$|[^\p{L}])/iu;
const QUOTED_RE = /[«“„]|"[^"]+"|(^|[\s(])'[^'\s][^']*'/u;
const CONDITIONAL_RE = /(^|[^\p{L}])(when|whenever|if|unless|as soon as|когда|если|как только|wenn|falls|sobald)(?=$|[^\p{L}])/iu;
const LEADING_CONDITIONAL_RE = /^\s*(when|whenever|if|unless|as soon as|когда|если|как только|wenn|falls|sobald)(?=$|[^\p{L}])/iu;
const OTHERWISE_RE = /^\s*(otherwise|else|in other cases|иначе|в остальн\p{L}* (случаях|время)|sonst)(?=$|[^\p{L}])/iu;
// Episodic physical states (v3). Word starts, so "hiccups", "hiccuping",
// "drunken", "sobbing", "feverish" match; "breathy" (a texture) and
// "ill-tempered" (a character) do not.
const EPISODIC_STATE_RE = new RegExp([
    'hiccup', 'hiccough', 'икот', 'ика(ет|я|ющ)',
    'drunk', 'intoxicat', 'tipsy', 'inebriat', 'пьян', 'нетрезв', 'хмельн',
    'crying', 'cries', 'sobb?ing', 'sobs', 'in tears', 'through tears', 'tearful', 'weeping', 'плач', 'рыда', 'сквозь сл[её]зы', 'всхлип',
    'ill(?![\\p{L}-])', 'sick(?![\\p{L}-])', 'feverish', 'fever', '(with|from) a cold', 'flu(?!\\p{L})', 'болен', 'больн', 'простуж', 'температур',
    'out of breath', 'short of breath', 'breathless', 'panting', 'gasping for', 'winded', 'запыхав', 'запыхал', 'задыха', 'одышк',
].map((w) => `(?<![\\p{L}])${w}`).join('|'), 'iu');

// Appearance in timbre (v4). Nouns of looks and clothes — whole words (with
// plural / case endings), so "cap" does not hit "capable", "hat" not "that".
const LOOKS_NOUN_EN = '(?:hair|haircut|beard|goatee|moustache|mustache|sideburns|stubble|glasses|spectacles|pince-nez|monocle|bald (?:head|patch|spot)|scar|freckles|wig|suit|coat|overcoat|jacket|cap|hat|beret|shirt|trousers|pants|jeans|boots|shoes|sandals|dress|skirt|tie|uniform|robe|cloak|gown|vest|waistcoat|sweater|tunic|clothes|clothing|attire|outfit)(?:s|es)?';
const LOOKS_NOUN_RU = '(?:костюм|пиджак|пальто|плащ|куртк|кепк|кепочк|шляп|фуражк|берет[еаоуы]|рубаш|рубах|ковбойк|брюк|штан|сапог|ботин|туфл|плать|юбк|галстук|мундир|форм[еуой]|халат|одежд|очк|пенсне|монокл|бород|бородк|усам|усах|усы|усик|бакенбард|щетин|лысин|плеш|волос|причёск|прическ|шрам|веснушк|парик)\\p{L}{0,4}';
const LOOKS_PHRASE_EN_RE = new RegExp(`\\s*,?\\s*(?<![\\p{L}])(?:with|in|wearing|dressed in|clad in)\\s+(?:[\\p{L}'-]+\\s+){0,4}?${LOOKS_NOUN_EN}(?![\\p{L}-])(?:\\s+and\\s+(?:[\\p{L}'-]+\\s+){0,3}?${LOOKS_NOUN_EN}(?![\\p{L}-]))?`, 'giu');
const LOOKS_PHRASE_RU_RE = new RegExp(`\\s*,?\\s*(?<![\\p{L}])(?:с|со|в|во|одет\\p{L}*\\s+в)\\s+(?:[\\p{L}-]+\\s+){0,3}?${LOOKS_NOUN_RU}(?![\\p{L}])(?:\\s+и\\s+(?:[\\p{L}-]+\\s+){0,2}?${LOOKS_NOUN_RU}(?![\\p{L}]))?`, 'giu');
// Adjectives of looks: bald, red-haired, bearded, bespectacled, лысый, рыжий …
const LOOKS_ADJ = [
    'bald(?:ing)?', 'balding', '[\\p{L}]+-haired', '(?:red|grey|gray|white|bald)-headed', 'bearded', 'beardless',
    'moustached', 'mustached', 'mustachioed', 'bespectacled', 'freckled', 'freckle-faced', '(?:clean-)?shaven', 'curly', 'wavy-haired', '[\\p{L}]+-eyed',
    'лыс\\p{L}*', 'лысеющ\\p{L}*', 'плешив\\p{L}*', 'рыж\\p{L}*', 'седовлас\\p{L}*', 'сед(?:ой|ая|ое|ые|ого|ую|ым|ыми|ых|ому|ою|ой)', '\\p{L}*волос\\p{L}*',
    'бородат\\p{L}*', 'безбород\\p{L}*', 'усат\\p{L}*', 'очкаст\\p{L}*', 'кудряв\\p{L}*', 'веснушчат\\p{L}*', 'бритоголов\\p{L}*', '\\p{L}+глаз\\p{L}*',
].join('|');
const LOOKS_ADJ_RE = new RegExp(`(\\s*,\\s*|\\s+(?:and|и)\\s+|\\s+|^)(?<![\\p{L}-])(?:${LOOKS_ADJ})(?![\\p{L}-])(\\s*,)?`, 'giu');
// "He has red hair", "wears a grey suit", "носит очки" — a clause that only states looks.
const LOOKS_CLAUSE_RE = new RegExp(`^\\s*(?:(?:he|she|they)\\s+)?(?:has|have|wears|wearing|is wearing|dressed|clad|носит|одет\\p{L}*|у (?:него|неё|нее))(?![\\p{L}])[^]*(?<![\\p{L}])(?:${LOOKS_NOUN_EN}|${LOOKS_NOUN_RU})(?![\\p{L}])`, 'iu');

function splitSentences(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"“'(])/u)
        .map((s) => s.trim())
        .filter(Boolean);
}

// A sentence → its clauses with the separators that were between them, so a
// sentence with a clause cut out keeps its own punctuation.
const CLAUSE_SEP_RE = /(\s*[,;]\s*|\s+[—–]\s+)/;
const DANGLING_RE = /^(with|and|but|or|while|и|а|но|с|или)$/i;

/**
 * Cut the clauses `drop(clause, { sep, previousCut })` says yes to. Returns the sentence that is
 * left ('' when nothing meaningful is) and the clauses cut.
 */
function cutClauses(sentence, drop) {
    const end = /[.!?…]$/.test(sentence) ? sentence.slice(-1) : '.';
    const body = sentence.replace(/[.!?…]+$/, '');
    const parts = body.split(CLAUSE_SEP_RE);
    const clauses = [];
    for (let i = 0; i < parts.length; i += 2) clauses.push({ sep: i === 0 ? '' : parts[i - 1], text: parts[i] });
    const cut = [];
    const kept = [];
    let previousCut = false;
    for (const c of clauses) {
        if (drop(c.text, { sep: c.sep, previousCut })) { cut.push(c.text.trim()); previousCut = true; continue; }
        previousCut = false;
        if (!/\p{L}/u.test(c.text)) continue;
        kept.push(c);
    }
    if (cut.length === 0) return { kept: sentence, cut };
    // what is left must still say something: a dangling "with" / "and" is not a clause
    const meaningful = kept.filter((c) => !DANGLING_RE.test(c.text.trim()));
    if (meaningful.length === 0) return { kept: '', cut };
    let joined = meaningful.map((c, i) => (i === 0 ? c.text.trim() : `${c.sep}${c.text}`)).join('');
    joined = joined.replace(/\s*[,;—–]\s*$/, '');
    return { kept: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}${end}`, cut };
}

// Cut the clauses of one sentence that name an episodic state (v3).
function cutEpisodicStates(sentence) {
    if (!EPISODIC_STATE_RE.test(sentence)) return { kept: sentence, cut: [] };
    return cutClauses(sentence, (c) => EPISODIC_STATE_RE.test(c));
}

// Cut the conditional clause (v4); a sentence that starts with the condition
// goes as a whole.
function cutConditions(sentence) {
    if (!CONDITIONAL_RE.test(sentence)) return { kept: sentence, cut: [] };
    if (LEADING_CONDITIONAL_RE.test(sentence)) return { kept: '', cut: [sentence] };
    // "…, когда волнуется — сбивается": the part after a dash that follows a
    // condition is its consequence and goes with it
    return cutClauses(sentence, (c, { sep, previousCut }) => CONDITIONAL_RE.test(c) || OTHERWISE_RE.test(c)
        || (previousCut && /[—–]/.test(sep)));
}

// Appearance that is not the voice (v4, timbre only).
function cutAppearance(sentence) {
    const cut = [];
    let out = sentence;
    const take = (re, keep) => {
        out = out.replace(re, (m, ...g) => {
            const piece = m.trim().replace(/^[,;]\s*|\s*,$/g, '').replace(/^(and|и)\s+/i, '');
            if (piece) cut.push(piece);
            return keep(m, ...g);
        });
    };
    take(LOOKS_PHRASE_EN_RE, () => '');
    take(LOOKS_PHRASE_RU_RE, () => '');
    // an adjective: keep the separator before it when one stays meaningful
    // ("a small, plump bald man" → "a small, plump man"; "a bald, plump man" → "a plump man")
    take(LOOKS_ADJ_RE, (m, before, after) => {
        if (/^\s*,/.test(before || '') && after) return ',';
        if (/^\s*,/.test(before || '') || /^\s+(and|и)\s+/i.test(before || '')) return '';
        return (before || '') === '' ? '' : ' ';
    });
    if (cut.length > 0) {
        out = out
            .replace(/\s{2,}/g, ' ')
            .replace(/\s+([,.;!?…])/g, '$1')
            .replace(/,\s*,/g, ',')
            .replace(/(^|[^\p{L}])(a|an|the)\s*,\s*/giu, '$1$2 ')
            .replace(/(^|[^\p{L}])(a|an|the)\s+(and|,)\s+/giu, '$1$2 ')
            .replace(/(^|[^\p{L}])a(\s+)(?=[aeio]\p{L})/gu, '$1an$2')
            .replace(/(^|[^\p{L}])an(\s+)(?=[^aeiouh\s]\p{L})/gu, '$1a$2')
            .replace(/^[\s,;]+/, '')
            .trim();
    }
    const clauses = cutClauses(out, (c) => LOOKS_CLAUSE_RE.test(c));
    cut.push(...clauses.cut);
    out = clauses.kept;
    if (out && !/\p{L}/u.test(out.replace(/[.!?…]/g, ''))) out = '';
    if (cut.length === 0) return { kept: sentence, cut };
    return { kept: out ? `${out.charAt(0).toUpperCase()}${out.slice(1)}` : '', cut };
}

/**
 * @param {string} text
 * @param {{ appearance?: boolean }} [options]  appearance: cut looks too (timbre)
 * @returns {{timbre:string, removed:string[], rules_version:number}}
 */
function cleanVoiceDescription(text, options = {}) {
    const kept = [];
    const removed = [];
    for (const s of splitSentences(text)) {
        if (QUOTED_RE.test(s) || ON_WORD_RE.test(s)) { removed.push(s); continue; }
        let sentence = s;
        for (const rule of options.appearance ? [cutConditions, cutEpisodicStates, cutAppearance] : [cutConditions, cutEpisodicStates]) {
            if (!sentence) break;
            const r = rule(sentence);
            removed.push(...r.cut);
            sentence = r.kept;
        }
        if (sentence) kept.push(sentence);
    }
    return { timbre: kept.join(' '), removed, rules_version: CLEANUP_RULES_VERSION };
}

// ── pronunciation suffix of timbre (v3) ─────────────────────────────────
const LANGUAGE_NAMES = Object.freeze({
    ru: 'Russian', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
    uk: 'Ukrainian', be: 'Belarusian', pl: 'Polish', cs: 'Czech', pt: 'Portuguese', nl: 'Dutch',
    sv: 'Swedish', fi: 'Finnish', tr: 'Turkish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    ar: 'Arabic', he: 'Hebrew', kk: 'Kazakh',
});
const PRONUNCIATION_RE = /\s*(?:[,;]\s*)?\b(?:with\s+)?(?:a\s+)?native\s+(?:[\p{L}-]+\s+){1,2}pronunciation\b[.!]?/giu;
const ACCENT_RE = /(^|[^\p{L}])(accent|accented|акцент)/iu;

/** Name of a book language for the suffix ('' when unknown). */
function languageName(language) {
    const code = String(language || '').trim().toLowerCase().split(/[-_]/)[0];
    return LANGUAGE_NAMES[code] || '';
}

/**
 * timbre → the same timbre with the pronunciation suffix of the book:
 * every "Native X pronunciation" is removed; "Native <book language>
 * pronunciation." is appended unless the timbre names an accent. Without a
 * known language the text is returned as it is (a re-parse at write time).
 */
function normalisePronunciation(timbre, language) {
    const name = languageName(language);
    const accent = ACCENT_RE.test(timbre);
    if (!name && !accent) return timbre;
    let out = timbre.replace(PRONUNCIATION_RE, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
    out = out.replace(/[,;]$/, '').trim();
    if (out && !/[.!?…]$/.test(out)) out += '.';
    if (!out) return timbre;
    return accent ? out : `${out} Native ${name} pronunciation.`;
}

/** A voice entry created from an analysis description (cleaned, not yet reviewed). */
function voiceFromDescription(text) {
    const { timbre } = cleanVoiceDescription(text, { appearance: true });
    return { timbre, manner: '', timbre_source: 'cleaned' };
}

// ── a voice as the analysis returned it → the voice block of a hero ──────
const VOICE_TEXT_MAX = 2000;

function cleanField(value, options) {
    if (typeof value !== 'string' || !value.trim()) return { text: '', removed: [] };
    const cleaned = cleanVoiceDescription(value, options);
    return { text: cleaned.timbre.slice(0, VOICE_TEXT_MAX).trim(), removed: cleaned.removed };
}

/**
 * Turn what the voice step of the analysis returned for one character into
 * { timbre, manner, timbre_source } — or refuse it.
 *
 * Accepted shapes:
 *   { timbre, manner }      the v4 contract. timbre — WHO sounds (sex, age,
 *                           timbre, accent); manner — how the character
 *                           usually speaks. manner may be missing.
 *   "one description"       the 3.1-era single string, or { instruction: "…" }
 *                           from a model that ignored the contract: the whole
 *                           text is treated as timbre.
 * Situational and plot-bound sentences are dropped from BOTH fields by the
 * cleanup rules — a reference is designed from this text and must be neutral.
 * timbre_source: 'analysis' when the text is the model's as it is, 'cleaned'
 * when a rule removed something or the shape had to be repaired.
 *
 * @returns {{ voice: {timbre: string, manner: string, timbre_source: string}|null,
 *             removed: string[], reason: string|null }}
 *   voice === null → nothing is written; reason: 'empty' | 'bad_shape' |
 *   'timbre_empty' (only situational text, or a manner without a timbre)
 * @param {{ language?: string }} [options]  the book language — the
 *   pronunciation suffix of timbre follows it (v3); without it the suffix is
 *   left as it is unless the timbre names an accent.
 */
function voiceFromAnalysis(raw, options = {}) {
    let timbreRaw = '';
    let mannerRaw = '';
    let repaired = false;
    // A block that already went through this function (the voice step parses,
    // the write barrier parses again) keeps what it was told about itself.
    const stated = raw && typeof raw === 'object' && TIMBRE_SOURCES.includes(raw.timbre_source) ? raw.timbre_source : null;
    if (typeof raw === 'string') {
        timbreRaw = raw; repaired = true;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        timbreRaw = typeof raw.timbre === 'string' ? raw.timbre : '';
        mannerRaw = typeof raw.manner === 'string' ? raw.manner : '';
        if (!timbreRaw.trim() && typeof raw.instruction === 'string') { timbreRaw = raw.instruction; repaired = true; }
    } else if (raw === undefined || raw === null) {
        return { voice: null, removed: [], reason: 'empty' };
    } else {
        return { voice: null, removed: [], reason: 'bad_shape' };
    }
    if (!timbreRaw.trim() && !mannerRaw.trim()) return { voice: null, removed: [], reason: 'empty' };

    const timbre = cleanField(timbreRaw, { appearance: true });
    const manner = cleanField(mannerRaw);
    const removed = [...timbre.removed, ...manner.removed];
    if (!timbre.text) return { voice: null, removed, reason: 'timbre_empty' };
    return {
        voice: {
            timbre: normalisePronunciation(timbre.text, options && options.language).slice(0, VOICE_TEXT_MAX).trim(),
            manner: manner.text,
            timbre_source: repaired || removed.length > 0 ? 'cleaned' : (stated || 'analysis'),
        },
        removed,
        reason: null,
    };
}

/**
 * May the analysis change this voice at all? Never when a person edited it
 * (timbre_source 'user') or a reference is locked on it.
 */
function isVoiceProtected(voice) {
    if (!voice || typeof voice !== 'object') return false;
    if (voice.timbre_source === 'user') return true;
    return !!(voice.reference && typeof voice.reference === 'object' && voice.reference.locked === true);
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
    voiceFromAnalysis,
    normalisePronunciation,
    isVoiceProtected,
    referenceProblem,
    isReferenceVerified,
    resolveReferenceFile,
    referenceState,
    timbreSha256,
    isReferenceOutdated,
};
