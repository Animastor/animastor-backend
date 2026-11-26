// ======================================================
// gen/sql/006-default-v2 — v2 is the default orchestration (owner decision 26.11)
// ======================================================
// Owner decision (2026-11-26): every book is v2, legacy is not needed. This
// migration closes the reading half of that decision:
//
//   books.orchestration  DEFAULT 'v2'   (001 created the column with 'legacy')
//   UPDATE books         'legacy' → 'v2'
//
// No code writes the column explicitly — every consumer (book-repo
// getBookOrchestration, orchestration-v2/book-flag) reads it, so a new book
// takes the default and an existing one is flipped here. 001 is untouched: on
// a fresh database the column is still created with 'legacy' and immediately
// re-defaulted by this step, which keeps both histories byte-identical.
//
// Idempotent: ALTER … SET DEFAULT is unconditional and the UPDATE matches
// nothing on a second run, so the migration runner can apply it on every
// start. Nothing here touches the legacy code, the legacy tables or any
// route — decommissioning is a later stage (ADR §12 stage 4).

'use strict';

const GEN_DEFAULT_V2_SQL = Object.freeze([
    `ALTER TABLE books ALTER COLUMN orchestration SET DEFAULT 'v2'`,
    `UPDATE books SET orchestration = 'v2' WHERE orchestration = 'legacy'`,
]);

module.exports = { GEN_DEFAULT_V2_SQL };
