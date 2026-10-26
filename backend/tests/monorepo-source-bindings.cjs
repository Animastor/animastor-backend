// ============================================================
// Monorepo source resolution for backend tests (clean-clone safe)
// ============================================================
//
// Stage 143a fix 3: tests exercise the CANONICAL monorepo sources
// (`../../packages/**`) instead of the published copies in
// backend/node_modules, so a clean clone runs the CURRENT code without
// anyone hand-syncing node_modules (on a clean install node_modules only
// ever carries the older published release).
//
// Those package files carry bare requires (@animastor/generation,
// @animastor/vbook-runtime, music-metadata, …) which normally resolve
// through the package's OWN node_modules — a directory that exists only
// after a per-package `npm ci`, which a clean clone (backend `npm ci` only)
// never runs. This binding makes a bare specifier that failed to resolve
// fall back to backend/node_modules, where npm ci did install them.
//
// The fallback runs ONLY after normal resolution has already failed:
//   • dev machines with per-package installs behave exactly as before;
//   • a genuinely missing module still throws its original
//     MODULE_NOT_FOUND with the original requireStack;
//   • backend files resolve their own requires as before (backend is their
//     ancestor, so the normal path always wins there).

'use strict';

const path = require('path');
const Module = require('module');

const BACKEND_NODE_MODULES = path.resolve(__dirname, '..', 'node_modules');
const origResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
    try {
        return origResolveFilename.call(this, request, parent, isMain, options);
    } catch (err) {
        const bare = typeof request === 'string' && request.length > 0
            && request.charAt(0) !== '.' && !path.isAbsolute(request)
            && !request.startsWith('node:');
        if (!bare || !err || err.code !== 'MODULE_NOT_FOUND') throw err;
        // Retry the SAME bare specifier as if it were requested from
        // backend/ itself: lookup = backend/node_modules, with the target
        // package's own exports map applied (a plain path.join would miss
        // `./book-model.cjs` → `./src/book-model.cjs` style subpaths).
        try {
            const fakeParent = new Module(path.join(__dirname, 'monorepo-source-bindings.cjs'));
            fakeParent.paths = [BACKEND_NODE_MODULES];
            return origResolveFilename.call(this, request, fakeParent, isMain, options);
        } catch (_) {
            throw err; // the original, actionable error (with its requireStack)
        }
    }
};
