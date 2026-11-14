// ======================================================
// VBOOK BUNDLE 4 — validator ↔ schema contract sync (audit A1)
// ======================================================
// The schemas at packages/animastor-vbook-runtime/schemas/ —
// vbook-bundle-4.schema.json (the in-memory book) and
// character-1.schema.json (a hero file, normative copy from animastor-docs,
// architecture/VBOOK_FORMAT_V4.md) — are pinned to bundle-validator.cjs rule
// by rule. What the validator rejects, the schema rejects, and vice versa —
// with the documented strictness deltas explicitly baselined (see the schema
// description):
//   D1  manifest vbook_version/state/source — schema-strict; the validator
//       stays lenient and the version is enforced by
//       assertSupportedVbookVersion on load, save and import; production
//       manifest writers are pinned below instead;
//   D2  unit-id grammar — schema-strict; the validator's unit scan is
//       currently a no-op (its collect filter pre-selects matching ids),
//       recorded as a conscious validator gap, NOT silently drifted;
//   D3  JSON-serializability (NaN/circular) — validator-side pre-write
//       hardening; unexpressable in a schema of parsed JSON;
//   D4  uniqueness (hero ids in heroes[], rule ids in behaviour.rules) and the
//       beyond-schema rules of a hero file — validator-only.
// The 3.1 schema is gone together with the format: VBook 3.1 is not readable.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const { REPO_ROOT } = require('./helpers');

const SCHEMAS_DIR = path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime', 'schemas');
const SCHEMA_PATH = path.join(SCHEMAS_DIR, 'vbook-bundle-4.schema.json');
const CHARACTER_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'character-1.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const characterSchema = JSON.parse(fs.readFileSync(CHARACTER_SCHEMA_PATH, 'utf8'));

const validator = require('@animastor/vbook-runtime/bundle-validator.cjs');

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(characterSchema);
const schemaAccepts = ajv.compile(schema);

function schemaRejects(value) {
    return !schemaAccepts(value);
}

// ── Shared fixture base (matches the in-memory post-build bundle shape) ──
function baseBundle() {
    return {
        manifest: { book_id: 'b1' },
        book: null,
        locations: {},
        behaviour: { schema: 'animastor.behaviour-globals/1', rules: [] },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator' }],
    };
}

function validatorVerdict(bundle) {
    return validator.validateBundleObject(bundle).valid;
}

const HERO = (extra = {}) => ({ schema: 'animastor.character/1', id: 'v1', ...extra });
const REF = (extra = {}) => ({ file: 'voices/v1/c1.wav', ref_text: 'Фраза.', source: 'designed', model: 'm', seed: 3, sha256: 'a'.repeat(64), verification: 'passed', locked: true, ...extra });

