// ======================================================
// §32.30 POST-MOVE BOUNDARY GUARDS — packages/animastor-orchestration
// ======================================================
// The §32.29/§32.30 suite froze the boundary of the legacy orchestration
// contour after its physical move into the package (PM-G1..PM-G10). Since
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7) that contour is DELETED:
// the package is the v2 core only (`gen`). The guards keep the same numbers
// and protect the boundary that remains:
//
//   PM-G1  backend/src/orchestration is gone
//   PM-G2  no legacy runtime file lives anywhere (host or package);
//          backend/src/runtime keeps exactly the classified host stays
//   PM-G3  the package root API is frozen: exactly `gen`; exports root-only
//   PM-G4  no deep imports of @animastor/orchestration from backend/src
//   PM-G5  no backend-relative requires inside the package
//   PM-G6  no forbidden dependencies from the package (host modules,
//          pg / ioredis / express)
//   PM-G7  the host stays remain host-side (worker-health / worker-lanes /
//          job-schema)
//   PM-G8  no reverse dependency (package → backend/src, self-import)
//   PM-G9  the composition root consumes the package only through
//          orchestration-v2 (`.gen`) — no port / binding / seam wiring
//   PM-G10 the package closure: every require of every package file
//          resolves in-package or to a node builtin
//
// Docs: animastor-docs architecture/ORCHESTRATION_V2.md §12 этап 4

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const {
    BACKEND_SRC,
    ORCH_PKG_DIR,
    ORCH_PKG_SRC,
    ORCH_PKG_LEGACY_DIR,
    listSourceFiles,
    readSource,
    requireSpecifiers,
    resolveSpecifier,
    rel,
} = require('./helpers');

const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');

/** source without comments (usage examples in doc comments are not requires) */
function codeOf(file) {
    return readSource(file).replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
        .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}
const ORCH_HOST_DIR = path.join(BACKEND_SRC, 'orchestration');

// The former moved set (§32.30): none of these may exist anywhere any more.
const LEGACY_RUNTIME = [
    'active-scenes-index.js', 'audio-fsm-port.js', 'circuit-breaker.js',
    'counter-reconciliation.js', 'dispatch-engine.js', 'failure-taxonomy.js',
    'hub-cancel-port.js', 'layer-config-port.js', 'lease-manager.js',
    'persistence-port.js', 'placeholder-audio-port.js',
    'progress-events-port.js', 'reconciliation-engine.js',
    'retry-budget-manager.js', 'runtime-metrics.js',
    'runtime-result-emitter.js', 'runtime-scheduler.js',
    'scene-data-port.js', 'scene-window.js', 'video-fsm-port.js',
];

// The classified host stays of backend/src/runtime after этап 4.
const ALIVE_HOST_STAYS = {
    'job-schema.js': 'contracts facade (Phase 9C choke point) — video-service job ids',
    'worker-health.js': 'GET /worker/counts liveness ∧ scope (moved back from the package, шаг 4)',
    'worker-lanes.js': 'v2 lane lookups (private worker / users-policy) — out of gpu-dispatcher, шаг 7',
};

