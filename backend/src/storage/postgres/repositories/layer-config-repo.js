// ======================================================
// Book Layer Config Repository
// ======================================================
// Table: book_layer_config (book_id PK → books ON DELETE CASCADE,
// config jsonb NOT NULL, updated_at timestamptz). The only store of
// services/layer-config since 2026-11-27 (ORCHESTRATION_V2 §11.1) — the
// service owns the config shape (normalize/merge), this module owns SQL.
//
// A missing books row surfaces as PG error 23503 (foreign_key_violation);
// the service maps it.

const { query, withTransaction } = require('../database');

const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Stored config object of the book, or null when there is no row.
 * @param {string} bookId
 * @returns {Promise<object|null>}
 */
async function getConfig(bookId) {
    const { rows } = await query('SELECT config FROM book_layer_config WHERE book_id = $1', [bookId]);
    return rows.length ? rows[0].config : null;
}

/**
 * Insert a row only when the book has none (lazy seed from book.json).
 * Returns the config now stored: the inserted one, or the row a concurrent
 * writer created first.
 * @param {string} bookId
 * @param {object} config
 * @returns {Promise<object|null>}
 */
async function insertIfMissing(bookId, config) {
    const ins = await query(
        `INSERT INTO book_layer_config (book_id, config) VALUES ($1, $2::jsonb)
         ON CONFLICT (book_id) DO NOTHING RETURNING config`,
        [bookId, JSON.stringify(config)]
    );
    if (ins.rows.length) return ins.rows[0].config;
    return getConfig(bookId);
}

/**
 * Read-modify-write of one book's row in ONE transaction, serialized per book
 * by a transaction-scoped advisory lock (also covers the "no row yet" case,
 * where FOR UPDATE would lock nothing). `compute(current)` gets the stored
 * config (or null) and returns the config to store. `afterWrite(next)` runs
 * after the upsert, still under the lock, so a side effect there (the
 * book.json copy) happens only for a successful write and in the same order
 * as the PG writes.
 * @param {string} bookId
 * @param {(current: object|null) => object} compute
 * @param {(next: object) => void} [afterWrite]
 * @returns {Promise<object>} the stored config
 */
async function update(bookId, compute, afterWrite) {
    return withTransaction(async (client) => {
        await client.query(
            `SELECT pg_advisory_xact_lock(hashtext('book_layer_config'), hashtext($1))`, [bookId]);
        const { rows } = await client.query(
            'SELECT config FROM book_layer_config WHERE book_id = $1', [bookId]);
        const next = compute(rows.length ? rows[0].config : null);
        await client.query(
            `INSERT INTO book_layer_config (book_id, config, updated_at) VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (book_id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
            [bookId, JSON.stringify(next)]
        );
        if (afterWrite) afterWrite(next);
        return next;
    });
}

module.exports = { FOREIGN_KEY_VIOLATION, getConfig, insertIfMissing, update };
