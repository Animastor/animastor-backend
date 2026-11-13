// ======================================================
// character-validator — animastor.character/1 and behaviour globals
// ======================================================
// The working validator of a hero file (VBOOK_FORMAT_V4 §10.2). The normative
// contract is the JSON Schema in animastor-docs (copied byte for byte to
// schemas/character-1.schema.json); this module mirrors it by hand so the
// package needs no schema engine at runtime. A test runs shared fixtures
// through both and requires the same verdict.
//
// Every problem is { code, path, message }:
//   errors   — the file is broken (§10.3). `code: "schema"` is a violation the
//              JSON Schema also reports; any other code is a rule beyond the
//              schema (file name, reference directory, uniqueness).
//   warnings — the file loads; `unknown_key` marks keys the format does not
//              define (they are preserved on read and write).
//
// Nothing here touches the disk and nothing is mutated.

'use strict';

const {
    CANONICAL_ID_RE, MAX_HERO_ID_LENGTH, NARRATOR_ID, RESERVED_HERO_IDS,
} = require('./heroes.cjs');
const { normalizeForMatch } = require('./character-identity');

const CHARACTER_SCHEMA = 'animastor.character/1';
const BEHAVIOUR_GLOBALS_SCHEMA = 'animastor.behaviour-globals/1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const VOICE_REFERENCE_FILE_RE = /^voices\/[a-z0-9_]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(wav|flac|mp3|ogg)$/;
const IMAGE_REF_FILE_RE = /^refs\/images\/[a-z0-9_]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|jpg|jpeg|webp)$/;
const LOOK_FIELD_KEYS = Object.freeze(['appearance', 'clothes', 'video_tokens']);
const BASE_LOOK_ID = 'base';

// Keys the format (or the voice-reference task, §5.2) defines. Anything else
// is preserved and reported as `unknown_key`.
const KNOWN_KEYS = Object.freeze({
    root: ['schema', 'id', 'name', 'role', 'aliases', 'passport', 'looks', 'voice', 'behaviour', 'image_refs', 'notes'],
    passport: ['appearance', 'clothes', 'video_tokens'],
    voice: ['timbre', 'manner', 'timbre_source', 'reference'],
    reference: ['file', 'sha256', 'ref_text', 'source', 'model', 'seed', 'verification', 'locked', 'candidate_id', 'language'],
    profile: ['baseline', 'quirks', 'reactions'],
    look: ['id', 'label', 'fields', 'image_ref', 'notes', 'evidence'],
    imageRef: ['file', 'sha256', 'kind', 'source', 'model', 'seed', 'locked', 'note'],
    globals: ['schema', 'defaults', 'rules'],
});

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// JSON Schema counts characters (code points), not UTF-16 units.
function charLength(s) {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of s) n++;
    return n;
}

function describe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function createReport() {
    const errors = [];
    const warnings = [];
    return {
        errors,
        warnings,
        schema(path, message) { errors.push({ code: 'schema', path, message }); },
        error(code, path, message) { errors.push({ code, path, message }); },
        warn(code, path, message) { warnings.push({ code, path, message }); },
        result() { return { valid: errors.length === 0, errors, warnings }; },
    };
}

// ── primitive checks (each returns true when the value may be used further) ──

function checkString(report, value, path, { min, max, nullable } = {}) {
    if (value === null && nullable) return false;
    if (typeof value !== 'string') {
        report.schema(path, `must be a string${nullable ? ' or null' : ''} (got ${describe(value)})`);
        return false;
    }
    const length = charLength(value);
    if (min !== undefined && length < min) {
        report.schema(path, `must be at least ${min} character${min === 1 ? '' : 's'} long`);
        return false;
    }
    if (max !== undefined && length > max) {
        report.schema(path, `must be at most ${max} characters long`);
        return false;
    }
    return true;
}

function checkEnum(report, value, path, options) {
    if (options.includes(value)) return true;
    report.schema(path, `must be one of ${options.join(' | ')}`);
    return false;
}

