// ======================================================
// validateCharacterFile / validateBehaviourGlobals (VBOOK_FORMAT_V4 §10.2, приёмка 1.5)
// ======================================================
// The JSON Schema (normative, copied from animastor-docs) and the hand-written
// validator must give the same verdict on shared fixtures. Rules beyond the
// schema (file name, reference folder, uniqueness) are checked separately:
// there the schema accepts and only the validator refuses.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv2020 = require('ajv/dist/2020');
const { validateCharacterFile, validateBehaviourGlobals, validateBundleObject } = require('../src/bundle-validator.cjs');

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'character-1.schema.json');
const BUNDLE_SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'vbook-bundle-4.schema.json');
const EXAMPLES_DIR = path.join(__dirname, 'fixtures', 'character-examples');
const DOCS_ROOT = process.env.ANIMASTOR_DOCS_ROOT || path.resolve(__dirname, '../../../../animastor-docs');
const DOCS_SCHEMAS = path.join(DOCS_ROOT, 'architecture', 'schemas');
// sha256 of architecture/schemas in animastor-docs, branch design/vbook-v4 (ba19f69)
const PINNED = {
    'animastor.character-1.schema.json': 'a7042a017495c50177e10621d87016d4cec9322869c8c2cd83935aef2d5e083a',
    'examples/narrator.json': '23e83d39207fe5a07fecfbfa85dfb03eaf7a93fcf9e4fcd0a2d85fa658529215',
    'examples/shop_women.json': '639b44d4b817745305de157b3998393ddd2605a3bc751a6a5b8743e20afcc5de',
    'examples/yura.json': 'fd21db3499040caf17b83374e7878938f812dfdd8312fb9d74709e92995f697f',
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const bundleSchema = JSON.parse(fs.readFileSync(BUNDLE_SCHEMA_PATH, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);
const schemaAccepts = ajv.compile(schema);
const bundleSchemaAccepts = ajv.compile(bundleSchema);
const globalsAccepts = ajv.compile({ $ref: `${bundleSchema.$id}#/$defs/behaviourGlobals` });

const SHA = 'a'.repeat(64);
const base = (extra = {}) => ({ schema: 'animastor.character/1', id: 'yura', ...extra });
const passport = { appearance: 'tall', clothes: 'coat', video_tokens: ['man'] };
const look = (extra = {}) => ({ id: 'coat', label: 'В пальто', fields: { clothes: 'grey coat' }, ...extra });
const reference = (extra = {}) => ({ file: 'voices/yura/ref_01.wav', sha256: SHA, ...extra });
const imageRef = (extra = {}) => ({ file: 'refs/images/yura/p_01.png', sha256: SHA, ...extra });
const rule = (extra = {}) => ({ id: 'r1', when: { emotion: ['proud'] }, then: { action: 'nods' }, ...extra });

// [label, document] — the schema decides the expected verdict; the validator must agree.
const VALID = [
    ['minimal', base()],
    ['all scalar fields', base({ name: 'Юра', role: 'protagonist', notes: 'n', aliases: ['Юрий', 'Юрка'] })],
    ['narrator', { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'deep', manner: 'slow' } }],
    ['passport with nulls', base({ passport: { appearance: null, clothes: null, video_tokens: [] } })],
    ['passport only', base({ passport })],
    ['empty looks without a passport', base({ looks: [] })],
    ['looks with a passport', base({ passport, looks: [look(), look({ id: 'beard', fields: { appearance: 'beard', video_tokens: ['beard'] }, image_ref: null, notes: '', evidence: { quote: 'q', basis: 'explicit', status: 'accepted' } })] })],
    ['look with an image_ref', base({ passport, looks: [look({ image_ref: imageRef() })] })],
    ['voice with null fields', base({ voice: { timbre: null, manner: null } })],
    ['voice with a full reference', base({ voice: { timbre: 't', manner: 'm', timbre_source: 'analysis', reference: reference({ ref_text: 'x', source: 'designed', model: 'q', seed: 0, verification: 'passed', locked: true, candidate_id: 'c1', language: 'Russian' }) } })],
    ['reference formats', base({ voice: { reference: reference({ file: 'voices/yura/Take-2.final.ogg' }) } })],
    ['behaviour profile and rules', base({ behaviour: { profile: { baseline: 'calm', quirks: ['q'], reactions: [{ trigger: 't', reaction: 'r', extra: 1 }] }, rules: [rule({ strength: 0.5, probability: 1, cooldown_iu: 2, priority: 3, enabled: false, custom: 'x' })] } })],
    ['behaviour profile with nulls', base({ behaviour: { profile: { baseline: null, quirks: null, reactions: null } } })],
    ['empty behaviour', base({ behaviour: {} })],
    ['image refs', base({ image_refs: [imageRef({ kind: 'portrait', source: 'uploaded', model: 'm', seed: 1, locked: true, note: 'n' }), imageRef({ file: 'refs/images/yura/b.webp' })] })],
    ['unknown keys everywhere they are allowed', base({ future: { a: 1 }, passport: { ...passport, scars: 'x' }, voice: { pitch: 1, reference: reference({ duration: 4.2 }) } })],
    ['id of 64 characters', { schema: 'animastor.character/1', id: 'a'.repeat(64) }],
    ['200-character name counted in characters, not UTF-16 units', base({ name: '😀'.repeat(200) })],
];

const INVALID = [
    ['not an object: array', []],
    ['not an object: string', 'yura'],
    ['not an object: null', null],
    ['schema missing', { id: 'yura' }],
    ['schema wrong', { schema: 'animastor.character/2', id: 'yura' }],
    ['id missing', { schema: 'animastor.character/1' }],
    ['id not a string', { schema: 'animastor.character/1', id: 7 }],
    ['id upper case', base({ id: 'Yura' })],
    ['id Cyrillic', base({ id: 'юра' })],
    ['id with a dash', base({ id: 'yu-ra' })],
    ['id with a dot', base({ id: 'yu.ra' })],
    ['id path traversal', base({ id: '../x' })],
    ['id with a slash', base({ id: 'a/b' })],
    ['id empty', base({ id: '' })],
    ['id double underscore', base({ id: 'a__b' })],
    ['id of 65 characters', base({ id: 'a'.repeat(65) })],
    ...['manifest', 'book', 'bible', 'locations', 'voices', 'characters', 'behavior', 'behaviour', 'mentions', 'index']
        .map((id) => [`reserved id ${id}`, base({ id })]),
    ['name not a string', base({ name: 5 })],
    ['name too long', base({ name: 'x'.repeat(201) })],
    ['role too long', base({ role: 'x'.repeat(201) })],
    ['notes too long', base({ notes: 'x'.repeat(10001) })],
    ['role narrator on another hero', base({ role: 'narrator' })],
    ['narrator without a role', { schema: 'animastor.character/1', id: 'narrator' }],
    ['narrator with another role', { schema: 'animastor.character/1', id: 'narrator', role: 'host' }],
    ['aliases not an array', base({ aliases: 'Юрий' })],
    ['alias empty', base({ aliases: [''] })],
    ['alias not a string', base({ aliases: [1] })],
    ['alias too long', base({ aliases: ['x'.repeat(201)] })],
    ['too many aliases', base({ aliases: Array.from({ length: 65 }, (_, i) => `alias number ${i}`) })],
    ['passport not an object', base({ passport: 'tall' })],
    ['passport.appearance a number', base({ passport: { appearance: 1 } })],
    ['passport.video_tokens a string', base({ passport: { video_tokens: 'man' } })],
    ['passport.video_tokens five items', base({ passport: { video_tokens: ['a', 'b', 'c', 'd', 'e'] } })],
    ['passport.video_tokens empty item', base({ passport: { video_tokens: [''] } })],
    ['looks not an array', base({ passport, looks: {} })],
    ['looks without a passport', base({ looks: [look()] })],
    ['look without id', base({ passport, looks: [{ label: 'x', fields: { clothes: 'c' } }] })],
    ['look without label', base({ passport, looks: [{ id: 'coat', fields: { clothes: 'c' } }] })],
    ['look without fields', base({ passport, looks: [{ id: 'coat', label: 'x' }] })],
    ['look id base', base({ passport, looks: [look({ id: 'base' })] })],
    ['look id upper case', base({ passport, looks: [look({ id: 'Coat' })] })],
    ['look label empty', base({ passport, looks: [look({ label: '' })] })],
    ['look fields empty', base({ passport, looks: [look({ fields: {} })] })],
    ['look fields unknown key', base({ passport, looks: [look({ fields: { hat: 'x' } })] })],
    ['look fields empty string', base({ passport, looks: [look({ fields: { clothes: '' } })] })],
    ['look fields empty tokens', base({ passport, looks: [look({ fields: { video_tokens: [] } })] })],
    ['look image_ref a string', base({ passport, looks: [look({ image_ref: 'x.png' })] })],
    ['look evidence bad status', base({ passport, looks: [look({ evidence: { status: 'maybe' } })] })],
    ['too many looks', base({ passport, looks: Array.from({ length: 33 }, (_, i) => look({ id: `look_${i}` })) })],
    ['voice not an object', base({ voice: 'deep' })],
    ['voice.timbre a number', base({ voice: { timbre: 1 } })],
    ['voice.manner too long', base({ voice: { manner: 'x'.repeat(2001) } })],
    ['reference not an object', base({ voice: { reference: 'voices/yura/a.wav' } })],
    ['reference null', base({ voice: { reference: null } })],
    ['reference without file', base({ voice: { reference: { sha256: SHA } } })],
    ['reference without sha256', base({ voice: { reference: { file: 'voices/yura/a.wav' } } })],
    ['reference sha256 upper case', base({ voice: { reference: reference({ sha256: 'A'.repeat(64) }) } })],
    ['reference sha256 short', base({ voice: { reference: reference({ sha256: 'abc' }) } })],
    ['reference file absolute', base({ voice: { reference: reference({ file: '/voices/yura/a.wav' }) } })],
    ['reference file traversal', base({ voice: { reference: reference({ file: 'voices/yura/../../a.wav' }) } })],
    ['reference file leading traversal', base({ voice: { reference: reference({ file: '../voices/yura/a.wav' }) } })],
    ['reference file backslash', base({ voice: { reference: reference({ file: 'voices\\yura\\a.wav' }) } })],
    ['reference file nested', base({ voice: { reference: reference({ file: 'voices/yura/sub/a.wav' }) } })],
    ['reference file wrong extension', base({ voice: { reference: reference({ file: 'voices/yura/a.exe' }) } })],
    ['reference file no extension', base({ voice: { reference: reference({ file: 'voices/yura/a' }) } })],
    ['reference file outside voices', base({ voice: { reference: reference({ file: 'refs/yura/a.wav' }) } })],
    ['reference file hidden name', base({ voice: { reference: reference({ file: 'voices/yura/.a.wav' }) } })],
    ['reference file windows drive', base({ voice: { reference: reference({ file: 'C:/voices/yura/a.wav' }) } })],
    ['reference source unknown', base({ voice: { reference: reference({ source: 'web' }) } })],
    ['reference seed negative', base({ voice: { reference: reference({ seed: -1 }) } })],
    ['reference seed fractional', base({ voice: { reference: reference({ seed: 1.5 }) } })],
    ['reference locked a string', base({ voice: { reference: reference({ locked: 'yes' }) } })],
    ['reference ref_text too long', base({ voice: { reference: reference({ ref_text: 'x'.repeat(2001) }) } })],
    ['behaviour not an object', base({ behaviour: [] })],
    ['behaviour unknown key', base({ behaviour: { baseline: 'calm' } })],
    ['behaviour.profile not an object', base({ behaviour: { profile: 'calm' } })],
    ['behaviour.profile.quirks of numbers', base({ behaviour: { profile: { quirks: [1] } } })],
    ['behaviour.profile.reactions of strings', base({ behaviour: { profile: { reactions: ['x'] } } })],
    ['behaviour.profile.reactions trigger a number', base({ behaviour: { profile: { reactions: [{ trigger: 1 }] } } })],
    ['behaviour.rules not an array', base({ behaviour: { rules: {} } })],
    ['rule without id', base({ behaviour: { rules: [{ when: {} }] } })],
    ['rule id empty', base({ behaviour: { rules: [rule({ id: '' })] } })],
    ['rule with scope', base({ behaviour: { rules: [rule({ scope: 'character' })] } })],
    ['rule with character_id', base({ behaviour: { rules: [rule({ character_id: 'yura' })] } })],
    ['rule when not an object', base({ behaviour: { rules: [rule({ when: 'always' })] } })],
    ['rule cooldown fractional', base({ behaviour: { rules: [rule({ cooldown_iu: 1.5 })] } })],
    ['rule enabled a string', base({ behaviour: { rules: [rule({ enabled: 'no' })] } })],
    ['image_refs not an array', base({ image_refs: {} })],
    ['image ref without sha256', base({ image_refs: [{ file: 'refs/images/yura/p.png' }] })],
    ['image ref traversal', base({ image_refs: [imageRef({ file: 'refs/images/yura/../p.png' })] })],
    ['image ref wrong extension', base({ image_refs: [imageRef({ file: 'refs/images/yura/p.gif' })] })],
    ['image ref kind unknown', base({ image_refs: [imageRef({ kind: 'selfie' })] })],
    ['image ref note too long', base({ image_refs: [imageRef({ note: 'x'.repeat(501) })] })],
    ['too many image refs', base({ image_refs: Array.from({ length: 33 }, () => imageRef()) })],
];

// Schema accepts, the validator refuses — the rules "beyond the schema" of §10.2.
const BEYOND_SCHEMA = [
    ['reference in another hero\'s folder', base({ voice: { reference: reference({ file: 'voices/anna/a.wav' }) } }), 'reference_dir_mismatch'],
    ['".." inside a reference file name', base({ voice: { reference: reference({ file: 'voices/yura/a..b.wav' }) } }), 'reference_path'],
    ['image ref in another hero\'s folder', base({ image_refs: [imageRef({ file: 'refs/images/anna/p.png' })] }), 'reference_dir_mismatch'],
    ['look image_ref in another hero\'s folder', base({ passport, looks: [look({ image_ref: imageRef({ file: 'refs/images/anna/p.png' }) })] }), 'reference_dir_mismatch'],
    ['aliases equal after normalizeForMatch', base({ aliases: ['Юрий', ' юрий', 'Юрка'] }), 'duplicate_alias'],
    ['duplicate rule id inside the file', base({ behaviour: { rules: [rule(), rule()] } }), 'duplicate_rule_id'],
    ['duplicate look id', base({ passport, looks: [look(), look()] }), 'duplicate_look_id'],
];

describe('validateCharacterFile — приёмка 1.5', () => {
    describe('1.5 the schema and the hand-written validator give one verdict', () => {
        for (const [label, doc] of VALID) {
            it(`valid: ${label}`, () => {
                expect(schemaAccepts(doc), JSON.stringify(schemaAccepts.errors)).to.equal(true);
                const verdict = validateCharacterFile(doc);
                expect(verdict.valid, JSON.stringify(verdict.errors)).to.equal(true);
            });
        }
        for (const [label, doc] of INVALID) {
            it(`invalid: ${label}`, () => {
                expect(schemaAccepts(doc), 'the schema must reject this fixture').to.equal(false);
                const verdict = validateCharacterFile(doc);
                expect(verdict.valid).to.equal(false);
                // refused for a reason the schema also knows, with a place and a text
                expect(verdict.errors.some((e) => e.code === 'schema')).to.equal(true);
                for (const e of verdict.errors) {
                    expect(e).to.have.all.keys('code', 'path', 'message');
                    expect(e.message).to.be.a('string').and.not.equal('');
                }
            });
        }
    });

    describe('1.5 the three examples of the docs are valid', () => {
        for (const name of ['narrator', 'shop_women', 'yura']) {
            it(`${name}.json`, () => {
                const doc = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, `${name}.json`), 'utf8'));
                expect(schemaAccepts(doc), JSON.stringify(schemaAccepts.errors)).to.equal(true);
                expect(validateCharacterFile(doc, { filename: `${name}.json` })).to.deep.equal({ valid: true, errors: [], warnings: [] });
            });
        }
    });

    describe('the schema in the package is the normative one', () => {
        it('the copy and the example fixtures have the pinned sha256 (design/vbook-v4 ba19f69)', () => {
            expect(sha256(SCHEMA_PATH)).to.equal(PINNED['animastor.character-1.schema.json']);
            for (const name of ['narrator', 'shop_women', 'yura']) {
                expect(sha256(path.join(EXAMPLES_DIR, `${name}.json`)), name).to.equal(PINNED[`examples/${name}.json`]);
            }
        });

        it('byte-for-byte equal to animastor-docs (skipped until docs carry architecture/schemas)', function () {
            const normative = path.join(DOCS_SCHEMAS, 'animastor.character-1.schema.json');
            if (!fs.existsSync(normative)) {
                // animastor-docs main has no architecture/schemas until design/vbook-v4 is merged
                this.skip();
            }
            expect(fs.readFileSync(SCHEMA_PATH).equals(fs.readFileSync(normative))).to.equal(true);
            for (const name of ['narrator', 'shop_women', 'yura']) {
                expect(fs.readFileSync(path.join(EXAMPLES_DIR, `${name}.json`))
                    .equals(fs.readFileSync(path.join(DOCS_SCHEMAS, 'examples', `${name}.json`))), name).to.equal(true);
            }
        });
    });

    describe('rules beyond the schema (§10.2)', () => {
        for (const [label, doc, code] of BEYOND_SCHEMA) {
            it(`${label} → ${code}`, () => {
                expect(schemaAccepts(doc), 'the schema alone accepts this').to.equal(true);
                const verdict = validateCharacterFile(doc);
                expect(verdict.valid).to.equal(false);
                expect(verdict.errors.map((e) => e.code)).to.deep.equal([code]);
            });
        }

        it('the file name must be exactly <id>.json', () => {
            expect(validateCharacterFile(base(), { filename: 'yura.json' }).valid).to.equal(true);
            for (const filename of ['anna.json', 'Yura.json', 'yura.JSON', 'yura', 'yura.json.bak', '../yura.json', '']) {
                const verdict = validateCharacterFile(base(), { filename });
                expect(verdict.errors.map((e) => e.code), filename).to.deep.equal(['filename_mismatch']);
            }
            // without a file name (a hero inside a book object) there is nothing to compare
            expect(validateCharacterFile(base()).valid).to.equal(true);
        });
    });

    describe('unknown keys are warnings, never errors', () => {
        it('reports each unknown key with its path and keeps the document valid', () => {
            const doc = base({ future: 1, passport: { ...passport, scars: 'x' }, voice: { pitch: 2, timbre_source: 'user', reference: reference({ duration: 4, candidate_id: 'c1' }) } });
            const verdict = validateCharacterFile(doc);
            expect(verdict.valid).to.equal(true);
            expect(verdict.warnings.map((w) => [w.code, w.path]).sort()).to.deep.equal([
                ['unknown_key', 'future'], ['unknown_key', 'passport.scars'],
                ['unknown_key', 'voice.pitch'], ['unknown_key', 'voice.reference.duration'],
            ]);
        });

        it('does not mutate the document', () => {
            const doc = base({ aliases: [' Юрий '], passport, looks: [look()], voice: { reference: reference() } });
            const before = JSON.stringify(doc);
            validateCharacterFile(doc, { filename: 'yura.json' });
            expect(JSON.stringify(doc)).to.equal(before);
        });
    });
});

