// ======================================================
// O-10 PORT: LayerConfigPort — runtime/orchestration
// per-book layer-config contract
// ======================================================
// The runtime and orchestration tiers must not know the layer-config host
// service. Storage (host PG table book_layer_config since 1.4.4, formerly a
// Redis key + book.json copy), the normalize/clamp pipeline and the
// book.json durable copy stay HOST-side (backend/src/services/layer-config.js);
// the tiers consume per-book layer config ONLY through this port, wired by
// the composition root (backend.cjs) at startup.
//
//   runtime/** + orchestration/**        (tier consumers)
//       ↓ consume layer-config ops through
//   runtime/layer-config-port.js         ← THIS PORT (tier-owned contract)
//       ↑ wired by the host
//   storage/layer-config-adapter         (host service adapter)
//
// This is the O-2..O-9 port convention (runtime/persistence-port.js,
// runtime/scene-data-port.js, runtime/placeholder-audio-port.js,
// runtime/progress-events-port.js, runtime/audio-fsm-port.js,
// runtime/video-fsm-port.js, runtime/hub-cancel-port.js): a zero-require
// contract module, a fail-fast call-time resolver, one set/wired/reset
// surface. The contract is EXACTLY one operation:
//
//   get(redis, bookId) — the normalized per-book layer config (redis is
//                        passed for call-shape compatibility; the host
//                        ignores it). Consumers: scene-orchestrator
//                        executeVideoDispatch per-type timeout leg;
//                        reconciliation-engine rebuildWorkList enabled
//                        layers and video-stall threshold; command-gate
//                        getLayerConfig (runtime-scheduler re-export);
//                        scene-window isWindowComplete / isSceneWindowDone /
//                        startScene.
//
// 1.4.4 (layer-config → PG): `restoreFromBooks` (reconcile PHASE C6, heal
// missing Redis keys from book.json) is removed together with the phase —
// there is no Redis copy any more; the former tier-local RAW Redis reads of
// the layer-config key now go through get().
//
// Deliberately NOT in the port: set/persistToBook (routes/import
// workflow), getChunkSize (routes + services/agent consumers),
// SCOPES/ANALYSIS_MODES/DEFAULTS vocabulary (routes/services constants),
// normalize (host-internal), and any CRUD "for later".

// Error semantics are the CALLER's concern: the scene-orchestrator timeout
// leg and the reconcile video-stall threshold keep their `try { … } catch
// (_) {}` tolerance; rebuildWorkList, command-gate and scene-window reads are
// plain mandatory awaits (a failing store fails the caller, as a failing
// Redis read did before 1.4.4).
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.27 (O-10)
// ======================================================

const OPS = [
    'get',
];

let impl = null;

/**
 * Wire the host layer-config adapter. Called once by the composition root
 * (backend.cjs) BEFORE any runtime/orchestration layer-config consumer
 * runs. The adapter must expose every op in OPS as a function; lazy
 * resolution of the host implementation happens at CALL time (the
 * O-2..O-9 adapter discipline), so wiring never forces a
 * services/layer-config load.
 * @param {object} adapter — flat map with every op in OPS as a function.
 */
function setLayerConfigPort(adapter) {
    if (!adapter) {
        throw new Error('layer-config-port: adapter is required');
    }
    for (const op of OPS) {
        if (typeof adapter[op] !== 'function') {
            throw new Error(`layer-config-port: adapter must implement ${op}()`);
        }
    }
    impl = adapter;
}

/** Resolve the port at CALL time — fail-fast when unwired. */
function layerConfig() {
    if (!impl) {
        throw new Error(
            'layer-config-port: not wired — the composition root must call ' +
            'setLayerConfigPort(adapter) (storage/layer-config-adapter) ' +
            'before runtime/orchestration layer-config consumers run (O-10)'
        );
    }
    return impl;
}

/**
 * Shorthand op resolver: `layerConfigOp('get')(...)`.
 * Fails fast when the port or the single op is missing — callers that
 * tolerate failure keep their own try/catch around the call (the
 * caller-owned optional-load discipline of O-7/O-9).
 * @param {string} op — op name from OPS
 */
function layerConfigOp(op) {
    const fn = impl?.[op];
    if (typeof fn !== 'function') {
        throw new Error(`layer-config-port: op '${op}' is not wired (O-10)`);
    }
    return fn;
}

function isLayerConfigPortWired() {
    return impl !== null;
}

/** Test hygiene: drop the wiring (mocha hooks). */
function _resetLayerConfigPort() {
    impl = null;
}

module.exports = {
    OPS,
    setLayerConfigPort,
    layerConfig,
    layerConfigOp,
    isLayerConfigPortWired,
    _resetLayerConfigPort,
};
