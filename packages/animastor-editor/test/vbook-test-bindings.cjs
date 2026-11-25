// ======================================================
// VBOOK TEST BINDINGS — dual-location helper (worker/player/editor pattern)
// ======================================================
// This is the package-side copy of the shared host fixture. It binds the
// VBook runtime ports exactly like the production composition root
// (backend.cjs) so that plain requires of the VBook package behave like the
// wired production process.
//
// The canonical host-owned source of this fixture is
// backend/tests/vbook-test-bindings.cjs — see that file for the full header
// (booksRoot bound as a LIVE provider over config.BOOKS_DIR; the real
// services/structure-detector bound so splitIntoChapters produces the same
// maps as before the port). The package copy requires the host source
// through the repo-relative path so a change to the fixture cannot fork:
// the backend repo root is three levels up from this package directory
// (repo checkout layout — the package tests are host-run inside the
// backend workspace, same as the @animastor/player precedent).
//
// Requires the backend node_modules resolution for config/@animastor/* —
// the suite is executed from the backend workspace (cd backend && npx mocha
// ../packages/animastor-editor/test) or via the backend test suite include.

'use strict';

require('../../../backend/tests/vbook-test-bindings.cjs');

// The package may carry its own installed copy of the VBook runtime / parser
// (per-package `npm ci`). That copy is a SEPARATE module instance from the
// host copies wired above, so its ports must be bound too — otherwise the
// harness' plain requires hit "booksRoot is not configured". The try-block
// is a no-op for host-run layouts whose installed copy predates the subpath
// exports (the bare require then falls back to backend/node_modules).
try {
    const config = require('../../../backend/src/config/runtime-config');
    require('@animastor/vbook-runtime/books-root').configureBooksRoot(() => config.BOOKS_DIR);
} catch (_) { /* no package-local runtime copy / no subpath export */ }
try {
    const { setStructureDetector } = require('@animastor/parser');
    setStructureDetector(require('../../../backend/src/services/structure-detector'));
} catch (_) { /* no package-local parser copy */ }