function checkInteger(report, value, path, { min } = {}) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        report.schema(path, `must be an integer (got ${describe(value)})`);
        return false;
    }
    if (min !== undefined && value < min) {
        report.schema(path, `must be >= ${min}`);
        return false;
    }
    return true;
}

function checkNumber(report, value, path) {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    report.schema(path, `must be a number (got ${describe(value)})`);
    return false;
}

function checkBoolean(report, value, path) {
    if (typeof value === 'boolean') return true;
    report.schema(path, `must be a boolean (got ${describe(value)})`);
    return false;
}

function checkObject(report, value, path) {
    if (isPlainObject(value)) return true;
    report.schema(path, `must be an object (got ${describe(value)})`);
    return false;
}

function checkArray(report, value, path, { max, min, nullable } = {}) {
    if (value === null && nullable) return false;
    if (!Array.isArray(value)) {
        report.schema(path, `must be an array${nullable ? ' or null' : ''} (got ${describe(value)})`);
        return false;
    }
    if (min !== undefined && value.length < min) report.schema(path, `must have at least ${min} item${min === 1 ? '' : 's'}`);
    if (max !== undefined && value.length > max) report.schema(path, `must have at most ${max} items`);
    return true;
}

function warnUnknownKeys(report, obj, known, path) {
    for (const key of Object.keys(obj)) {
        if (!known.includes(key)) report.warn('unknown_key', path ? `${path}.${key}` : key, `unknown key "${key}"`);
    }
}

// ── blocks ────────────────────────────────────────────────────────────────

function checkVideoTokens(report, value, path, { min } = {}) {
    if (!checkArray(report, value, path, { max: 4, min })) return;
    value.forEach((token, i) => checkString(report, token, `${path}[${i}]`, { min: 1 }));
}

function checkPassport(report, passport) {
    if (!checkObject(report, passport, 'passport')) return;
    for (const key of ['appearance', 'clothes']) {
        if (hasOwn(passport, key)) checkString(report, passport[key], `passport.${key}`, { nullable: true });
    }
    if (hasOwn(passport, 'video_tokens')) checkVideoTokens(report, passport.video_tokens, 'passport.video_tokens');
    warnUnknownKeys(report, passport, KNOWN_KEYS.passport, 'passport');
}

// A reference link is a relative path of exactly three (voices) or four (images)
// segments below build_<book_id>/. Absolute paths, "..", "." and backslashes
// are refused here even where the schema pattern alone would let a ".." pass
// inside a file name ("a..b.wav").
function checkReferencePath(report, file, path, { pattern, dirIndex, heroId, shape }) {
    if (typeof file !== 'string') {
        report.schema(path, `must be a string (got ${describe(file)})`);
        return;
    }
    if (!pattern.test(file)) {
        report.schema(path, `must look like ${shape}`);
        return;
    }
    if (file.includes('..')) {
        report.error('reference_path', path, 'must not contain ".."');
        return;
    }
    const dir = file.split('/')[dirIndex];
    if (typeof heroId === 'string' && dir !== heroId) {
        report.error('reference_dir_mismatch', path, `directory "${dir}" must be the hero id "${heroId}"`);
    }
}

