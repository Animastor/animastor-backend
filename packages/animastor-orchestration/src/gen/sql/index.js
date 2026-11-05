// ======================================================
// gen/sql — migration runner (idempotent, one transaction)
// ======================================================
'use strict';

const { GEN_CORE_SQL } = require('./001-gen-core');
const { withTx } = require('../util');

const MIGRATIONS = Object.freeze([
    Object.freeze({ id: '001-gen-core', statements: GEN_CORE_SQL }),
]);

/**
 * Apply all v2 migrations. Requires the host tables books, workers and
 * scene_assets to exist (backend schema.js runs first). Serialised across
 * processes by a transaction-scoped advisory lock; every statement is
 * idempotent, so running it on each start is safe.
 * @param {{connect: Function}} pool  pg Pool (or compatible)
 * @returns {Promise<{applied: string[]}>}
 */
async function migrate(pool) {
    return withTx(pool, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('animastor:gen-v2:migrate'))`);
        for (const m of MIGRATIONS) {
            for (const sql of m.statements) await client.query(sql);
        }
        return { applied: MIGRATIONS.map((m) => m.id) };
    });
}

module.exports = { migrate, MIGRATIONS };