describe('validateBehaviourGlobals (behaviour.json, §6.3)', () => {
    const globals = (extra = {}) => ({ schema: 'animastor.behaviour-globals/1', ...extra });
    const CASES = [
        [true, 'minimal', globals()],
        [true, 'defaults and rules', globals({ defaults: { max_per_scene: 2, other: 1 }, rules: [rule(), rule({ id: 'r2' })] })],
        [true, 'max_per_scene 0 switches behaviours off', globals({ defaults: { max_per_scene: 0 } })],
        [true, 'unknown top-level key', globals({ note: 'x' })],
        [false, 'not an object', []],
        [false, 'schema missing', { rules: [] }],
        [false, 'schema of behavior.json v2', { schema_version: 2, rules: [], characters: {} }],
        [false, 'defaults not an object', globals({ defaults: 2 })],
        [false, 'max_per_scene negative', globals({ defaults: { max_per_scene: -1 } })],
        [false, 'max_per_scene fractional', globals({ defaults: { max_per_scene: 1.5 } })],
        [false, 'rules not an array', globals({ rules: {} })],
        [false, 'rule without id', globals({ rules: [{ when: {} }] })],
        [false, 'rule with scope', globals({ rules: [rule({ scope: 'global' })] })],
        [false, 'rule with character_id', globals({ rules: [rule({ character_id: 'yura' })] })],
    ];
    for (const [expected, label, doc] of CASES) {
        it(`${expected ? 'valid' : 'invalid'}: ${label} — schema and validator agree`, () => {
            expect(globalsAccepts(doc)).to.equal(expected);
            expect(validateBehaviourGlobals(doc).valid).to.equal(expected);
        });
    }
    it('rule ids are unique inside the file (beyond the schema)', () => {
        const doc = globals({ rules: [rule(), rule()] });
        expect(globalsAccepts(doc)).to.equal(true);
        expect(validateBehaviourGlobals(doc).errors.map((e) => e.code)).to.deep.equal(['duplicate_rule_id']);
    });
});