function checkVoiceReference(report, ref, heroId) {
    const path = 'voice.reference';
    if (!checkObject(report, ref, path)) return;
    for (const key of ['file', 'sha256']) {
        if (!hasOwn(ref, key)) report.schema(`${path}.${key}`, 'is required');
    }
    if (hasOwn(ref, 'file')) {
        checkReferencePath(report, ref.file, `${path}.file`, {
            pattern: VOICE_REFERENCE_FILE_RE, dirIndex: 1, heroId,
            shape: 'voices/<hero id>/<name>.<wav|flac|mp3|ogg>',
        });
    }
    if (hasOwn(ref, 'sha256') && (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256))) {
        report.schema(`${path}.sha256`, 'must be 64 lowercase hex characters');
    }
    if (hasOwn(ref, 'ref_text')) checkString(report, ref.ref_text, `${path}.ref_text`, { max: 2000 });
    if (hasOwn(ref, 'source')) checkEnum(report, ref.source, `${path}.source`, ['designed', 'uploaded']);
    if (hasOwn(ref, 'model')) checkString(report, ref.model, `${path}.model`, { max: 200 });
    if (hasOwn(ref, 'seed')) checkInteger(report, ref.seed, `${path}.seed`, { min: 0 });
    if (hasOwn(ref, 'verification')) checkString(report, ref.verification, `${path}.verification`, { max: 40 });
    if (hasOwn(ref, 'locked')) checkBoolean(report, ref.locked, `${path}.locked`);
    warnUnknownKeys(report, ref, KNOWN_KEYS.reference, path);
}

function checkVoice(report, voice, heroId) {
    if (!checkObject(report, voice, 'voice')) return;
    for (const key of ['timbre', 'manner']) {
        if (hasOwn(voice, key)) checkString(report, voice[key], `voice.${key}`, { max: 2000, nullable: true });
    }
    if (hasOwn(voice, 'reference')) checkVoiceReference(report, voice.reference, heroId);
    warnUnknownKeys(report, voice, KNOWN_KEYS.voice, 'voice');
}

function checkImageRef(report, ref, path, heroId) {
    if (!checkObject(report, ref, path)) return;
    for (const key of ['file', 'sha256']) {
        if (!hasOwn(ref, key)) report.schema(`${path}.${key}`, 'is required');
    }
    if (hasOwn(ref, 'file')) {
        checkReferencePath(report, ref.file, `${path}.file`, {
            pattern: IMAGE_REF_FILE_RE, dirIndex: 2, heroId,
            shape: 'refs/images/<hero id>/<name>.<png|jpg|jpeg|webp>',
        });
    }
    if (hasOwn(ref, 'sha256') && (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256))) {
        report.schema(`${path}.sha256`, 'must be 64 lowercase hex characters');
    }
    if (hasOwn(ref, 'kind')) checkEnum(report, ref.kind, `${path}.kind`, ['portrait', 'full_body', 'other']);
    if (hasOwn(ref, 'source')) checkEnum(report, ref.source, `${path}.source`, ['generated', 'uploaded']);
    if (hasOwn(ref, 'model')) checkString(report, ref.model, `${path}.model`, { max: 200 });
    if (hasOwn(ref, 'seed')) checkInteger(report, ref.seed, `${path}.seed`, { min: 0 });
    if (hasOwn(ref, 'locked')) checkBoolean(report, ref.locked, `${path}.locked`);
    if (hasOwn(ref, 'note')) checkString(report, ref.note, `${path}.note`, { max: 500 });
    warnUnknownKeys(report, ref, KNOWN_KEYS.imageRef, path);
}

// Shape of one behaviour rule (VBOOK_BEHAVIOUR.md §2.1). Only the shape: the
// vocabulary of emotions and clamps belong to the host's behaviour-rules.js.
// scope / character_id follow from where the rule is stored and must not be
// written (§6.2, §6.3).
function checkRule(report, rule, path) {
    if (!checkObject(report, rule, path)) return null;
    if (!hasOwn(rule, 'id')) report.schema(`${path}.id`, 'is required');
    else checkString(report, rule.id, `${path}.id`, { min: 1, max: 200 });
    for (const key of ['when', 'then']) {
        if (hasOwn(rule, key)) checkObject(report, rule[key], `${path}.${key}`);
    }
    for (const key of ['strength', 'probability', 'priority']) {
        if (hasOwn(rule, key)) checkNumber(report, rule[key], `${path}.${key}`);
    }
    if (hasOwn(rule, 'cooldown_iu')) checkInteger(report, rule.cooldown_iu, `${path}.cooldown_iu`);
    if (hasOwn(rule, 'enabled')) checkBoolean(report, rule.enabled, `${path}.enabled`);
    for (const key of ['scope', 'character_id']) {
        if (hasOwn(rule, key)) report.schema(`${path}.${key}`, 'must not be written: it follows from where the rule is stored');
    }
    return typeof rule.id === 'string' ? rule.id : null;
}

