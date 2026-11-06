// ======================================================
// @animastor/orchestration 1.0.0 — package root
// ======================================================
// 1.0.0 = orchestration v2 (ADR animastor-docs architecture/ORCHESTRATION_V2.md).
//
//   • Every export of 0.3.x is unchanged: the old orchestration lives verbatim
//     in src/legacy/ during the migration (removed at ADR stage 4). Its root
//     uses lazy getters (FSM writers resolve host bindings on access), so the
//     property DESCRIPTORS are copied, never the values — nothing fires at
//     require time, exactly as before.
//   • `gen` — the new v2 core (src/gen/): PG-only, no legacy / Redis /
//     Express / ComfyUI. Lazy too: requiring the package does not load it.

'use strict';

const legacy = require('./legacy');

const api = Object.defineProperties({}, Object.getOwnPropertyDescriptors(legacy));
Object.defineProperty(api, 'gen', {
    enumerable: true,
    get() { return require('./gen'); },
});

module.exports = api;
