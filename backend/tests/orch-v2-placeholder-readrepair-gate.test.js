// ======================================================
// О2 (reports/2026-11-07/orch-v2-image-scene-run.md) — the legacy read-repair
// of placeholder audio never touches an orchestration-v2 book
// ======================================================
// GET /book (@animastor/editor editor-routes) and POST recover-placeholders
// call placeholderAudio.recoverMissingPlaceholders() on every read. For a v2
// book WITHOUT audio it must create nothing — no mp3 on disk, no
// scene_assets row (ADR ORCHESTRATION_V2 I2: only the v2 acceptance writes
// scene_assets). The gate is the one legacy isolation predicate
// (PersistencePort orchestration.isV2Book), the same the scheduler and
// reconcile ask; a legacy control book still goes through the read-repair.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const bookFlag = require('../src/orchestration-v2/book-flag');
const lazyBook = require('../src/book/lazy-book');
const placeholderAudio = require('../src/services/placeholder-audio');
const persistencePort = require('@animastor/orchestration').ports.persistence;

describe('О2 — placeholder read-repair is gated by the legacy isolation predicate', function () {
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
        await query(`INSERT INTO books (book_id, title, workspace_id, orchestration) VALUES ($1, 'v2', $3, 'v2'), ($2, 'leg', $3, 'legacy')`, [V2, LEG, wsId]);
        bookFlag.invalidate();
        origLoadDraft = lazyBook.loadDraftBook;
        // Disk draft: one scene, no audio anywhere. For the legacy control the
        // draft is "not on disk" — enough to prove the read-repair ran.
        lazyBook.loadDraftBook = (bookId) => {
            draftCalls.push(bookId);
            if (bookId !== V2) return null;
            return { manifest: { state: 'ANALYZED' }, chapters: [{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }] };
        };
    });

    after(async () => {
        lazyBook.loadDraftBook = origLoadDraft;
        await query(`DELETE FROM scene_assets WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM books WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, BUILD), { recursive: true, force: true });
        bookFlag.invalidate();
    });

    it('the shared predicate says v2 for the v2 book, legacy for the control', async () => {
        expect(await persistencePort.isV2Book(V2)).to.equal(true);
        expect(await persistencePort.isV2Book(LEG)).to.equal(false);
    });

    it('v2 book without audio: nothing on disk, no scene_assets row, the draft is not even read', async () => {
        const res = await placeholderAudio.recoverMissingPlaceholders(BUILD, V2);
        expect(res).to.include({ checked: 0, created: 0, skipped_v2: true });
        expect(res.errors).to.deep.equal([]);
        expect(draftCalls).to.not.include(V2);
        const rows = (await query(`SELECT 1 FROM scene_assets WHERE book_id = $1`, [V2])).rows;
        expect(rows).to.have.length(0);
        const dir = path.join(config.OUTPUT_DIR, BUILD);
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(V2)) : [];
        expect(files).to.deep.equal([]);
    });

    it('repeated GET /book reads stay write-free (idempotent)', async () => {
        for (let i = 0; i < 3; i++) await placeholderAudio.recoverMissingPlaceholders(BUILD, V2);
        expect((await query(`SELECT 1 FROM scene_assets WHERE book_id = $1`, [V2])).rows).to.have.length(0);
    });

    it('legacy control book still goes through the read-repair', async () => {
        const res = await placeholderAudio.recoverMissingPlaceholders(BUILD, LEG);
        expect(res.skipped_v2).to.equal(undefined);
        expect(draftCalls).to.include(LEG);
    });

    it('the editor GET /book leg still calls the same function (gate is inside it, not in the route)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'packages', 'animastor-editor', 'src', 'editor-routes.cjs'), 'utf8');
        expect(src).to.include('placeholderAudio.recoverMissingPlaceholders(buildId, bookId)');
    });
});