function checkRules(report, rules, path) {
    if (!checkArray(report, rules, path)) return;
    const seen = new Set();
    rules.forEach((rule, i) => {
        const id = checkRule(report, rule, `${path}[${i}]`);
        if (id === null) return;
        if (seen.has(id)) report.error('duplicate_rule_id', `${path}[${i}].id`, `duplicate rule id "${id}"`);
        seen.add(id);
    });
}

function checkBehaviour(report, behaviour) {
    if (!checkObject(report, behaviour, 'behaviour')) return;
    for (const key of Object.keys(behaviour)) {
        if (key !== 'profile' && key !== 'rules') report.schema(`behaviour.${key}`, 'unexpected key (only profile and rules are allowed)');
    }
    if (hasOwn(behaviour, 'profile') && checkObject(report, behaviour.profile, 'behaviour.profile')) {
        const profile = behaviour.profile;
        if (hasOwn(profile, 'baseline')) checkString(report, profile.baseline, 'behaviour.profile.baseline', { nullable: true });
        if (hasOwn(profile, 'quirks') && checkArray(report, profile.quirks, 'behaviour.profile.quirks', { nullable: true })) {
            profile.quirks.forEach((q, i) => checkString(report, q, `behaviour.profile.quirks[${i}]`));
        }
        if (hasOwn(profile, 'reactions') && checkArray(report, profile.reactions, 'behaviour.profile.reactions', { nullable: true })) {
            profile.reactions.forEach((r, i) => {
                const p = `behaviour.profile.reactions[${i}]`;
                if (!checkObject(report, r, p)) return;
                for (const key of ['trigger', 'reaction']) {
                    if (hasOwn(r, key)) checkString(report, r[key], `${p}.${key}`);
                }
            });
        }
        warnUnknownKeys(report, profile, KNOWN_KEYS.profile, 'behaviour.profile');
    }
    if (hasOwn(behaviour, 'rules')) checkRules(report, behaviour.rules, 'behaviour.rules');
}

function checkLookFields(report, fields, path) {
    if (!checkObject(report, fields, path)) return;
    const keys = Object.keys(fields);
    if (keys.length === 0) report.schema(path, 'must change at least one field');
    for (const key of keys) {
        if (!LOOK_FIELD_KEYS.includes(key)) report.schema(`${path}.${key}`, `unexpected key (allowed: ${LOOK_FIELD_KEYS.join(', ')})`);
    }
    for (const key of ['appearance', 'clothes']) {
        if (hasOwn(fields, key)) checkString(report, fields[key], `${path}.${key}`, { min: 1 });
    }
    if (hasOwn(fields, 'video_tokens')) checkVideoTokens(report, fields.video_tokens, `${path}.video_tokens`, { min: 1 });
}

