// ======================================================
// Hero API test harness (VBOOK_FORMAT_V4 §8.2, step 4)
// ======================================================
// A VBook 4 book in a temporary BOOKS_DIR and a real HTTP server with the
// three editor registrars (editor-routes, entity-crud-routes, hero-routes)
// mounted over the REAL editor model (runtime loader + saveBookBundle + the
// character store) and the real book diff (dirty layers). Host legs that need
// PG / Redis are recorded stubs.
//
// Requires the backend node_modules resolution (the suite runs from backend/:
// npx mocha ../packages/animastor-editor/test, or through the backend include).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

require('./vbook-test-bindings.cjs');
const express = require('express');
const bookModule = require('../../../backend/src/book/index');
const config = require('../../../backend/src/config/runtime-config');
const { createEditorModel } = require('../src/editor-model.cjs');

const CH1 = 'ch-11111111';
const CH2 = 'ch-22222222';
const SHA = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function createBookDiff() {
    const state = {
        SceneState: {}, AssetState: {},
        setAssetState: async () => {}, setAssetStates: async () => {},
        getAssetStates: async () => ({ audio: 'new', image: 'new', video: 'new' }),
        setSceneStateWithBuildId: async () => {}, validateAssetTransition: () => ({ valid: true }),
    };
    const deps = {
        state,
        book: { loadBook: () => null, findSceneRuntimeData: () => null, collectScenes: () => [] },
        layerConfig: { get: async () => null, set: async () => null },
        genScope: { getScope: async () => null, scopeBounds: () => ({ startIndex: 0, endIndex: 0 }) },
        activeScenes: { addActiveScene: async () => ({ added: true }) },
        getChunk: async () => null,
        saveChunk: async () => {},
        utils: {
            log: () => {},
            collectScenes: (bookData) => {
                const scenes = [];
                for (const ch of (bookData && bookData.chapters) || []) {
                    for (const sc of ch.scenes || []) {
                        scenes.push({ chapter_id: ch.chapter_id, scene_id: sc.scene_id, scene_order: 0, participants: sc.participants || [], location: sc.location || null, scene: sc, payload: sc, chapter: ch });
                    }
                }
                return scenes;
            },
        },
    };
    return require('../../../backend/src/services/book-diff.cjs')({}, {}, deps);
}

const NARRATOR = () => ({ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep calm voice.', manner: 'Slow.', timbre_source: 'user' } });
const YURA = () => ({
    schema: 'animastor.character/1', id: 'yura', name: 'Юра', role: 'protagonist', aliases: ['Юрий'],
    passport: { appearance: 'tall man, dark hair', clothes: 'leather jacket', video_tokens: ['man', 'leather jacket'] },
    looks: [{ id: 'coat', label: 'В пальто', fields: { clothes: 'grey wool coat', video_tokens: ['man', 'grey coat'] } }],
    voice: { timbre: 'Warm baritone.', manner: 'Unhurried.', timbre_source: 'user' },
    behaviour: { profile: { baseline: 'calm', quirks: ['rubs his nose'], reactions: [{ trigger: 'is praised', reaction: 'looks away', note: 'kept' }] },
        rules: [{ id: 'yura.praised', when: { emotion: ['proud'] }, then: { action: 'looks away' }, probability: 0.6, enabled: true }] },
    notes: 'only for people',
});
const SVETA = () => ({ schema: 'animastor.character/1', id: 'sveta', name: 'Света', passport: { appearance: 'young woman, red hair', clothes: 'green dress', video_tokens: ['woman', 'red hair'] } });

/**
 * Write a v4 book. Chapter 1: scenes s1 (yura, sveta), s2 (yura). Chapter 2:
 * scene s3 (sveta) — so a look assigned to chapter 1 never touches chapter 2.
 */
function writeBook(booksDir, bookId, { heroes = [NARRATOR(), YURA(), SVETA()], extraFiles = {} } = {}) {
    const dir = path.join(booksDir, bookId);
    fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ book_id: bookId, vbook_version: 4, build_id: `build_${bookId}`, state: 'BOOTSTRAPPED' }, null, 2));
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ book_id: bookId, title: 'Hero Book', language: 'ru', structure: { chapters_order: [`${CH1}.json`, `${CH2}.json`], characters_order: ['narrator', 'yura', 'sveta'] } }, null, 2));
    fs.writeFileSync(path.join(dir, 'behaviour.json'), JSON.stringify({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [{ id: 'global.sigh', when: { emotion: ['sad'] }, then: { action: 'sighs' } }] }, null, 2));
    const unit = (id, text) => ({ id, type: 'narration', text, image: { prompt: text } });
    fs.writeFileSync(path.join(dir, 'chapters', `${CH1}.json`), JSON.stringify({
        chapter_id: CH1, chapter_title: 'One', type: 'chapter',
        scenes: [
            { scene_id: 'sc-00000001', type: 'narration', participants: ['yura', 'sveta'], location: { id: 'street' }, audio: { voice: 'narrator', full_text: 'A.' }, units: [unit('iu-00000001', 'A.')] },
            { scene_id: 'sc-00000002', type: 'narration', participants: ['yura'], location: { id: 'street' }, audio: { voice: 'narrator', full_text: 'B.' }, units: [unit('iu-00000002', 'B.')] },
        ],
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'chapters', `${CH2}.json`), JSON.stringify({
        chapter_id: CH2, chapter_title: 'Two', type: 'chapter',
        scenes: [{ scene_id: 'sc-00000003', type: 'narration', participants: ['sveta'], location: { id: 'street' }, audio: { voice: 'narrator', full_text: 'C.' }, units: [unit('iu-00000003', 'C.')] }],
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'locations.json'), JSON.stringify({ street: { description: 'street' } }, null, 2));
    for (const hero of heroes) fs.writeFileSync(path.join(dir, 'characters', `${hero.id}.json`), JSON.stringify(hero, null, 2));
    for (const [name, data] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, 'characters', name), data);
    return dir;
}

