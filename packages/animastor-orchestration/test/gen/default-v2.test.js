// ======================================================
// gen v2 — 006-default-v2: every book is v2 (owner decision 26.11)
// ======================================================
// Two facts are pinned here, both against a REAL pre-006 database built from
// the canonical migrations (001..005) — never against a hand-made column:
//
//   1. a book created after the migration takes orchestration='v2' from the
//      column default (no code writes the column — book-repo only reads it);
//   2. a book that already exists with 'legacy' is flipped to 'v2' by the
//      migration itself, and a second/third run changes nothing (the runner
//      applies every migration on each backend start).
//
// The legacy orchestration code is not touched by this change: the value in
// books.orchestration is data (ADR ORCHESTRATION_V2 §12 stage 4 removes the
// code later).

'use strict';

const assert = require('node:assert/strict');
const gen = require('../../src/gen');
const { setupDb, uuid } = require('./helpers');

/** A database that has seen 001..005 and not 006 — the pre-change world. */
async function applyMigrationsBefore006(ctx) {
    for (const m of gen.MIGRATIONS) {
        if (m.id === '006-default-v2') continue;
        for (const sql of m.statements) await ctx.q(sql);
    }
}

const orchestrationOf = async (ctx, bookId) =>
    (await ctx.q(`SELECT orchestration FROM books WHERE book_id = $1`, [bookId])).rows[0].orchestration;

describe('gen v2 — 006-default-v2 (v2 is the default orchestration)', function () {
    this.timeout(20000);
    let ctx;
    beforeEach(async () => { ctx = await setupDb({ migrate: false }); });
    afterEach(async () => { await ctx.teardown(); });

    it('is registered as the migration after 005', () => {
        const ids = gen.MIGRATIONS.map((m) => m.id);
        assert.equal(ids[ids.length - 1], '006-default-v2');
        assert.equal(ids.indexOf('006-default-v2'), ids.indexOf('005-voice-reference') + 1);
    });

    it('flips an existing legacy book to v2 and leaves a v2 book alone', async () => {
        await applyMigrationsBefore006(ctx);
        // pre-change state: the column default is still 'legacy' (001)
        await ctx.q(`INSERT INTO books (book_id, workspace_id) VALUES ('legacy-book', $1)`, [uuid()]);
        assert.equal(await orchestrationOf(ctx, 'legacy-book'), 'legacy');
        await ctx.q(`INSERT INTO books (book_id, workspace_id, orchestration) VALUES ('v2-book', $1, 'v2')`, [uuid()]);

        await gen.migrate(ctx.pool);

        assert.equal(await orchestrationOf(ctx, 'legacy-book'), 'v2');
        assert.equal(await orchestrationOf(ctx, 'v2-book'), 'v2');
    });

    it('a book created after the migration is v2 (column default, no explicit value)', async () => {
        await gen.migrate(ctx.pool);
        await ctx.q(`INSERT INTO books (book_id, workspace_id) VALUES ('new-book', $1)`, [uuid()]);
        assert.equal(await orchestrationOf(ctx, 'new-book'), 'v2');
    });

    it('is idempotent: three runs change neither rows nor the default', async () => {
        await applyMigrationsBefore006(ctx);
        await ctx.q(`INSERT INTO books (book_id, workspace_id, orchestration) VALUES ('legacy-book', $1, 'legacy')`, [uuid()]);
        await gen.migrate(ctx.pool);
        await gen.migrate(ctx.pool);
        await gen.migrate(ctx.pool);

        assert.equal(await orchestrationOf(ctx, 'legacy-book'), 'v2');
        await ctx.q(`INSERT INTO books (book_id, workspace_id) VALUES ('later-book', $1)`, [uuid()]);
        assert.equal(await orchestrationOf(ctx, 'later-book'), 'v2');
        assert.equal(Number((await ctx.q(`SELECT count(*)::int AS n FROM books WHERE orchestration = 'legacy'`)).rows[0].n), 0);
    });
});