describe('vbook-bundle-4 schema ↔ validateBundleObject', () => {
    const CH = { chapter_id: 'ch-aaaaaa', scenes: [{ scene_id: 'sc-aaaaaa', participants: ['yura'] }] };
    const bundle = () => ({
        manifest: { book_id: 'b1', vbook_version: 4 },
        book: { structure: { chapters_order: ['ch-aaaaaa.json'], characters_order: ['narrator', 'yura'] } },
        locations: {},
        behaviour: { schema: 'animastor.behaviour-globals/1', rules: [] },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator' }, base({ passport, looks: [look()] })],
        hero_issues: [],
        chapters: [JSON.parse(JSON.stringify(CH))],
    });
    const PROBES = [
        [true, 'the base bundle', () => {}],
        [true, 'chapter.looks / scene.looks / scene.look_patch', (b) => { b.chapters[0].looks = { yura: 'coat' }; b.chapters[0].scenes[0].looks = { yura: 'base' }; b.chapters[0].scenes[0].look_patch = { yura: { clothes: 'robe', video_tokens: ['robe'] } }; }],
        [true, 'bible null and book null (lazy flow)', (b) => { b.bible = null; b.book = null; }],
        [false, 'manifest missing', (b) => { delete b.manifest; }],
        [false, 'manifest.book_id empty', (b) => { b.manifest.book_id = ''; }],
        [false, 'heroes missing', (b) => { delete b.heroes; }],
        [false, 'heroes an object', (b) => { b.heroes = {}; }],
        [false, 'a hero that is not a valid file', (b) => { b.heroes.push({ id: 'anna' }); }],
        [false, 'behaviour missing', (b) => { delete b.behaviour; }],
        [false, 'behaviour of the 3.1 shape', (b) => { b.behaviour = { schema_version: 2, rules: [], characters: {} }; }],
        [false, 'locations an array', (b) => { b.locations = []; }],
        [false, 'hero_issues an object', (b) => { b.hero_issues = {}; }],
        ...['characters', 'voices', 'behaviors', 'mentions'].map((key) => [false, `3.1 key ${key} present`, (b) => { b[key] = key === 'characters' ? [] : {}; }]),
        [false, 'chapter_id of the wrong grammar', (b) => { b.chapters[0].chapter_id = 'chapter-1'; }],
        [false, 'participants not an array', (b) => { b.chapters[0].scenes[0].participants = 'yura'; }],
        [false, 'chapter.looks an array', (b) => { b.chapters[0].looks = ['coat']; }],
        [false, 'scene.looks value not an id', (b) => { b.chapters[0].scenes[0].looks = { yura: 'In Coat' }; }],
        [false, 'scene.look_patch unknown field', (b) => { b.chapters[0].scenes[0].look_patch = { yura: { hat: 'x' } }; }],
        [false, 'scene.look_patch empty string', (b) => { b.chapters[0].scenes[0].look_patch = { yura: { clothes: '' } }; }],
        [false, 'scene.look_patch five tokens', (b) => { b.chapters[0].scenes[0].look_patch = { yura: { video_tokens: ['a', 'b', 'c', 'd', 'e'] } }; }],
        [false, 'scene.look_patch not an object', (b) => { b.chapters[0].scenes[0].look_patch = { yura: 'robe' }; }],
    ];
    for (const [expected, label, mutate] of PROBES) {
        it(`${expected ? 'accepts' : 'rejects'}: ${label}`, () => {
            const b = bundle();
            mutate(b);
            expect(bundleSchemaAccepts(b), JSON.stringify(bundleSchemaAccepts.errors)).to.equal(expected);
            const verdict = validateBundleObject(b);
            expect(verdict.valid, verdict.errors.join('; ')).to.equal(expected);
        });
    }
    it('documented deltas: version is schema-strict, hero-id uniqueness is validator-only', () => {
        const old = bundle(); old.manifest.vbook_version = '3.1';
        expect(bundleSchemaAccepts(old)).to.equal(false);
        expect(validateBundleObject(old).valid).to.equal(true); // enforced by assertSupportedVbookVersion on load/save/import
        const dup = bundle(); dup.heroes.push(dup.heroes[1]);
        expect(bundleSchemaAccepts(dup)).to.equal(true);
        expect(validateBundleObject(dup).errors.join(';')).to.match(/duplicate hero id/);
    });
});