/**
 * Start a server with the editor registrars. Returns helpers; `calls` records
 * the dirty fan-out (bumpSceneVersions).
 */
async function startHeroServer() {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-api-'));
    const booksDir = path.join(sandbox, 'books');
    const outputDir = path.join(sandbox, 'output');
    fs.mkdirSync(booksDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const savedBooks = config.BOOKS_DIR;
    config.BOOKS_DIR = booksDir;

    const calls = { bump: [], reconcile: [] };
    const editorModel = createEditorModel({ persistBook: bookModule.saveBookBundle });
    const deps = {
        book: bookModule,
        bookDiff: createBookDiff(),
        storage: { bookSync: { reconcileFromDiff: async (id, dirty) => { calls.reconcile.push(dirty); return { reconciled: dirty.length }; } } },
        bookDeletion: { deleteBook: async () => ({}) },
        editorModel,
        editorPorts: {
            sceneAssetsRepo: { bumpSceneVersions: async (id, dirty) => { calls.bump.push(dirty); return dirty.length; }, setDirtyUnitIds: async () => 0 },
            placeholderAudio: { recoverMissingPlaceholders: async () => ({ created: 0, errors: [] }) },
            auditCoverage: { auditBookCoverage: () => ({}) },
            promptLimit: 4000,
            purge: { purgeScene: async () => ({ complete: true, steps: [] }), purgeUnit: async () => ({ complete: true, steps: [] }) },
            resolveOwnership: async () => 'ws',
            rollbackOwnership: async () => {},
            recoveryCtx: { isBookRegistered: async () => false, log: () => {} },
            outputRoot: outputDir,
        },
        utils: { log: () => {} },
    };
    const app = express();
    app.use(express.json());
    const editor = require('../src/index.cjs');
    editor.createEditorRoutes(app, null, deps);
    editor.createEntityCrudRoutes(app, null, deps);
    editor.createHeroRoutes(app, null, deps);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function api(method, url, body, headers = {}) {
        const r = await fetch(`${base}${url}`, {
            method,
            headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null;
        try { json = await r.json(); } catch (_) { /* empty */ }
        return { status: r.status, body: json };
    }

    return {
        sandbox, booksDir, outputDir, calls, api, editorModel, deps,
        bookDir: (bookId) => path.join(booksDir, bookId),
        heroFile: (bookId, id) => path.join(booksDir, bookId, 'characters', `${id}.json`),
        readHero: (bookId, id) => JSON.parse(fs.readFileSync(path.join(booksDir, bookId, 'characters', `${id}.json`), 'utf8')),
        readChapter: (bookId, ch) => JSON.parse(fs.readFileSync(path.join(booksDir, bookId, 'chapters', `${ch}.json`), 'utf8')),
        resetCalls: () => { calls.bump.length = 0; calls.reconcile.length = 0; },
        async close() {
            await new Promise((r) => server.close(r));
            config.BOOKS_DIR = savedBooks;
            fs.rmSync(sandbox, { recursive: true, force: true });
        },
    };
}

module.exports = { startHeroServer, writeBook, createBookDiff, NARRATOR, YURA, SVETA, CH1, CH2, SHA, bookModule, config };
