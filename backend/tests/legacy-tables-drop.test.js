// ======================================================
// ORCHESTRATION_V2 этап 4, шаг 7 — the drop migration of the legacy tables
// ======================================================
// storage/postgres/schema.js dropLegacyOrchestrationTables(): a table that is
// empty or holds only HISTORICAL rows is dropped; one LIVE row anywhere stops
// the migration with an explicit error and nothing is dropped.
// Unit level: the pg query is a fake (no real table is touched).

'use strict';

const { expect } = require('chai');
const {
    dropLegacyOrchestrationTables, LEGACY_ORCHESTRATION_TABLES, LegacyTablesNotEmptyError,
} = require('../src/storage/postgres/schema');

/** fake pg: tables = { name: { total, live } }; records every statement */
function fakePg(tables) {
    const sql = [];
    const q = async (text, params) => {
        sql.push(text);
        if (text.startsWith('SELECT to_regclass')) {
            const name = params[0].replace(/^public\./, '');
            return { rows: [{ t: tables[name] ? name : null }] };
        }
        const m = text.match(/^SELECT count\(\*\)::int AS n FROM (\w+)( WHERE .*)?$/);
        if (m) return { rows: [{ n: m[2] ? tables[m[1]].live : tables[m[1]].total }] };
        return { rows: [] };
    };
    return { q, sql };
}

describe('этап 4: drop of the legacy orchestration tables', () => {
    it('covers exactly the nine tables of the task (books / VBook sessions untouched)', () => {
        expect(LEGACY_ORCHESTRATION_TABLES.map((t) => t.table)).to.deep.equal([
            'generation_tasks', 'asset_states', 'generation_cancellations', 'reconciliation_events',
            'cache_entries', 'asset_dependencies', 'output_manifests', 'iu_image_fence_reservations', 'iu_image_pointers',
        ]);
        const names = LEGACY_ORCHESTRATION_TABLES.map((t) => t.table);
        for (const kept of ['books', 'book_generation_sessions', 'scene_assets', 'image_units', 'gen_jobs']) {
            expect(names).to.not.include(kept);
        }
    });

    it('empty / historical-only tables are dropped (the prod shape: generation_tasks = 1 failed row)', async () => {
        const tables = Object.fromEntries(LEGACY_ORCHESTRATION_TABLES.map(({ table }) => [table, { total: 0, live: 0 }]));
        tables.generation_tasks = { total: 1, live: 0 };
        tables.generation_cancellations = { total: 3, live: 0 };
        const { q, sql } = fakePg(tables);
        const r = await dropLegacyOrchestrationTables(q);
        expect(r.dropped).to.have.length(9);
        expect(r.historical).to.deep.equal({ generation_tasks: 1, generation_cancellations: 3 });
        expect(sql.filter((s) => s.startsWith('DROP TABLE'))).to.have.length(9);
        expect(sql).to.include('DROP SEQUENCE IF EXISTS iu_image_fence_seq');
    });

    it('a live row stops the migration with an explicit error — nothing is dropped', async () => {
        const tables = Object.fromEntries(LEGACY_ORCHESTRATION_TABLES.map(({ table }) => [table, { total: 0, live: 0 }]));
        tables.generation_tasks = { total: 2, live: 1 };        // queued / running
        tables.iu_image_pointers = { total: 1, live: 1 };       // a published versioned image
        const { q, sql } = fakePg(tables);
        let err;
        try { await dropLegacyOrchestrationTables(q); } catch (e) { err = e; }
        expect(err).to.be.instanceOf(LegacyTablesNotEmptyError);
        expect(err.code).to.equal('legacy_tables_not_empty');
        expect(err.message).to.include('generation_tasks=1 live row(s) of 2');
        expect(err.message).to.include('iu_image_pointers=1 live row(s) of 1');
        expect(sql.some((s) => s.startsWith('DROP'))).to.equal(false);
    });

    it('idempotent: missing tables are skipped (second start is a no-op)', async () => {
        const { q, sql } = fakePg({});
        const r = await dropLegacyOrchestrationTables(q);
        expect(r.dropped).to.deep.equal([]);
        expect(sql.filter((s) => s.startsWith('DROP TABLE'))).to.deep.equal([]);
    });

    it('the live predicates are the documented ones', () => {
        const live = Object.fromEntries(LEGACY_ORCHESTRATION_TABLES.map(({ table, live: l }) => [table, l]));
        expect(live.generation_tasks).to.equal("status IN ('queued','running')");
        expect(live.asset_states).to.equal("status IN ('queued','generating')");
        expect(live.output_manifests).to.equal("status = 'building'");
        expect(live.iu_image_fence_reservations).to.equal('TRUE');
        expect(live.iu_image_pointers).to.equal('TRUE');
        for (const t of ['generation_cancellations', 'reconciliation_events', 'cache_entries', 'asset_dependencies']) expect(live[t]).to.equal(null);
    });
});
