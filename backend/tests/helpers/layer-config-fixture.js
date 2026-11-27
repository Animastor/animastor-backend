// ======================================================
// Test fixture: per-book layer config in PG (book_layer_config)
// ======================================================
// Since 2026-11-27 layer-config lives only in PG (services/layer-config →
// storage/postgres/repositories/layer-config-repo). Legacy-runtime tests that
// used to seed the Redis key now seed the PG row through the real service.
// The table references books(book_id), so the fixture registers the book
// (books row) when it does not exist and removes exactly what it created.
// A registered book is orchestration='legacy' (the legacy suites need the
// legacy runtime to own it; the column default is 'v2' since 006).

'use strict';

const { query } = require('../../src/storage/postgres/database');
const { runMigrations } = require('../../src/storage/postgres/schema');

const created = new Set();   // books rows registered by the fixture
const touched = new Set();   // books whose config the fixture wrote
let migrated = false;

async function ensureSchema() {
    if (migrated) return;
    await runMigrations();
    migrated = true;
}

/**
 * Store a layer config for a test book (partial merged over the defaults by
 * services/layer-config.set). Registers the books row when missing.
 */
async function setLayers(bookId, cfg, { orchestration = 'legacy' } = {}) {
    await ensureSchema();
    const col = await query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'books' AND column_name = 'orchestration'`);
    const ins = col.rows.length
        ? await query(
            `INSERT INTO books (book_id, title, orchestration) VALUES ($1, 'layer-config fixture', $2)
             ON CONFLICT (book_id) DO NOTHING RETURNING book_id`, [bookId, orchestration])
        : await query(
            `INSERT INTO books (book_id, title) VALUES ($1, 'layer-config fixture')
             ON CONFLICT (book_id) DO NOTHING RETURNING book_id`, [bookId]);
    if (ins.rows.length) created.add(bookId);
    touched.add(bookId);
    return require('../../src/services/layer-config').set(bookId, cfg);
}

/** Drop the stored config of a book (the books row stays). */
async function clearLayers(bookId) {
    await ensureSchema();
    await query('DELETE FROM book_layer_config WHERE book_id = $1', [bookId]);
}

/** Remove everything the fixture created (books rows cascade their config). */
async function cleanupLayers() {
    for (const bookId of touched) {
        try { await query('DELETE FROM book_layer_config WHERE book_id = $1', [bookId]); } catch (_) { /* best-effort */ }
    }
    for (const bookId of created) {
        try { await query('DELETE FROM books WHERE book_id = $1', [bookId]); } catch (_) { /* best-effort */ }
    }
    touched.clear();
    created.clear();
}

module.exports = { setLayers, clearLayers, cleanupLayers, ensureSchema };