describe('§32.30 post-move boundary guards — packages/animastor-orchestration', () => {
    it('PM-G1: backend/src/orchestration is gone (the package is the single home)', () => {
        expect(fs.existsSync(ORCH_HOST_DIR), 'backend/src/orchestration must not exist').to.equal(false);
    });

    it('PM-G2: no legacy runtime file anywhere; backend/src/runtime keeps exactly the classified host stays', () => {
        expect(ORCH_PKG_DIR, 'packages/animastor-orchestration must exist').to.not.equal(null);
        expect(fs.existsSync(ORCH_PKG_LEGACY_DIR), 'the package legacy tree (src/legacy) must be gone').to.equal(false);
        for (const name of LEGACY_RUNTIME) {
            expect(fs.existsSync(path.join(RUNTIME_DIR, name)), `backend/src/runtime/${name} must not exist`).to.equal(false);
        }
        const remaining = listSourceFiles(RUNTIME_DIR).map((f) => path.basename(f)).sort();
        expect(remaining, 'backend/src/runtime keeps exactly the classified host stays').to.deep.equal(Object.keys(ALIVE_HOST_STAYS).sort());
    });

    it('PM-G3: the package root API is frozen to `gen`; exports root-only; 2.0.0', () => {
        const pkg = require(path.join(ORCH_PKG_SRC, 'index.js'));
        expect(Object.keys(pkg)).to.deep.equal(['gen']);
        for (const gone of ['ports', 'runtime', 'bindHostModules', 'createRuntimeResultConsumer', 'dispatchStage', 'orchestrator']) {
            expect(pkg[gone], `root export '${gone}' must be gone`).to.equal(undefined);
        }
        const pkgJson = JSON.parse(fs.readFileSync(path.join(ORCH_PKG_DIR, 'package.json'), 'utf8'));
        expect(pkgJson.name).to.equal('@animastor/orchestration');
        expect(pkgJson.version).to.equal('2.0.0');
        expect(Object.keys(pkgJson.exports || {}), 'exports must be root-only (deep-import blocking)').to.deep.equal(['.']);
        expect(pkgJson.dependencies || {}, 'the v2 core has no runtime dependencies').to.deep.equal({});
    });

    it('PM-G4: backend/src never deep-imports the package (root specifier only)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('@animastor/orchestration/')) offenders.push(`${rel(file)} -> ${spec}`);
            }
        }
        expect(offenders, 'deep package imports from host source are forbidden').to.deep.equal([]);
    });

    it('PM-G5: no backend-relative requires inside the package', () => {
        const offenders = [];
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('backend/src') || spec.startsWith('../../backend')) offenders.push(`${rel(file)} -> ${spec}`);
            }
        }
        expect(offenders, 'the package must never require backend/src').to.deep.equal([]);
    });

    it('PM-G6: no forbidden dependencies from the package (host modules, pg / ioredis / express)', () => {
        const offenders = [];
        const FORBIDDEN_HOST_SPEC = /(^|[\\/])(storage|book|routes|services|config|state|media|helpers|middleware)([\\/]|['"])/;
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (FORBIDDEN_HOST_SPEC.test(spec)) offenders.push(`${rel(file)} -> ${spec}`);
                if (spec === 'pg' || spec.startsWith('pg/') || spec === 'ioredis' || spec === 'express') offenders.push(`${rel(file)} -> ${spec}`);
            }
        }
        expect(offenders, 'forbidden dependency from the orchestration package').to.deep.equal([]);
    });

    it('PM-G7: the host stays remain host-side', () => {
        for (const name of Object.keys(ALIVE_HOST_STAYS)) {
            expect(fs.existsSync(path.join(RUNTIME_DIR, name)), `${name} must stay host-side`).to.equal(true);
        }
        // the lane lookups keep their PG routing repos (formerly the §32.19 pin of gpu-dispatcher)
        const lanes = readSource(path.join(RUNTIME_DIR, 'worker-lanes.js'));
        expect(lanes).to.include("require('../storage/postgres/repositories/book-repo')");
        expect(lanes).to.include("require('../storage/postgres/repositories/worker-repo')");
        // orchestration v2 receives the lane lookups injected, never by path
        const v2 = readSource(path.join(BACKEND_SRC, 'orchestration-v2', 'index.js'));
        expect(requireSpecifiers(v2).filter((s) => s.includes('worker-lanes'))).to.deep.equal([]);
    });

    it('PM-G8: no reverse dependency (package → backend/src, self-import)', () => {
        const offenders = [];
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            for (const spec of requireSpecifiers(codeOf(file))) {
                if (spec.startsWith('@animastor/orchestration')) offenders.push(`${rel(file)} self-imports ${spec}`);
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(BACKEND_SRC)) offenders.push(`${rel(file)} -> ${rel(target)}`);
            }
        }
        expect(offenders, 'reverse dependency from the package').to.deep.equal([]);
    });

    it('PM-G9: the composition root consumes the package only through orchestration-v2 (`.gen`)', () => {
        const root = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(requireSpecifiers(root).filter((s) => s === '@animastor/orchestration'), 'backend.cjs must not require the package').to.deep.equal([]);
        for (const gone of ['setPersistencePort(', 'bindHostModules(', 'registerOrchestrationSeams(', 'createRuntimeResultConsumer(', 'runtime.loop']) {
            expect(root, `backend.cjs must not wire ${gone}`).to.not.include(gone);
        }
        const consumers = listSourceFiles(BACKEND_SRC)
            .filter((f) => requireSpecifiers(readSource(f)).includes('@animastor/orchestration'))
            .map(rel).sort();
        expect(consumers).to.deep.equal([
            'backend/src/audio/voice-references.js',      // gen.media.inspectWav
            'backend/src/orchestration-v2/index.js',
            'backend/src/orchestration-v2/routes.js',
        ]);
    });

    it('PM-G10: the package closure — every require resolves in-package or to a node builtin', () => {
        const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
        const offenders = [];
        for (const file of listSourceFiles(ORCH_PKG_SRC)) {
            const src = codeOf(file);
            for (const spec of requireSpecifiers(src)) {
                if (builtins.has(spec)) continue;
                if (!spec.startsWith('.')) { offenders.push(`${rel(file)} -> ${spec} (external)`); continue; }
                const target = resolveSpecifier(file, spec);
                if (!target || !target.startsWith(ORCH_PKG_SRC)) offenders.push(`${rel(file)} -> ${spec}`);
            }
            if (/require\.cache/.test(src)) offenders.push(`${rel(file)}: require.cache`);
        }
        expect(offenders, 'package closure').to.deep.equal([]);
    });
});
