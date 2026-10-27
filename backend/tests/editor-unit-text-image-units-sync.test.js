// ======================================================
// Editor unit text edit → image_units.text sync
// ======================================================
// Regression: PATCH /api/v1/book/:b/scene/:ch/:sc with { unit_id, fields:
// { text } } changed only the book JSON. The player (storyboard / timings /
// playback queue) reads unit text PG-first from image_units, so it kept
// showing the old text until the next generation.
//
// Real editor PATCH route + real player storyboard route on one express app,
// real PG (image_units) and real book bundle on disk.

const { expect } = require('chai');
const express = require('express');
const os = require('os');
const path = require('path');

const book = require('../src/book');
const utils = require('../src/helpers/utils.cjs');
const config = require('../src/config/runtime-config');
const { createEditorModel, createEditorRoutes } = require('../../packages/animastor-editor');
const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');

const BOOK_ID = 'test-book-unit-text-iu-sync';
const BUILD_ID = 'build_test_unit_text_iu_sync';
const CH = 'ch-1';
const SC = 'sc-1';

function buildBook() {
    return {
        manifest: { book_id: BOOK_ID, vbook_version: '3.1', build_id: BUILD_ID },
        book: { book_id: BOOK_ID, title: BOOK_ID, structure: { chapters_order: [] } },
        bible: { version: '3.0' },
        characters: [],
        chapters: [{
            chapter_id: CH,
            scenes: [{
                scene_id: SC,
                units: [
                    { id: 'u1', type: 'narration', text: 'Старый текст первого юнита.' },
                    { id: 'u2', type: 'narration', text: 'Второй юнит без изменений.' },
                ],
            }],
        }],
    };
}

describe('PATCH unit text → image_units.text (player storyboard)', () => {
    let query;
    let server;
    let base;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        query = require('../src/storage/postgres/database').query;
        const storage = require('../src/storage');
        const iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        const sceneAssetsRepo = require('../src/storage/postgres/repositories/scene-assets-repo');
        const bookModel = require('../src/book/book-model.cjs');
        const bookDiff = require('../src/services/book-diff.cjs')(null, config, { utils });
        const quietUtils = { ...utils, log: () => {} };

        const app = express();
        app.use(express.json());
        createEditorRoutes(app, null, {
            book, bookDiff, storage, bookDeletion: {},
            editorModel: createEditorModel({ bookModel, persistBook: book.saveBookBundle }),
            editorPorts: {
                placeholderAudio: {}, sceneAssetsRepo, auditCoverage: () => ({}),
                promptLimit: 1000, purge: {}, recoveryCtx: {},
            },
            utils: quietUtils,
        });
        createPlayerRoutes(app, null, {
            utils: quietUtils, iuRepo, sceneAssetsRepo,
            playerModel: createPlayerModel({ bookModel }),
            isBookRegistered: async () => true,
            image: { getSceneDuration: async () => 0 },
            outputRoot: os.tmpdir(),
            playerPorts: { computeVideoStartMs: async () => {} },
            bookProjections: {
                findSceneRuntimeData: book.findSceneRuntimeData,
                collectSceneUnits: book.collectSceneUnits,
            },
        });
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    async function cleanup() {
        for (const table of ['image_units', 'scene_assets', 'generation_tasks', 'scenes']) {
            await query(`DELETE FROM ${table} WHERE book_id = $1`, [BOOK_ID]);
        }
        book.resetBook(BOOK_ID);
    }

    beforeEach(async () => {
        await cleanup();
        book.saveBookBundle(buildBook(), null);
        const units = buildBook().chapters[0].scenes[0].units;
        for (const [idx, u] of units.entries()) {
            await query(`
                INSERT INTO image_units (build_id, book_id, chapter_id, scene_id, unit_id, scene_order,
                    text, text_length, text_proportion, scene_duration_sec, estimated_duration_sec,
                    scene_audio_file, start_ms, end_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.5, 4, 2, 'scene.mp3', $9, $10)
            `, [BUILD_ID, BOOK_ID, CH, SC, u.id, idx, u.text, u.text.length, idx * 2000, (idx + 1) * 2000]);
        }
    });

    afterEach(cleanup);

    const rows = async () => (await query(`
        SELECT build_id, unit_id, scene_order, text, text_length, length(text) AS pg_len,
               text_proportion, estimated_duration_sec, start_ms, end_ms
        FROM image_units WHERE book_id = $1 ORDER BY unit_id
    `, [BOOK_ID])).rows;

    const patchUnit = (unitId, fields) => fetch(`${base}/api/v1/book/${BOOK_ID}/scene/${CH}/${SC}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit_id: unitId, fields }),
    });

    it('PATCH fields.text → storyboard returns the new text, text_length = length(text), other units untouched', async () => {
        const before = await rows();
        const NEW_TEXT = 'Новый, заметно более длинный текст первого юнита после правки.';

        const res = await patchUnit('u1', { text: NEW_TEXT });
        expect(res.status).to.equal(200);

        const sb = await fetch(`${base}/api/v1/scene/${BOOK_ID}/${CH}/${SC}/storyboard`);
        expect(sb.status).to.equal(200);
        const body = await sb.json();
        expect(body.build_id).to.equal(BUILD_ID);
        const byId = Object.fromEntries(body.ius.map((iu) => [iu.unit_id, iu]));
        expect(byId.u1.text).to.equal(NEW_TEXT);
        expect(byId.u2.text).to.equal('Второй юнит без изменений.');

        const after = await rows();
        expect(after).to.have.length(2);
        const u1 = after.find((r) => r.unit_id === 'u1');
        expect(u1.build_id).to.equal(BUILD_ID);
        expect(u1.text).to.equal(NEW_TEXT);
        expect(u1.text_length).to.equal(u1.pg_len);
        expect(u1.text_length).to.equal(NEW_TEXT.length);
        // only text/text_length changed on the edited row
        const { text: _t, text_length: _l, pg_len: _p, ...u1Rest } = u1;
        const { text: _t0, text_length: _l0, pg_len: _p0, ...u1RestBefore } = before.find((r) => r.unit_id === 'u1');
        expect(u1Rest).to.deep.equal(u1RestBefore);
        // the other unit's row is byte-identical
        expect(after.find((r) => r.unit_id === 'u2')).to.deep.equal(before.find((r) => r.unit_id === 'u2'));
    });

    it('no image_units row for the edited unit → nothing is created', async () => {
        await query('DELETE FROM image_units WHERE book_id = $1 AND unit_id = $2', [BOOK_ID, 'u1']);
        const before = await rows();

        const res = await patchUnit('u1', { text: 'Текст без строки в PG.' });
        expect(res.status).to.equal(200);

        expect(await rows()).to.deep.equal(before);
    });
});