function checkLook(report, look, path, heroId) {
    if (!checkObject(report, look, path)) return null;
    for (const key of ['id', 'label', 'fields']) {
        if (!hasOwn(look, key)) report.schema(`${path}.${key}`, 'is required');
    }
    let id = null;
    if (hasOwn(look, 'id')) {
        if (typeof look.id !== 'string' || !CANONICAL_ID_RE.test(look.id) || charLength(look.id) > 64) {
            report.schema(`${path}.id`, 'must be a snake_case id of up to 64 characters');
        } else if (look.id === BASE_LOOK_ID) {
            report.schema(`${path}.id`, '"base" is reserved for the base passport');
        } else {
            id = look.id;
        }
    }
    if (hasOwn(look, 'label')) checkString(report, look.label, `${path}.label`, { min: 1, max: 120 });
    if (hasOwn(look, 'fields')) checkLookFields(report, look.fields, `${path}.fields`);
    if (hasOwn(look, 'image_ref') && look.image_ref !== null) checkImageRef(report, look.image_ref, `${path}.image_ref`, heroId);
    if (hasOwn(look, 'notes')) checkString(report, look.notes, `${path}.notes`, { max: 2000 });
    if (hasOwn(look, 'evidence') && checkObject(report, look.evidence, `${path}.evidence`)) {
        const ev = look.evidence;
        if (hasOwn(ev, 'quote')) checkString(report, ev.quote, `${path}.evidence.quote`, { max: 1000 });
        for (const key of ['chapter_id', 'scene_id', 'unit_id']) {
            if (hasOwn(ev, key)) checkString(report, ev[key], `${path}.evidence.${key}`);
        }
        if (hasOwn(ev, 'basis')) checkEnum(report, ev.basis, `${path}.evidence.basis`, ['explicit', 'inferred']);
        if (hasOwn(ev, 'status')) checkEnum(report, ev.status, `${path}.evidence.status`, ['suggested', 'accepted']);
    }
    warnUnknownKeys(report, look, KNOWN_KEYS.look, path);
    return id;
}

function checkHeroId(report, id) {
    if (typeof id !== 'string') {
        report.schema('id', `must be a string (got ${describe(id)})`);
        return false;
    }
    if (!CANONICAL_ID_RE.test(id) || charLength(id) > MAX_HERO_ID_LENGTH) {
        report.schema('id', `must be a snake_case id of up to ${MAX_HERO_ID_LENGTH} characters`);
        return false;
    }
    if (RESERVED_HERO_IDS.includes(id)) {
        report.schema('id', `"${id}" is reserved`);
        return false;
    }
    return true;
}

/**
 * Validate the content of characters/<id>.json.
 *
 * @param {*} doc                     parsed JSON
 * @param {{ filename?: string }} [options]  base name of the file ("yura.json");
 *        when given, it must be exactly "<id>.json"
 * @returns {{ valid: boolean,
 *             errors: {code: string, path: string, message: string}[],
 *             warnings: {code: string, path: string, message: string}[] }}
 */
