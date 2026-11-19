// ======================================================
// @animastor/editor — hero API helpers (VBOOK_FORMAT_V4 §8.2)
// ======================================================
// Pure functions behind the hero routes: computed fields of a hero in the API
// (rev, voice.reference_state, voice.reference_outdated, image_refs[].state),
// the PATCH white list, looks and rules. No HTTP, no host: the routes call
// these and write through the hero store of the editor model.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const voicePort = require('@animastor/vbook-runtime/voice');
const { serializeCharacter } = require('@animastor/vbook-runtime/character-store.cjs');
const { CANONICAL_ID_RE, MAX_HERO_ID_LENGTH, NARRATOR_ID, heroRules } = require('@animastor/vbook-runtime/heroes.cjs');
const { normalizeForMatch } = require('@animastor/vbook-runtime/character-identity');
const { joinInside, assertInside } = require('@animastor/vbook-runtime/safe-paths');
const { CHARACTER_SCHEMA } = require('@animastor/vbook-runtime/character-validator.cjs');
const { toEntityId } = require('./entity-id.js');

const BASE_LOOK_ID = 'base';
const LOOK_FIELDS = Object.freeze(['appearance', 'clothes', 'video_tokens']);
const PASSPORT_FIELDS = LOOK_FIELDS;
const MAX_VIDEO_TOKENS = 4;
const MAX_ALIASES = 64;

// Body keys of a 3.1 client: VBook 4 has none of these maps.
const LEGACY_BODY_KEYS = Object.freeze(['characters', 'voices', 'behaviors', 'behavior_rules', 'mentions']);

