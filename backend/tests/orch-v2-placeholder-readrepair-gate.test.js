// ======================================================
// О2 (reports/2026-11-07/orch-v2-image-scene-run.md) — the legacy read-repair
// of placeholder audio writes nothing
// ======================================================
// GET /book (@animastor/editor editor-routes, the published editor) calls
// placeholderAudio.recoverMissingPlaceholders() on every read. ADR
// ORCHESTRATION_V2 I2: only the v2 acceptance writes scene_assets. Since
// 2026-11-28 (этап 4) every book is v2 and the function is a no-op: no mp3
// on disk, no scene_assets row, the draft is not even read — for any book.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const lazyBook = require('../src/book/lazy-book');
const placeholderAudio = require('../src/services/placeholder-audio');

describe('О2 — placeholder read-repair is a no-op (every book is v2)', function () {
    this.timeout(30000);
    const stamp = `o2ph${Date.now().toString(36)}`;
    const V2 = `${stamp}-v2`;
    const LEG = `${stamp}-legacy`;
    const BUILD = `bld-${stamp}`;
    let wsId;
    let origLoadDraft;
    const draftCalls = [];

    before(async () => {
        await runMigrations();
        wsId = (await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`, [`w-${stamp}`])).rows[0].id;
        await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, 'v2', $3), ($2, 'second', $3)`, [V2, LEG, wsId]);
        origLoadDraft = lazyBook.loadDraftBook;
        // Disk draft: one scene, no audio anywhere.
        lazyBook.loadDraftBook = (bookId) => {
            draftCalls.push(bookId);
            return { manifest: { state: 'ANALYZED' }, chapters: [{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }] };
        };
    });

    after(async () => {
        lazyBook.loadDraftBook = origLoadDraft;
        await query(`DELETE FROM scene_assets WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM books WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, BUILD), { recursive: true, force: true });
    });

    it('a book without audio: nothing on disk, no scene_assets row, the draft is not even read — every book', async () => {
        for (const bookId of [V2, LEG]) {
            const res = await placeholderAudio.recoverMissingPlaceholders(BUILD, bookId);
            expect(res).to.include({ checked: 0, created: 0, skipped_v2: true });
            expect(res.errors).to.deep.equal([]);
            expect(draftCalls).to.not.include(bookId);
            const rows = (await query(`SELECT 1 FROM scene_assets WHERE book_id = $1`, [bookId])).rows;
            expect(rows).to.have.length(0);
            const dir = path.join(config.OUTPUT_DIR, BUILD);
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(bookId)) : [];
            expect(files).to.deep.equal([]);
        }
    });

    it('repeated GET /book reads stay write-free (idempotent)', async () => {
        for (let i = 0; i < 3; i++) await placeholderAudio.recoverMissingPlaceholders(BUILD, V2);
        expect((await query(`SELECT 1 FROM scene_assets WHERE book_id = $1`, [V2])).rows).to.have.length(0);
    });

    it('the editor GET /book leg still calls the same function (published editor <= 0.5.x)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'packages', 'animastor-editor', 'src', 'editor-routes.cjs'), 'utf8');
        expect(src).to.include('placeholderAudio.recoverMissingPlaceholders(buildId, bookId)');
    });
});