function validateCharacterFile(doc, options = {}) {
    const report = createReport();
    if (!isPlainObject(doc)) {
        report.schema('', `character file must contain a JSON object (got ${describe(doc)})`);
        return report.result();
    }

    if (!hasOwn(doc, 'schema')) report.schema('schema', 'is required');
    else if (doc.schema !== CHARACTER_SCHEMA) report.schema('schema', `must be exactly "${CHARACTER_SCHEMA}"`);

    let heroId = null;
    if (!hasOwn(doc, 'id')) report.schema('id', 'is required');
    else if (checkHeroId(report, doc.id)) heroId = doc.id;

    if (hasOwn(doc, 'name')) checkString(report, doc.name, 'name', { max: 200 });
    if (hasOwn(doc, 'role')) checkString(report, doc.role, 'role', { max: 200 });
    if (hasOwn(doc, 'notes')) checkString(report, doc.notes, 'notes', { max: 10000 });

    // The narrator: id "narrator" ⇔ role "narrator" (§4).
    if (doc.role === NARRATOR_ID && hasOwn(doc, 'id') && doc.id !== NARRATOR_ID) {
        report.schema('role', 'role "narrator" is reserved for the hero with id "narrator"');
    }
    if ((!hasOwn(doc, 'id') || doc.id === NARRATOR_ID) && doc.role !== NARRATOR_ID) {
        report.schema('role', 'the narrator must have role "narrator"');
    }

    if (hasOwn(doc, 'aliases') && checkArray(report, doc.aliases, 'aliases', { max: 64 })) {
        const seen = new Map();
        doc.aliases.forEach((alias, i) => {
            if (!checkString(report, alias, `aliases[${i}]`, { min: 1, max: 200 })) return;
            const key = normalizeForMatch(alias) || alias.trim().toLowerCase();
            if (seen.has(key)) {
                report.error('duplicate_alias', `aliases[${i}]`, `alias "${alias}" repeats "${seen.get(key)}"`);
            } else {
                seen.set(key, alias);
            }
        });
    }

    if (hasOwn(doc, 'passport')) checkPassport(report, doc.passport);

    if (hasOwn(doc, 'looks')) {
        if (checkArray(report, doc.looks, 'looks', { max: 32 })) {
            const seen = new Set();
            doc.looks.forEach((look, i) => {
                const id = checkLook(report, look, `looks[${i}]`, heroId);
                if (id === null) return;
                if (seen.has(id)) report.error('duplicate_look_id', `looks[${i}].id`, `duplicate look id "${id}"`);
                seen.add(id);
            });
        }
        // Looks override a passport, so they need one (§4a.2). An empty array is fine.
        const hasLooks = !Array.isArray(doc.looks) || doc.looks.length >= 1;
        if (hasLooks && !hasOwn(doc, 'passport')) report.schema('looks', 'looks require a passport');
    }

    if (hasOwn(doc, 'voice')) checkVoice(report, doc.voice, heroId);
    if (hasOwn(doc, 'behaviour')) checkBehaviour(report, doc.behaviour);

    if (hasOwn(doc, 'image_refs') && checkArray(report, doc.image_refs, 'image_refs', { max: 32 })) {
        doc.image_refs.forEach((ref, i) => checkImageRef(report, ref, `image_refs[${i}]`, heroId));
    }

    warnUnknownKeys(report, doc, KNOWN_KEYS.root, '');

    if (options.filename !== undefined && options.filename !== null) {
        const expected = heroId !== null ? `${heroId}.json` : null;
        if (expected === null || options.filename !== expected) {
            report.error('filename_mismatch', 'id',
                `file name "${options.filename}" must be "<id>.json" (inner id is ${JSON.stringify(doc.id)})`);
        }
    }

    return report.result();
}

/**
 * Validate behaviour.json — the book-level behaviour document (§6.3):
 * { schema: "animastor.behaviour-globals/1", defaults?: {max_per_scene?}, rules?: [...] }.
 * Every rule here is global, so scope / character_id must not be written.
 */
function validateBehaviourGlobals(doc) {
    const report = createReport();
    if (!isPlainObject(doc)) {
        report.schema('', `behaviour.json must contain a JSON object (got ${describe(doc)})`);
        return report.result();
    }
    if (!hasOwn(doc, 'schema')) report.schema('schema', 'is required');
    else if (doc.schema !== BEHAVIOUR_GLOBALS_SCHEMA) report.schema('schema', `must be exactly "${BEHAVIOUR_GLOBALS_SCHEMA}"`);

    if (hasOwn(doc, 'defaults') && checkObject(report, doc.defaults, 'defaults')) {
        if (hasOwn(doc.defaults, 'max_per_scene')) checkInteger(report, doc.defaults.max_per_scene, 'defaults.max_per_scene', { min: 0 });
    }
    if (hasOwn(doc, 'rules')) checkRules(report, doc.rules, 'rules');
    warnUnknownKeys(report, doc, KNOWN_KEYS.globals, '');
    return report.result();
}

/** A fresh, valid behaviour.json for a new book. */
function emptyBehaviourGlobals() {
    return { schema: BEHAVIOUR_GLOBALS_SCHEMA, defaults: { max_per_scene: 2 }, rules: [] };
}

module.exports = {
    CHARACTER_SCHEMA,
    BEHAVIOUR_GLOBALS_SCHEMA,
    VOICE_REFERENCE_FILE_RE,
    IMAGE_REF_FILE_RE,
    validateCharacterFile,
    validateBehaviourGlobals,
    emptyBehaviourGlobals,
};