/** A plain error with an API code and HTTP status — the routes answer it as is. */
class HeroApiError extends Error {
    constructor(status, code, message, details = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function legacyBodyKeys(body) {
    if (!isPlainObject(body)) return [];
    return LEGACY_BODY_KEYS.filter((key) => body[key] !== undefined);
}

// ── computed fields ──────────────────────────────────────────────────────
/** A hero as stored: the computed API fields removed (they are never written). */
function stripComputed(hero) {
    if (!isPlainObject(hero)) return hero;
    const out = clone(hero);
    delete out.rev;
    if (isPlainObject(out.voice)) {
        delete out.voice.reference_state;
        delete out.voice.reference_outdated;
    }
    if (Array.isArray(out.image_refs)) {
        for (const ref of out.image_refs) if (isPlainObject(ref)) delete ref.state;
    }
    return out;
}

/** First 16 hex of sha256 over the canonical serialization (the stored bytes). */
function heroRev(hero) {
    return crypto.createHash('sha256').update(serializeCharacter(stripComputed(hero)), 'utf8').digest('hex').slice(0, 16);
}

const IMAGE_REF_RE = /^refs\/images\/([a-z0-9]+(?:_[a-z0-9]+)*)\/([A-Za-z0-9_-]{1,128})\.(png|jpg|jpeg|webp)$/;

/** ok | missing | mismatch of a reference image (symbolic links are not followed). */
function imageRefState(buildDir, ref, heroId) {
    if (!buildDir || !isPlainObject(ref) || typeof ref.file !== 'string') return 'missing';
    const m = IMAGE_REF_RE.exec(ref.file);
    if (!m || m[1] !== heroId) return 'missing';
    let file;
    try {
        const dir = joinInside(buildDir, 'refs', 'images', heroId);
        file = assertInside(dir, joinInside(dir, `${m[2]}.${m[3]}`));
    } catch (_) {
        return 'missing';
    }
    let st = null;
    try { st = fs.lstatSync(file); } catch (_) { st = null; }
    if (!st || !st.isFile()) return 'missing';
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return sha === ref.sha256 ? 'ok' : 'mismatch';
}

/**
 * The hero as the API shows it: the stored object plus computed fields
 * (VBOOK_FORMAT_V4 §8.2) — `rev`; `voice.reference_state` (ok | missing |
 * mismatch) and `voice.reference_outdated` when there is a reference;
 * `image_refs[].state`. `buildDir` = <output>/<build_id>, null when unknown
 * (then every file state is `missing`).
 */
function enrichHero(hero, buildDir) {
    const stored = stripComputed(hero);
    const out = clone(stored);
    out.rev = heroRev(stored);
    if (isPlainObject(out.voice) && out.voice.reference !== undefined && out.voice.reference !== null) {
        out.voice.reference_state = buildDir
            ? voicePort.referenceState(buildDir, out.voice.reference, out.id)
            : 'missing';
        out.voice.reference_outdated = voicePort.isReferenceOutdated(out.voice);
    }
    if (Array.isArray(out.image_refs)) {
        for (const ref of out.image_refs) {
            if (isPlainObject(ref)) ref.state = imageRefState(buildDir, ref, out.id);
        }
    }
    return out;
}

// ── ids ──────────────────────────────────────────────────────────────────
function isCanonicalId(id) {
    return typeof id === 'string' && id.length <= MAX_HERO_ID_LENGTH && CANONICAL_ID_RE.test(id);
}

/** Free text → snake id (the existing transliteration), cut to 64 at a "_" boundary. */
function idFromText(text) {
    let id = toEntityId(String(text || ''));
    if (id.length > MAX_HERO_ID_LENGTH) id = id.slice(0, MAX_HERO_ID_LENGTH).replace(/_+[^_]*$/, '') || id.slice(0, MAX_HERO_ID_LENGTH);
    return id.replace(/_+$/, '');
}

/** id, else id_2, id_3 … — first one not taken. */
function uniqueId(base, taken, maxLength = MAX_HERO_ID_LENGTH) {
    if (!taken(base)) return base;
    for (let n = 2; n < 10000; n++) {
        const suffix = `_${n}`;
        const candidate = `${base.slice(0, maxLength - suffix.length).replace(/_+$/, '')}${suffix}`;
        if (!taken(candidate)) return candidate;
    }
    throw new HeroApiError(409, 'id_exhausted', `no free id for ${base}`);
}

// ── values ───────────────────────────────────────────────────────────────
function textOrNull(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new HeroApiError(400, 'invalid_field', `${field} must be a string or null`);
    return value.trim() === '' ? null : value;
}

function stringList(value, field) {
    if (value === null) return null;
    if (typeof value === 'string') value = value.split(/\r?\n/);
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new HeroApiError(400, 'invalid_field', `${field} must be an array of strings or null`);
    }
    const out = value.map((v) => v.trim()).filter(Boolean);
    return out.length > 0 ? out : null;
}

function videoTokens(value, field) {
    if (value === null) return null;
    if (typeof value === 'string') value = value.split(',');
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new HeroApiError(400, 'invalid_field', `${field} must be an array of strings, a comma-separated string or null`);
    }
    const out = value.map((v) => v.trim()).filter(Boolean);
    if (out.length > MAX_VIDEO_TOKENS) {
        throw new HeroApiError(400, 'too_many_video_tokens', `${field}: at most ${MAX_VIDEO_TOKENS} video tokens`);
    }
    return out.length > 0 ? out : null;
}

function setOrDelete(obj, key, value) {
    if (value === null || value === undefined) delete obj[key];
    else obj[key] = value;
}

// ── PATCH /heroes/:heroId — the white list (§8.2) ────────────────────────
const PATCH_PATHS = Object.freeze([
    'name', 'role', 'aliases', 'notes',
    'passport.appearance', 'passport.clothes', 'passport.video_tokens',
    'voice.timbre', 'voice.manner',
    'behaviour.profile.baseline', 'behaviour.profile.quirks', 'behaviour.profile.reactions',
]);
const BLOCK_PATHS = Object.freeze(['passport', 'voice']);

