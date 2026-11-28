// ======================================================
// Host migration: book_layer_config (ORCHESTRATION_V2 §11.1, 2026-11-27)
// ======================================================
// The table lives in the host schema (storage/postgres/schema.js), not in the
// core's gen/sql: only services/layer-config reads/writes it. Checks:
//   1. a database without the table (state before this change) → runMigrations
//      creates it: columns, PK, FK → books ON DELETE CASCADE;
//   2. a second run changes nothing (same definitions, the stored rows are
//      byte-identical, updated_at untouched).

'use strict';

const { expect } = require('chai');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

const BOOK = `lcmig-${Date.now().toString(36)}`;

async function shape() {
    const cols = (await query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_name = 'book_layer_config'
        ORDER BY ordinal_position`)).rows;
    const cons = (await query(`
        SELECT conname, contype, confdeltype, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conrelid = 'book_layer_config'::regclass
        ORDER BY conname`)).rows;
    return { cols, cons };
}

describe('host migration — book_layer_config', function () {
    this.timeout(60000);

    after(async () => {
        await query('DELETE FROM books WHERE book_id = $1', [BOOK]);
    });

    it('a database before the migration gets the table; a second run changes nothing', async () => {
        await runMigrations();
        // the state before this change: no table
        await query('DROP TABLE IF EXISTS book_layer_config');
        expect((await query(`SELECT to_regclass('book_layer_config') AS t`)).rows[0].t).to.equal(null);

        await runMigrations();
        const first = await shape();
        expect(first.cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).to.deep.equal([
            ['book_id', 'text', 'NO'],
            ['config', 'jsonb', 'NO'],
            ['updated_at', 'timestamp with time zone', 'NO'],
        ]);
        const pk = first.cons.find((c) => c.contype === 'p');
        expect(pk.def).to.equal('PRIMARY KEY (book_id)');
        const fk = first.cons.find((c) => c.contype === 'f');
        expect(fk.def).to.equal('FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE');
        expect(fk.confdeltype).to.equal('c');

        await query(`INSERT INTO books (book_id, title) VALUES ($1, 'mig')`, [BOOK]);
        await query(`INSERT INTO book_layer_config (book_id, config) VALUES ($1, '{"image_enabled": false}'::jsonb)`, [BOOK]);
        const rowBefore = (await query('SELECT config::text AS c, updated_at FROM book_layer_config WHERE book_id = $1', [BOOK])).rows[0];

        await runMigrations();
        expect(await shape()).to.deep.equal(first);
        const rowAfter = (await query('SELECT config::text AS c, updated_at FROM book_layer_config WHERE book_id = $1', [BOOK])).rows[0];
        expect(rowAfter.c).to.equal(rowBefore.c);
        expect(rowAfter.updated_at.getTime()).to.equal(rowBefore.updated_at.getTime());
    });
});
