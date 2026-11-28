// =====================================================
// Generation on a book with nothing to generate → 422 book_has_no_text
// =====================================================
// reports/2026-11-22/assistant-edit-bug.md §4: an audio generation on a
// blank VBook 4 book (one scene, one empty unit) was accepted, the audio
// dispatch found 0 jobs (no_jobs_generated), retried every tick and was
// finally cancelled — the user saw only "failed". POST /book/:id/generate
// (generate API v2; the former /regenerate was removed 2026-11-28) refuses the
// command up front, before any work; the material rule is per layer
// (helpers/book-text.cjs).

'use strict';

const { expect } = require('chai');
const generationMaterial = require('../src/helpers/book-text.cjs');
const { bookMaterial, nothingToGenerate } = generationMaterial;

function createResponse() {
    return {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

const blankUnit = () => ({ id: 'iu-409eacdd', type: 'narration', text: '' });
const bookWith = (units, extra = {}) => ({
    manifest: { vbook_version: 4, build_id: 'manual_1' },
    chapters: [{ chapter_id: 'ch-1', type: 'chapter', scenes: [{ scene_id: 'sc-1', type: 'narration', units, ...extra }] }],
});

describe('book-text: material per layer', () => {
    it('a blank v4 book has no material for any layer', () => {
        expect(bookMaterial(bookWith([blankUnit()]))).to.deep.equal({ scenes: 1, audio: false, image: false, video: false });
        expect(nothingToGenerate(bookWith([blankUnit()]), ['audio'])).to.equal(true);
        expect(nothingToGenerate(bookWith([blankUnit()]), null)).to.equal(true);
    });
    it('unit text (or audio.text / scene full_text / dialogue-block text) feeds every layer', () => {
        expect(bookMaterial(bookWith([{ id: 'iu-1', text: 'Hello.' }]))).to.include({ audio: true, image: true, video: true });
        expect(bookMaterial(bookWith([{ id: 'iu-1', audio: { text: 'Hi' } }])).audio).to.equal(true);
        expect(bookMaterial(bookWith([], { audio: { full_text: 'Hi' } })).audio).to.equal(true);
        expect(bookMaterial(bookWith([], { dialogue_blocks: [{ units: [{ text: 'Hi' }] }] })).audio).to.equal(true);
    });
    it('image.prompt without text: image/video yes, audio no (the 19.11 book)', () => {
        const b = bookWith([{ id: 'iu-1', text: null, image: { prompt: 'A room.' } }]);
        expect(bookMaterial(b)).to.include({ audio: false, image: true, video: true });
        expect(nothingToGenerate(b, ['audio'])).to.equal(true);
        expect(nothingToGenerate(b, ['audio', 'image'])).to.equal(false);
    });
    it('a cover scene is image material; video.action is video material', () => {
        const cover = { manifest: {}, chapters: [{ chapter_id: 'ch-c', type: 'cover', scenes: [{ scene_id: 'sc-c', units: [blankUnit()] }] }] };
        expect(nothingToGenerate(cover, ['image'])).to.equal(false);
        expect(nothingToGenerate(bookWith([{ id: 'iu-1', video: { action: 'Pan.' } }]), ['video'])).to.equal(false);
    });
    it('a scene-less book and unknown layers are not this guard\'s business', () => {
        expect(nothingToGenerate({ chapters: [] }, ['audio'])).to.equal(false);
        expect(nothingToGenerate(bookWith([blankUnit()]), ['bogus'])).to.equal(false);
    });
});

describe('POST /api/v1/book/:bookId/generate — book_has_no_text', () => {
    const { createV2Routes } = require('../src/orchestration-v2/routes');

    function mount(loadedBook) {
        const calls = { layerConfig: 0, createCommand: 0 };
        const handlers = new Map();
        const app = { post(p, ...h) { handlers.set(p, h[h.length - 1]); }, get() {}, put() {}, delete() {}, use() {} };
        const host = {
            isEnabled: () => true, disabledReason: () => null,
            videoUnsupportedReason: () => null, imageUnsupportedReason: () => null,
            orch: () => ({ createCommand: async () => { calls.createCommand++; throw new Error('not reached'); } }),
        };
        const routes = createV2Routes({
            host, config: {}, workerRepo: {},
            bookRepo: { getWorkspaceId: async () => null },          // past the guard → 409 book_without_workspace
            layerConfig: { get: async () => { calls.layerConfig++; return { audio_enabled: true, image_enabled: true, video_enabled: true }; } },
            redis: null, book: { loadBook: () => loadedBook, collectScenes: () => [] }, log: () => {},
        });
        routes.mountGenerateRoutes(app, { generationMaterial });  // composition-root injection (backend.cjs)
        return { handler: handlers.get('/api/v1/book/:bookId/generate'), calls };
    }
    const body = (layers) => ({ scope: { level: 'book' }, layers, mode: 'all', client_action_id: 'c-1' });

    it('a blank v4 book: audio generation → 422 book_has_no_text, nothing touched', async () => {
        const { handler, calls } = mount(bookWith([blankUnit()]));
        const res = createResponse();
        await handler({ params: { bookId: 'new_book_1' }, body: body(['audio']), headers: {} }, res);
        expect(res.statusCode).to.equal(422);
        expect(res.body).to.include({ error: 'book_has_no_text', code: 'book_has_no_text' });
        expect(res.body.message).to.match(/no text/);
        expect(calls).to.deep.equal({ layerConfig: 0, createCommand: 0 });
    });

    it('a book with an image prompt only: audio refused, image passes the guard', async () => {
        const b = bookWith([{ id: 'iu-1', text: null, image: { prompt: 'A room.' } }]);
        let m = mount(b);
        let res = createResponse();
        await m.handler({ params: { bookId: 'new_book_2' }, body: body(['audio']), headers: {} }, res);
        expect(res.statusCode).to.equal(422);

        m = mount(b);
        res = createResponse();
        await m.handler({ params: { bookId: 'new_book_2' }, body: body(['image']), headers: {} }, res);
        expect(res.statusCode).to.equal(409);
        expect(res.body.code).to.equal('book_without_workspace');
    });

    it('the composition root injects the guard into the generate API', () => {
        const src = require('fs').readFileSync(require.resolve('../src/backend.cjs'), 'utf8');
        expect(src).to.match(/mountGenerateRoutes\(app, \{ generationMaterial: require\('\.\/helpers\/book-text\.cjs'\) \}\)/);
    });
});