/**
 * Apply `fields` to a hero copy (mutates and returns it).
 *   - only PATCH_PATHS and the blocks passport / voice;
 *   - null (and '' for texts) removes the field;
 *   - passport: null / voice: null remove the block; {} adds an empty one;
 *   - editing voice.timbre marks timbre_source "user" (the analysis never
 *     touches such a voice);
 *   - the narrator keeps its voice block.
 * @throws {HeroApiError} 400 field_not_editable | invalid_field | too_many_video_tokens |
 *         narrator_voice_required
 */
function applyHeroFields(hero, fields) {
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
        throw new HeroApiError(400, 'bad_request', 'Provide a non-empty "fields" object');
    }
    const bad = Object.keys(fields).filter((k) => !PATCH_PATHS.includes(k) && !BLOCK_PATHS.includes(k));
    if (bad.length > 0) {
        throw new HeroApiError(400, 'field_not_editable', `fields not editable here: ${bad.join(', ')}`, { fields: bad, allowed: [...BLOCK_PATHS, ...PATCH_PATHS] });
    }
    // blocks first: "voice: {}" followed by "voice.timbre" in one request works
    for (const block of BLOCK_PATHS) {
        if (!Object.prototype.hasOwnProperty.call(fields, block)) continue;
        const v = fields[block];
        if (v === null) {
            if (block === 'voice' && hero.id === NARRATOR_ID) {
                throw new HeroApiError(400, 'narrator_voice_required', 'the narrator keeps its voice');
            }
            delete hero[block];
        } else if (isPlainObject(v) && Object.keys(v).length === 0) {
            if (!isPlainObject(hero[block])) hero[block] = {};
        } else {
            throw new HeroApiError(400, 'invalid_field', `${block} must be null (remove the block) or {} (add an empty block)`);
        }
    }
    const ensure = (key) => {
        if (!isPlainObject(hero[key])) hero[key] = {};
        return hero[key];
    };
    for (const [key, value] of Object.entries(fields)) {
        switch (key) {
            case 'passport':
            case 'voice':
                break;
            case 'name':
            case 'role':
            case 'notes':
                setOrDelete(hero, key, textOrNull(value, key));
                break;
            case 'aliases':
                setOrDelete(hero, key, stringList(value, key));
                break;
            case 'passport.appearance':
            case 'passport.clothes':
                setOrDelete(ensure('passport'), key.slice('passport.'.length), textOrNull(value, key));
                break;
            case 'passport.video_tokens':
                setOrDelete(ensure('passport'), 'video_tokens', videoTokens(value, key));
                break;
            case 'voice.timbre': {
                const voice = ensure('voice');
                const text = textOrNull(value, key);
                voice.timbre = text === null ? '' : text.trim();
                voice.timbre_source = 'user';
                break;
            }
            case 'voice.manner': {
                const voice = ensure('voice');
                const text = textOrNull(value, key);
                voice.manner = text === null ? '' : text.trim();
                break;
            }
            case 'behaviour.profile.baseline':
            case 'behaviour.profile.quirks':
            case 'behaviour.profile.reactions': {
                const behaviour = ensure('behaviour');
                if (!isPlainObject(behaviour.profile)) behaviour.profile = {};
                const sub = key.slice('behaviour.profile.'.length);
                let next;
                if (sub === 'baseline') next = textOrNull(value, key);
                else if (sub === 'quirks') next = stringList(value, key);
                else {
                    if (value !== null && (!Array.isArray(value) || value.some((r) => !isPlainObject(r)))) {
                        throw new HeroApiError(400, 'invalid_field', `${key} must be an array of objects or null`);
                    }
                    next = value === null || value.length === 0 ? null : value;
                }
                setOrDelete(behaviour.profile, sub, next);
                if (Object.keys(behaviour.profile).length === 0) delete behaviour.profile;
                if (Object.keys(behaviour).length === 0) delete hero.behaviour;
                break;
            }
            default:
                break;
        }
    }
    return hero;
}