describe('vbook-bundle-4: schema exists and mirrors the validator (audit A1)', () => {
    it('the canonical schema files are present in the package; the 3.1 schema is gone', () => {
        expect(schema.$id).to.include('vbook-bundle-4');
        expect(characterSchema.title).to.equal('animastor.character/1');
        expect(fs.readdirSync(SCHEMAS_DIR).sort()).to.deep.equal(['character-1.schema.json', 'vbook-bundle-4.schema.json']);
    });

    // Two-way equivalence battery: every probe mutates one rule family.
    const PROBES = [
        ['manifest missing', (b) => { delete b.manifest; }],
        ['manifest not an object', (b) => { b.manifest = 'x'; }],
        ['manifest.book_id missing', (b) => { delete b.manifest.book_id; }],
        ['manifest.book_id not a string', (b) => { b.manifest.book_id = 42; }],
        ['manifest.book_id empty', (b) => { b.manifest.book_id = ''; }],
        ['book.json null (lazy flow tolerated)', (b) => { b.book = null; }],
        ['book.json not an object', (b) => { b.book = 'x'; }],
        ['book.structure not an object', (b) => { b.book = { structure: 'x' }; }],
        ['chapters_order is a string', (b) => { b.book = { structure: { chapters_order: 'x' } }; }],
        ['chapters_order has non-string', (b) => { b.book = { structure: { chapters_order: ['a', 5] } }; }],
        ['locations missing', (b) => { delete b.locations; }],
        ['locations is an array', (b) => { b.locations = []; }],
        ['locations is null', (b) => { b.locations = null; }],
        ['heroes missing', (b) => { delete b.heroes; }],
        ['heroes is an object', (b) => { b.heroes = {}; }],
        ['hero not an object', (b) => { b.heroes = [HERO(), 'oops']; }],
        ['hero without schema marker', (b) => { b.heroes = [{ id: 'v1' }]; }],
        ['hero id outside the grammar', (b) => { b.heroes = [HERO({ id: '../x' })]; }],
        ['hero id reserved', (b) => { b.heroes = [HERO({ id: 'book' })]; }],
        ['hero voice not an object', (b) => { b.heroes = [HERO({ voice: 'x' })]; }],
        ['hero voice.timbre not a string', (b) => { b.heroes = [HERO({ voice: { timbre: 5 } })]; }],
        ['hero voice.reference valid', (b) => { b.heroes = [HERO({ voice: { timbre: 't', reference: REF() } })]; }],
        ['hero voice.reference bad sha256', (b) => { b.heroes = [HERO({ voice: { reference: REF({ sha256: 'xyz' }) } })]; }],
        ['hero voice.reference file outside voices/', (b) => { b.heroes = [HERO({ voice: { reference: REF({ file: '../c1.wav' }) } })]; }],
        ['hero voice.reference absolute file', (b) => { b.heroes = [HERO({ voice: { reference: REF({ file: '/voices/v1/c1.wav' }) } })]; }],
        ['hero looks without passport', (b) => { b.heroes = [HERO({ looks: [{ id: 'coat', label: 'x', fields: { clothes: 'c' } }] })]; }],
        ['hero behaviour with a foreign key', (b) => { b.heroes = [HERO({ behaviour: { baseline: 'x' } })]; }],
        ['behaviour missing', (b) => { delete b.behaviour; }],
        ['behaviour is a string', (b) => { b.behaviour = 'x'; }],
        ['behaviour of the 3.1 shape', (b) => { b.behaviour = { schema_version: 2, rules: [], characters: {} }; }],
        ['behaviour rule with scope', (b) => { b.behaviour.rules = [{ id: 'r', scope: 'global' }]; }],
        ['3.1 map characters present', (b) => { b.characters = []; }],
        ['3.1 map voices present', (b) => { b.voices = {}; }],
        ['3.1 map behaviors present', (b) => { b.behaviors = {}; }],
        ['3.1 map mentions present', (b) => { b.mentions = {}; }],
        ['chapter.looks valid', (b) => { b.chapters = [{ chapter_id: 'ch-000001', looks: { v1: 'coat' }, scenes: [] }]; }],
        ['chapter.looks not an object', (b) => { b.chapters = [{ looks: ['coat'], scenes: [] }]; }],
        ['scene.looks value not an id', (b) => { b.chapters = [{ scenes: [{ looks: { v1: 'In Coat' } }] }]; }],
        ['scene.look_patch valid', (b) => { b.chapters = [{ scenes: [{ look_patch: { v1: { clothes: 'robe' } } }] }]; }],
        ['scene.look_patch unknown field', (b) => { b.chapters = [{ scenes: [{ look_patch: { v1: { hat: 'x' } } }] }]; }],
        ['scene.look_patch empty value', (b) => { b.chapters = [{ scenes: [{ look_patch: { v1: { clothes: '' } } }] }]; }],
        ['chapters missing (optional)', (b) => { delete b.chapters; }],
        ['chapters is a string', (b) => { b.chapters = 'x'; }],
        ['chapter not an object', (b) => { b.chapters = ['x']; }],
        ['chapter_id bad grammar', (b) => { b.chapters = [{ chapter_id: 'ch-XYZ', scenes: [] }]; }],
        ['chapter_id is a number (validator tolerates non-strings)', (b) => { b.chapters = [{ chapter_id: 123, scenes: [] }]; }],
        ['scenes is a string', (b) => { b.chapters = [{ scenes: 'x' }]; }],
        ['scene not an object', (b) => { b.chapters = [{ scenes: ['x'] }]; }],
        ['scene_id bad grammar', (b) => { b.chapters = [{ scenes: [{ scene_id: 'sc-zz' }] }]; }],
        ['participants is a string', (b) => { b.chapters = [{ scenes: [{ participants: 'a' }] }]; }],
        ['participants has an empty string', (b) => { b.chapters = [{ scenes: [{ participants: ['ok', ''] }] }]; }],
    ];

    PROBES.forEach(([name, mutate]) => {
        it(`two-way sync: "${name}"`, () => {
            const bundle = baseBundle();
            mutate(bundle);
            const validatorValid = validatorVerdict(bundle);
            const schemaValid = !schemaRejects(bundle);
            expect(validatorValid, `validator verdict for "${name}"`).to.equal(schemaValid, `schema verdict for "${name}"`);
        });
    });

    it('the canonical bundle passes both sides', () => {
        const bundle = baseBundle();
        bundle.manifest.vbook_version = 4;
        bundle.book = { book_id: 'b1', structure: { chapters_order: ['ch-000001.json'], characters_order: ['narrator'] } };
        bundle.chapters = [{
            chapter_id: 'ch-000001',
            scenes: [{ scene_id: 'sc-000001', participants: ['c1', 'c2'], units: [{ id: 'iu-000001' }] }],
        }];
        expect(validatorVerdict(bundle)).to.equal(true);
        expect(schemaRejects(bundle)).to.equal(false);
    });

    // ── D1 — schema-strict manifest production fields ────────────────────
    describe('documented delta D1: manifest production fields (schema-strict, producer-pinned)', () => {
        it('schema rejects a wrong vbook_version / state / source value the validator tolerates', () => {
            const bundle = baseBundle();
            for (const version of ['3.1', '3.0', 3, '5', 4.5]) {
                bundle.manifest.vbook_version = version;
                expect(validatorVerdict(bundle), 'the validator leaves the version to assertSupportedVbookVersion').to.equal(true);
                expect(schemaRejects(bundle), `schema freezes the production contract (${version})`).to.equal(true);
            }
            for (const version of [4, '4', '4.1']) {
                bundle.manifest.vbook_version = version;
                expect(schemaRejects(bundle), `readable version ${version}`).to.equal(false);
            }
        });

        it('the version gate itself refuses what the schema refuses', () => {
            const { isSupportedVbookVersion } = require('@animastor/vbook-runtime/vbook-version.cjs');
            for (const version of ['3.1', '3.0', 3, '5', 4.5, undefined, null, '']) {
                expect(isSupportedVbookVersion({ vbook_version: version }), String(version)).to.equal(false);
            }
            for (const version of [4, '4', '4.1']) expect(isSupportedVbookVersion({ vbook_version: version })).to.equal(true);
        });

        it('producers emit the integer vbook_version 4 with enum-conforming state/source', () => {
            const draftSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'animastor-vbook-runtime', 'src', 'lazy-book', 'draft.js'), 'utf8');
            expect(draftSrc).to.match(/vbook_version:\s*SUPPORTED_VBOOK_VERSION/);
            expect(require('@animastor/vbook-runtime/vbook-version.cjs').SUPPORTED_VBOOK_VERSION).to.equal(4);
            expect(draftSrc).to.match(/source:\s*sourceType/);
            expect(draftSrc).to.match(/state:\s*BookState\.RAW_IMPORTED/);
            // The blank-book producer lives in the @animastor/editor package
            // since the Phase 4 move (docs/architecture/editor-module-extraction-audit.md).
            const crudSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'animastor-editor', 'src', 'entity-crud-routes.cjs'), 'utf8');
            expect(crudSrc).to.match(/vbook_version:\s*4,/);
            for (const src of [draftSrc, crudSrc]) expect(src).to.not.match(/vbook_version:\s*'3/);
        });

        it('constants enums stay in sync with the schema enums', () => {
            const constants = require('@animastor/vbook-runtime/lazy-book/constants');
            expect(Object.values(constants.BookState).sort()).to.deep.equal([...schema.$defs.manifest.properties.state.enum].sort());
            expect(Object.values(constants.SourceType).sort()).to.deep.equal([...schema.$defs.manifest.properties.source.enum].sort());
        });
    });

    // ── D4 — uniqueness is validator-only ────────────────────────────────
    describe('documented delta D4: uniqueness is validator-only', () => {
        it('duplicate hero ids and duplicate global rule ids pass the schema and fail the validator', () => {
            const dupHero = baseBundle();
            dupHero.heroes.push(dupHero.heroes[0]);
            expect(schemaRejects(dupHero)).to.equal(false);
            expect(validatorVerdict(dupHero)).to.equal(false);
            const dupRule = baseBundle();
            dupRule.behaviour.rules = [{ id: 'r' }, { id: 'r' }];
            expect(schemaRejects(dupRule)).to.equal(false);
            expect(validatorVerdict(dupRule)).to.equal(false);
        });
    });

    // ── D2 — unit-id grammar (validator gap pinned, not drifted) ─────────
    describe('documented delta D2: unit-id grammar is schema-strict', () => {
        it('the validator unit scan is currently a no-op (pinned as a conscious gap)', () => {
            const bundle = baseBundle();
            bundle.chapters = [{ scenes: [{ units: [{ id: 'iu-ZZ' }] }] }];
            expect(validatorVerdict(bundle)).to.equal(true);
            expect(schemaRejects(bundle)).to.equal(true);
        });
    });
});
