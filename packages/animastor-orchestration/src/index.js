// ======================================================
// @animastor/orchestration 2.0.0 — package root
// ======================================================
// 2.0.0 = orchestration v2 only (ADR animastor-docs architecture/ORCHESTRATION_V2.md,
// §12 этап 4). The 0.3.x legacy orchestration that lived in src/legacy/
// (dispatch / reconcile / lease / FSM, O-2..O-10 ports, host bindings,
// runtime namespace, orchestrator facade) is removed — a breaking change of
// the public API, hence the major version.
//
//   • `gen` — the v2 core (src/gen/): PG-only, no Redis / Express / ComfyUI.
//     Lazy: requiring the package does not load it.

'use strict';

const api = {};
Object.defineProperty(api, 'gen', {
    enumerable: true,
    get() { return require('./gen'); },
});

module.exports = api;