/**
 * Checks of a hero draft that are the card's checks too (HERO_CARD §4):
 * a hero with a passport has a name; at most 64 aliases; no alias equal to
 * the name. Format checks are the validator's (the store refuses).
 */
function checkHeroDraft(hero) {
    if (isPlainObject(hero.passport) && hero.id !== NARRATOR_ID && !(typeof hero.name === 'string' && hero.name.trim())) {
        throw new HeroApiError(400, 'name_required', 'a hero with a passport has a name');
    }
    if (Array.isArray(hero.aliases)) {
        if (hero.aliases.length > MAX_ALIASES) throw new HeroApiError(400, 'too_many_aliases', `at most ${MAX_ALIASES} aliases`);
        const name = typeof hero.name === 'string' ? normalizeForMatch(hero.name) : '';
        if (name && hero.aliases.some((a) => normalizeForMatch(a) === name)) {
            throw new HeroApiError(400, 'alias_equals_name', 'an alias equal to the name is not an alias');
        }
    }
}

/** POST /heroes body → a new hero object (id already resolved). */
function newHero(id, body) {
    const hero = { schema: CHARACTER_SCHEMA, id };
    const name = textOrNull(body.name, 'name');
    if (name !== null) hero.name = name.trim();
    if (id === NARRATOR_ID) hero.role = NARRATOR_ID;
    else {
        const role = textOrNull(body.role, 'role');
        if (role !== null) hero.role = role.trim();
    }
    const aliases = body.aliases === undefined ? null : stringList(body.aliases, 'aliases');
    if (aliases) hero.aliases = aliases;
    const notes = textOrNull(body.notes, 'notes');
    if (notes !== null) hero.notes = notes;
    if (body.passport !== undefined && body.passport !== null) {
        if (!isPlainObject(body.passport)) throw new HeroApiError(400, 'invalid_field', 'passport must be an object');
        const passport = {};
        for (const key of PASSPORT_FIELDS) {
            if (body.passport[key] === undefined) continue;
            const v = key === 'video_tokens' ? videoTokens(body.passport[key], `passport.${key}`) : textOrNull(body.passport[key], `passport.${key}`);
            if (v !== null) passport[key] = v;
        }
        hero.passport = passport;
    }
    if (body.voice !== undefined && body.voice !== null) {
        if (!isPlainObject(body.voice)) throw new HeroApiError(400, 'invalid_field', 'voice must be an object');
        const voice = {};
        const timbre = textOrNull(body.voice.timbre, 'voice.timbre');
        const manner = textOrNull(body.voice.manner, 'voice.manner');
        if (timbre !== null) { voice.timbre = timbre.trim(); voice.timbre_source = 'user'; }
        if (manner !== null) voice.manner = manner.trim();
        hero.voice = voice;
    } else if (id === NARRATOR_ID) {
        hero.voice = {};
    }
    return hero;
}

// ── rules (§6.2, HERO_CARD §5) ───────────────────────────────────────────
const RULE_PATCH_KEYS = Object.freeze(['enabled', 'probability', 'strength', 'cooldown_iu', 'priority', 'when', 'then']);
const RULE_KEYS = Object.freeze(['id', ...RULE_PATCH_KEYS]);

function heroRuleList(hero) {
    return isPlainObject(hero.behaviour) && Array.isArray(hero.behaviour.rules) ? hero.behaviour.rules : [];
}

/** Every rule id of the book: behaviour.json + every hero file. */
function bookRuleIds(book) {
    const ids = new Set(heroRules(book).rules.map((r) => r.id));
    for (const id of heroRules(book).duplicates) ids.add(id);
    return ids;
}

