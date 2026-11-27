// ======================================================
// HOST ADAPTER: LayerConfigAdapter — O-10 LayerConfigPort impl
// ======================================================
// Host-side implementation of the O-10 LayerConfigPort
// (runtime/layer-config-port.js). Owns the only layer-config service
// channel the runtime/orchestration tiers may use: the per-book PG read
// (book_layer_config) + normalize/clamp pipeline (services/layer-config get).
//
//   runtime/layer-config-port         (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/layer-config-adapter      ← THIS FILE (host impl)
//       → services/layer-config.get
//
// Lazy call-time resolver — never captures the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2..O-9 adapter discipline): a harness that stubs
// ../src/services/layer-config and then (re)requires a tier consumer
// gets the stub through this adapter (the worklist-rebuild purge-list
// convention pins services/layer-config.js as a purged module — the
// purge empties require.cache so the next call-time resolution reloads
// the real service, identical to the pre-O-10 lazy requires).
//
// Behavior contract: get is a 1:1 delegation to services/layer-config.get
// (normalized config shape, error semantics); since 2026-11-27 the service
// reads PG book_layer_config and the redis argument is dropped here.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.27 (O-10)
// ======================================================

// Lazy call-time resolver — the host service channel every pre-O-10
// harness stubs (`require.resolve('../src/services/layer-config')`).
const layerConfigService = () => require('../services/layer-config');

// The port keeps its (redis, bookId) call shape; redis is ignored (PG only).
function get(redis, bookId) {
    return layerConfigService().get(bookId);
}

// COMPAT (2026-11-27, layer-config → PG): services/layer-config.restoreFromBooks
// is gone (no Redis copy to heal). @animastor/orchestration <= 1.4.3 still
// lists 'restoreFromBooks' in the port OPS (setLayerConfigPort rejects an
// adapter without it) and calls it from reconcile PHASE C6, so the adapter
// answers "nothing restored". 1.4.4 drops both the op and the C6 call —
// delete this stub with the bump of backend/package.json to ^1.4.4.
function restoreFromBooks() {
    return Promise.resolve(0);
}

module.exports = {
    get,
    restoreFromBooks,
};
