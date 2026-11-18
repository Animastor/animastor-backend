// ======================================================
// AI Patch Validation — Bundle Contract Guard Tests (VBook 4)
// ======================================================
// Guards the AI mutation pipeline:
//   AI patch → applyPatchesValidated → contract validation → save
//
// Regression coverage for the real incident: the assistant was asked to
// "add Svetlana's voice" in the Editor and produced a structurally broken
// voice (a value of the wrong type — what a missing closing brace /
// truncated tool-call argument degrades into). Android's strict parser then
// failed to load the book while the lenient Web frontend opened it with the
// voice missing.
//
// VBook 4 (@animastor/assistant 0.3.0): a voice is a block of a hero file
// (characters/<id>.json), edit_book addresses heroes by id —
// /heroes/<id>/voice/… — and the 3.1 paths /voices/… are refused.
//
// Contract: a patch that breaks the bundle must be REJECTED —
//   1. no success report (patches_applied: 0),
//   2. previous valid canonical state untouched on disk,
//   3. structured error naming the failing resource,
//   4. a corrected patch applies normally afterwards.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bookModule = require('../src/book/index');
const chatEngine = require('@animastor/assistant').createChatEngine({}, {
    validateBundleObject: require('../src/book/bundle-validator.cjs').validateBundleObject,
    aiProfile: null,
});
const config = require('../src/config/runtime-config');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