/** `<hero id>.<first three words of the action>` (HERO_CARD §5), unique in the book. */
function ruleIdFor(heroId, action, taken) {
    const words = idFromText(action).split('_').filter(Boolean).slice(0, 3).join('_') || 'rule';
    const base = `${heroId}.${words}`;
    if (!taken(base)) return base;
    for (let n = 2; n < 10000; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
    throw new HeroApiError(409, 'id_exhausted', `no free rule id for ${base}`);
}

function newRule(body, heroId, takenIds) {
    if (!isPlainObject(body)) throw new HeroApiError(400, 'bad_request', 'rule must be an object');
    const extra = Object.keys(body).filter((k) => !RULE_KEYS.includes(k));
    if (extra.length > 0) {
        throw new HeroApiError(400, 'invalid_rule', `unexpected rule keys: ${extra.join(', ')} (scope and character_id follow from where the rule lives)`);
    }
    const action = isPlainObject(body.then) && typeof body.then.action === 'string' ? body.then.action.trim() : '';
    if (!action) throw new HeroApiError(400, 'invalid_rule', 'then.action is required');
    const rule = clone(body);
    if (rule.id === undefined || rule.id === null || rule.id === '') {
        rule.id = ruleIdFor(heroId, action, (id) => takenIds.has(id));
    } else if (typeof rule.id !== 'string' || !rule.id.trim() || rule.id.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(rule.id) || rule.id.includes('..')) {
        throw new HeroApiError(400, 'invalid_rule', 'rule id must be one path segment of up to 200 characters');
    } else if (takenIds.has(rule.id)) {
        throw new HeroApiError(409, 'rule_exists', `rule id "${rule.id}" is already used in this book`);
    }
    if (rule.enabled === undefined) rule.enabled = true;
    return rule;
}

function applyRuleFields(rule, fields) {
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
        throw new HeroApiError(400, 'bad_request', 'Provide a non-empty "fields" object');
    }
    const bad = Object.keys(fields).filter((k) => !RULE_PATCH_KEYS.includes(k));
    if (bad.length > 0) throw new HeroApiError(400, 'field_not_editable', `rule fields not editable: ${bad.join(', ')}`, { fields: bad, allowed: RULE_PATCH_KEYS });
    for (const [key, value] of Object.entries(fields)) setOrDelete(rule, key, value);
    return rule;
}

// ── looks (§4a) ──────────────────────────────────────────────────────────
function lookList(hero) {
    return Array.isArray(hero.looks) ? hero.looks : [];
}

function lookFieldsFrom(raw, path) {
    if (!isPlainObject(raw)) throw new HeroApiError(400, 'look_empty', `${path} must be an object with at least one of ${LOOK_FIELDS.join(', ')}`);
    const extra = Object.keys(raw).filter((k) => !LOOK_FIELDS.includes(k));
    if (extra.length > 0) throw new HeroApiError(400, 'invalid_field', `${path}: unexpected keys ${extra.join(', ')}`);
    const out = {};
    for (const key of LOOK_FIELDS) {
        if (raw[key] === undefined) continue;
        const v = key === 'video_tokens' ? videoTokens(raw[key], `${path}.${key}`) : textOrNull(raw[key], `${path}.${key}`);
        if (v !== null) out[key] = v;
    }
    if (Object.keys(out).length === 0) throw new HeroApiError(400, 'look_empty', 'a look changes at least one field');
    return out;
}

function newLook(hero, body) {
    if (!isPlainObject(body)) throw new HeroApiError(400, 'bad_request', 'look must be an object');
    const label = textOrNull(body.label, 'label');
    if (label === null) throw new HeroApiError(400, 'look_label_required', 'a look has a label');
    const fields = lookFieldsFrom(body.fields, 'fields');
    const taken = (id) => id === BASE_LOOK_ID || lookList(hero).some((l) => l && l.id === id);
    let id;
    if (body.id !== undefined && body.id !== null && body.id !== '') {
        if (!isCanonicalId(body.id) || body.id === BASE_LOOK_ID) {
            throw new HeroApiError(400, 'invalid_look_id', 'look id: latin snake_case up to 64 characters, not "base"');
        }
        if (taken(body.id)) throw new HeroApiError(409, 'look_exists', `look "${body.id}" already exists`);
        id = body.id;
    } else {
        id = uniqueId(idFromText(label) || 'look', taken);
    }
    const look = { id, label: label.trim(), fields };
    const notes = textOrNull(body.notes, 'notes');
    if (notes !== null) look.notes = notes;
    return look;
}

