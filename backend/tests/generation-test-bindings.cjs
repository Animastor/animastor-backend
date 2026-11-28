// ======================================================
// GENERATION PORTS — host-side test bindings (S-6)
// ======================================================
// Mirrors the production composition root (backend.cjs): binds the three
// Generation host ports (GenerationConfig, ProfileStore, BookData — the
// DispatchTransport adapter, runtime/gpu-dispatcher, is gone since 2026-11-28) so that plain requires of generation modules — which is what
// most backend tests do — behave exactly like the wired production process.
// Loaded for EVERY mocha run via .mocharc.json `require` (runs before any
// test module), so lazy registry self-bootstrap and call-time port
// resolution always find a wired port.
//
// Behavior compatibility:
//   - GenerationConfig binds the canonical runtime-config slices verbatim
//     (config/generation-config-adapter) — the S2-G drift guard still
//     compares registry values against runtime-config directly;
//   - ProfileStore binds services/ai-loader.getAssemblyProfile (real file
//     loading, same cache semantics);
//   - BookData binds the book facade's collectSceneUnits + appearance
//     tokensToString (pure vbook-runtime functions).
//
// Any test that resets a port (e.g. _resetDispatchTransport for fail-fast
// coverage) must re-wire it — same discipline as clearOrchestrationSeams.
//
// Dual-location note (vbook-test-bindings pattern): the canonical host-owned
// wiring stays in backend.cjs; this fixture only mirrors it for tests.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28

'use strict';

require('../src/config/generation-config-adapter').bindGenerationConfig();
require('@animastor/generation').ports.profileStore.setProfileStore({
    getAssemblyProfile: require('../src/services/ai-loader').getAssemblyProfile,
});
require('@animastor/generation').ports.bookData.setBookData({
    collectSceneUnits: require('../src/book').collectSceneUnits,
    tokensToString: require('../src/book/lazy-book/appearance').tokensToString,
    resolveHeroLook: require('@animastor/vbook-runtime/looks.cjs').resolveHeroLook,
    passportHeroes: require('@animastor/vbook-runtime/heroes.cjs').passportHeroes,
});
// (2026-11-28, ORCHESTRATION_V2 этап 4: the O-2..O-10 orchestration ports and
// the host bindings of the legacy package are gone with src/legacy — the
// composition root binds none of them any more.)

// Dual-wiring for the GenerationConfig port: the adapter above wired the
// npm copy; wire the monorepo copy so registry self-bootstrap inside the
// monorepo sources (read directly by the S2 suite) finds a wired port.
try {
    const runtimeConfig = require('../src/config/runtime-config');
    require('../../packages/animastor-generation/src/ports/generation-config').setGenerationConfig({
        leaseTtlS: runtimeConfig.LEASE_TTL_S,
        quotas: runtimeConfig.QUOTAS,
        stuckThresholds: runtimeConfig.STUCK_THRESHOLDS,
    });
} catch (_) { /* post-split: monorepo checkout not present */ }