describe('AI Patch Validation — bundle contract guard (VBook 4 heroes)', () => {
    let tmpDir;
    let bookId;
    let bookDir;
    const heroFile = (id) => path.join(bookDir, 'characters', `${id}.json`);

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-patch-validation-'));
        bookId = 'test_patch_validation_' + Date.now();
        bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        fs.mkdirSync(path.join(bookDir, 'characters'), { recursive: true });
        config.BOOKS_DIR = tmpDir;

        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({
            book_id: bookId, vbook_version: 4, state: 'BOOTSTRAPPED', created_at: new Date().toISOString(),
        }, null, 2));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({
            book_id: bookId, title: 'Patch Validation Book', structure: { chapters_order: [] },
        }, null, 2));
        // the narrator's voice = the resource of the real incident
        fs.writeFileSync(heroFile('narrator'), JSON.stringify({
            schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep calm voice.' },
        }, null, 2));
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    // ── The incident, replayed at the engine level ────────────────
    it('rejects a broken voice patch (AI tool-call arguments)', () => {
        const bookData = bookModule.loadBook(bookId);
        // What a truncated/brace-broken AI tool-call argument degrades into:
        // the model supplies a raw string instead of a voice object.
        const args = JSON.parse(JSON.stringify({
            patches: [{ op: 'replace', path: '/heroes/narrator/voice', value: '{"timbre": "голос Светланы"' }],
        }));
        const patchResult = chatEngine.applyPatchesValidated(bookData, args.patches);
        expect(patchResult.result).to.be.null;
        expect(patchResult.errors).to.have.lengthOf(1);
        expect(patchResult.errors[0]).to.include('heroes');
        expect(patchResult.validation_errors.join(' ')).to.include('narrator');
    });

    it('rejects the Svetlana add-hero patch with a broken voice and keeps the files intact', () => {
        const bookData = bookModule.loadBook(bookId);
        const before = fs.readFileSync(heroFile('narrator'), 'utf8');
        const patchResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/heroes/svetlana', value: { name: 'Светлана', voice: 'broken string, not an object' } },
        ]);
        expect(patchResult.result).to.be.null;
        expect(patchResult.validation_errors.join(' ')).to.include('svetlana');
        expect(fs.readFileSync(heroFile('narrator'), 'utf8')).to.equal(before);
        expect(fs.existsSync(heroFile('svetlana'))).to.equal(false);
    });

    it('applies a corrected Svetlana voice on retry; the file of the new hero appears', () => {
        const bookData = bookModule.loadBook(bookId);
        const broken = chatEngine.applyPatchesValidated(bookData, [{ op: 'add', path: '/heroes/svetlana', value: { name: 'Светлана', voice: 'broken' } }]);
        expect(broken.result).to.be.null;

        const fixed = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/heroes/svetlana', value: { name: 'Светлана', voice: { timbre: 'Мягкий женский голос, тёплый тембр.' } } },
        ]);
        expect(fixed.errors).to.have.lengthOf(0);
        expect(fixed.result.heroes.find((h) => h.id === 'svetlana').voice.timbre).to.equal('Мягкий женский голос, тёплый тембр.');

        bookModule.saveBookBundle({ ...fixed.result, chapters: [] });
        const onDisk = JSON.parse(fs.readFileSync(heroFile('svetlana'), 'utf8'));
        expect(onDisk).to.deep.equal({ schema: 'animastor.character/1', name: 'Светлана', voice: { timbre: 'Мягкий женский голос, тёплый тембр.' }, id: 'svetlana' });
        expect(JSON.parse(fs.readFileSync(heroFile('narrator'), 'utf8')).voice.timbre).to.equal('Deep calm voice.');
    });

    it('rejects replacing the whole heroes list (with a scalar or a list)', () => {
        const bookData = bookModule.loadBook(bookId);
        for (const value of ['oops', []]) {
            const patchResult = chatEngine.applyPatchesValidated(bookData, [{ op: 'replace', path: '/heroes', value }]);
            expect(patchResult.result).to.be.null;
            expect(patchResult.errors.join(' ')).to.include('heroes');
        }
    });

    it('accepts valid multi-resource patches (a hero voice + a new hero + bible)', () => {
        fs.writeFileSync(path.join(bookDir, 'bible.json'), JSON.stringify({ country: 'Russia' }, null, 2));
        const reloaded = bookModule.loadBook(bookId);
        const patchResult = chatEngine.applyPatchesValidated(reloaded, [
            { op: 'add', path: '/heroes/narrator/voice/manner', value: 'Спокойно.' },
            { op: 'add', path: '/heroes/svetlana', value: { name: 'Svetlana', voice: { timbre: 'Спокойный голос.' } } },
            { op: 'replace', path: '/bible/country', value: 'USSR' },
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        expect(patchResult.result).to.not.be.null;
    });

    it('saveBookBundle refuses to write a bundle with a broken hero (defense in depth)', () => {
        const bookData = bookModule.loadBook(bookId);
        const heroBefore = fs.readFileSync(heroFile('narrator'), 'utf8');
        const manifestBefore = fs.readFileSync(path.join(bookDir, 'manifest.json'), 'utf8');
        bookData.heroes[0].voice = 'not-an-object';
        expect(() => bookModule.saveBookBundle(bookData)).to.throw(/narrator/);
        // Not a single file was touched — the throw precedes the first write.
        expect(fs.readFileSync(heroFile('narrator'), 'utf8')).to.equal(heroBefore);
        expect(fs.readFileSync(path.join(bookDir, 'manifest.json'), 'utf8')).to.equal(manifestBefore);
    });

    it('validateBundleFile reports resource-level errors with details; the 3.1 files are refused', () => {
        const { validateBundleFile } = require('../src/book/bundle-validator.cjs');
        const ok = validateBundleFile('characters/narrator.json', { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'ok', manner: '' } });
        expect(ok.valid).to.be.true;
        const bad = validateBundleFile('characters/narrator.json', { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 42 } });
        expect(bad.valid).to.be.false;
        expect(bad.errors.join(' ')).to.include('timbre');
        expect(validateBundleFile('voices.json', { narrator: { timbre: 'x' } }).valid).to.be.false;
        const nonSerializable = validateBundleFile('book.json', { structure: { chapters_order: [] }, bad: undefined });
        expect(nonSerializable.valid).to.be.true; // undefined keys are dropped by stringify — legal
    });

    it('rejects non-JSON-serializable patch values (NaN, circular reference)', () => {
        const bookData = bookModule.loadBook(bookId);
        const circular = { timbre: 'x' };
        circular.self = circular;
        const nanResult = chatEngine.applyPatchesValidated(bookData, [{ op: 'replace', path: '/heroes/narrator/voice', value: { timbre: NaN } }]);
        expect(nanResult.result).to.be.null;
        expect(nanResult.validation_errors.join(' ')).to.include('non-serializable');
        const circularResult = chatEngine.applyPatchesValidated(bookData, [{ op: 'replace', path: '/heroes/narrator/voice', value: circular }]);
        expect(circularResult.result).to.be.null;
    });

    it('chat route contract: a 3.1 path (/voices/…) is refused — nothing applied, the hint names /heroes', () => {
        const bookData = bookModule.loadBook(bookId);
        const patches = [{ op: 'add', path: '/voices/svetlana', value: { timbre: 'x' } }];
        const patchResult = chatEngine.applyPatchesValidated(bookData, patches);
        let applied = patches.length;
        if (patchResult.errors.length > 0) applied = 0;
        expect(applied).to.equal(0);
        expect(patchResult.result).to.be.null;
        expect(patchResult.errors[0]).to.match(/not part of VBook 4.*\/heroes\/<hero_id>/);
        for (const p of ['/characters/0/name', '/behaviors/yura', '/mentions/x', '/hero_issues/0', '/heroes/0/name', '/heroes/narrator/voice/reference', '/heroes/narrator/id']) {
            expect(chatEngine.applyPatchesValidated(bookData, [{ op: 'replace', path: p, value: 'x' }]).result, p).to.equal(null);
        }
    });

    it('valid patch → saves and reports success (happy path unchanged)', () => {
        const bookData = bookModule.loadBook(bookId);
        const patchResult = chatEngine.applyPatchesValidated(bookData, [
            { op: 'add', path: '/heroes/svetlana', value: { name: 'Светлана', voice: { timbre: 'Голос Светланы.' } } },
        ]);
        expect(patchResult.errors).to.have.lengthOf(0);
        bookModule.saveBookBundle({ ...patchResult.result, chapters: [] });
        const reloaded = bookModule.loadBook(bookId);
        expect(reloaded.heroes.find((h) => h.id === 'svetlana').voice.timbre).to.equal('Голос Светланы.');
    });
});