const LOOK_PATCH_KEYS = Object.freeze(['label', 'notes', 'fields.appearance', 'fields.clothes', 'fields.video_tokens']);

function applyLookFields(look, fields) {
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
        throw new HeroApiError(400, 'bad_request', 'Provide a non-empty "fields" object');
    }
    const bad = Object.keys(fields).filter((k) => !LOOK_PATCH_KEYS.includes(k));
    if (bad.length > 0) throw new HeroApiError(400, 'field_not_editable', `look fields not editable: ${bad.join(', ')}`, { fields: bad, allowed: LOOK_PATCH_KEYS });
    if (!isPlainObject(look.fields)) look.fields = {};
    for (const [key, value] of Object.entries(fields)) {
        if (key === 'label') {
            const label = textOrNull(value, 'label');
            if (label === null) throw new HeroApiError(400, 'look_label_required', 'a look has a label');
            look.label = label.trim();
        } else if (key === 'notes') {
            setOrDelete(look, 'notes', textOrNull(value, 'notes'));
        } else {
            const sub = key.slice('fields.'.length);
            const v = sub === 'video_tokens' ? videoTokens(value, key) : textOrNull(value, key);
            setOrDelete(look.fields, sub, v);
        }
    }
    if (Object.keys(look.fields).length === 0) throw new HeroApiError(400, 'look_empty', 'the last field of a look cannot be removed');
    return look;
}

/** Remove every chapter / scene reference to `lookId` of `heroId`. @returns [{chapter_id, scene_id?}] */
function unassignLook(book, heroId, lookId) {
    const released = [];
    const drop = (holder, where) => {
        if (isPlainObject(holder.looks) && holder.looks[heroId] === lookId) {
            delete holder.looks[heroId];
            if (Object.keys(holder.looks).length === 0) delete holder.looks;
            released.push(where);
        }
    };
    for (const ch of Array.isArray(book.chapters) ? book.chapters : []) {
        if (!isPlainObject(ch)) continue;
        drop(ch, { chapter_id: ch.chapter_id });
        for (const sc of Array.isArray(ch.scenes) ? ch.scenes : []) {
            if (isPlainObject(sc)) drop(sc, { chapter_id: ch.chapter_id, scene_id: sc.scene_id });
        }
    }
    return released;
}

/** Set (lookId string) or release (null) one look reference of a chapter / scene. */
function assignInto(holder, heroId, lookId) {
    if (lookId === null) {
        if (isPlainObject(holder.looks)) {
            delete holder.looks[heroId];
            if (Object.keys(holder.looks).length === 0) delete holder.looks;
        }
        return;
    }
    if (!isPlainObject(holder.looks)) holder.looks = {};
    holder.looks[heroId] = lookId;
}

module.exports = {
    BASE_LOOK_ID,
    LOOK_FIELDS,
    PATCH_PATHS,
    LOOK_PATCH_KEYS,
    RULE_PATCH_KEYS,
    LEGACY_BODY_KEYS,
    HeroApiError,
    isPlainObject,
    clone,
    legacyBodyKeys,
    stripComputed,
    heroRev,
    enrichHero,
    imageRefState,
    isCanonicalId,
    idFromText,
    uniqueId,
    applyHeroFields,
    checkHeroDraft,
    newHero,
    heroRuleList,
    bookRuleIds,
    ruleIdFor,
    newRule,
    applyRuleFields,
    lookList,
    lookFieldsFrom,
    newLook,
    applyLookFields,
    unassignLook,
    assignInto,
    videoTokens,
};
