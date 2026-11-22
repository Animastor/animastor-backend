// =====================================================
// /regenerate on a book with nothing to generate → 422 book_has_no_text
// =====================================================
// reports/2026-11-22/assistant-edit-bug.md §4: an audio generation on a
// blank VBook 4 book (one scene, one empty unit) was accepted, the audio
// dispatch found 0 jobs (no_jobs_generated), retried every tick and was
// finally cancelled — the user saw only "failed". The route now refuses the
// command up front, before any task, dirty mark or dispatch, for both
// orchestrations; the material rule is per layer (helpers/book-text.cjs).

'use strict';

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
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

describe('POST /api/v1/book/:bookId/regenerate — book_has_no_text', () => {
    const route = '../src/routes/book/generation-routes.cjs';
    let saved;
    beforeEach(() => { const r = require.resolve(route); saved = require.cache[r]; delete require.cache[r]; });
    afterEach(() => { const r = require.resolve(route); if (saved) require.cache[r] = saved; else delete require.cache[r]; });

    function mount(loadedBook) {
        const calls = { reset: 0, layerConfig: 0, clearCancel: 0 };
        const handlers = new Map();
        const app = { post(p, h) { handlers.set(p, h); }, get() {}, put() {}, delete() {} };
        require(route)(app, createMockRedis(), {
            config: { HUB_URL: 'http://gpu-hub.invalid', OUTPUT_DIR: '/tmp/empty-book-output' },
            book: { loadBook: () => loadedBook, collectScenes: () => [] },
            layerConfig: { get: async () => { calls.layerConfig++; return { audio_enabled: true, image_enabled: true, video_enabled: true }; }, set: async () => ({}) },
            bookDiff: { filterDirtyScenesByScope: (d) => d },
            storage: {},
            orchestrator: { resetScenes: async () => { calls.reset++; return { marked: 0 }; } },
            runtime: {
                sceneWindow: { clearCancelFlag: async () => { calls.clearCancel++; }, setCancelFlag: async () => {}, slideWindow: async () => ({}) },
                scheduler: { addSceneToActiveIndex: async () => {}, clearBookFromActiveIndex: async () => {} },
            },
            utils: { log: () => {} },
            generationMaterial, // composition-root injection (backend.cjs routeDeps)
        });
        return { handler: handlers.get('/api/v1/book/:bookId/regenerate'), calls };
    }

    it('a blank v4 book: audio generation → 422 book_has_no_text, nothing touched', async () => {
        const { handler, calls } = mount(bookWith([blankUnit()]));
        const res = createResponse();
        await handler({ params: { bookId: 'new_book_1' }, body: { scope: 'whole_book', worker_types: ['audio'], rebuild_all: true }, headers: {} }, res);
        expect(res.statusCode).to.equal(422);
        expect(res.body).to.include({ error: 'book_has_no_text', code: 'book_has_no_text' });
        expect(res.body.message).to.match(/no text/);
        expect(calls).to.deep.equal({ reset: 0, layerConfig: 0, clearCancel: 0 });
    });

    it('a book with an image prompt only: audio refused, image accepted', async () => {
        const b = bookWith([{ id: 'iu-1', text: null, image: { prompt: 'A room.' } }]);
        let m = mount(b);
        let res = createResponse();
        await m.handler({ params: { bookId: 'new_book_2' }, body: { scope: 'whole_book', worker_types: ['audio'] }, headers: {} }, res);
        expect(res.statusCode).to.equal(422);

        m = mount(b);
        res = createResponse();
        await m.handler({ params: { bookId: 'new_book_2' }, body: { scope: 'whole_book', worker_types: ['image'] }, headers: {} }, res);
        expect(res.statusCode).to.not.equal(422);
        expect(m.calls.layerConfig).to.equal(1);
    });

    it('the composition root injects the guard into the route deps', () => {
        const src = require('fs').readFileSync(require.resolve('../src/backend.cjs'), 'utf8');
        expect(src).to.match(/generationMaterial: require\('\.\/helpers\/book-text\.cjs'\)/);
    });
});
