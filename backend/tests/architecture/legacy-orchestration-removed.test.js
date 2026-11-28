// ======================================================
// Legacy orchestration is gone (ORCHESTRATION_V2 §12 этап 4, шаги 4 и 7)
// ======================================================
// Static scan of backend/src and packages/*/src (code only — comments are
// stripped, the history in comments stays readable):
//   1. the host never reaches the legacy package: every
//      require('@animastor/orchestration') is followed by `.gen`; nothing
//      requires …/orchestration/src/legacy;
//   2. there is no legacy/v2 split any more: no isV2Book /
//      isV2BookFailClosed / orchestration-v2/book-flag.
//
//   3. the deleted host modules are gone and nothing requires them;
//   4. no code names a Redis key family that scripts/purge-legacy-redis.cjs
//      deletes — except the shared modules this task keeps untouched
//      (SHARED_KEEP, each with its reason);
//   5. no code names a dropped PG table — except the drop migration itself
//      (storage/postgres/schema.js).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');
const PACKAGES = path.resolve(BACKEND, '..', 'packages');

const PENDING_REMOVAL = new Set([]);   // emptied by шаг 7 (the deletion commit)

/** host modules deleted by шаг 7 (paths under backend/src) */
const REMOVED_MODULES = [
    'storage/runtime-persistence-adapter.js', 'storage/scene-data-adapter.js',
    'storage/placeholder-audio-adapter.js', 'storage/progress-events-adapter.js',
    'storage/audio-fsm-adapter.js', 'storage/video-fsm-adapter.js',
    'storage/hub-cancel-adapter.js', 'storage/layer-config-adapter.js', 'storage/asset-registry.js',
    'services/task-handler.cjs', 'services/audio-orchestrator.js', 'services/video-orchestrator.js',
    'services/gpu-retry-policy.cjs', 'services/audio-recovery.cjs', 'services/stage-cancellation.cjs',
    'services/cancel-scene-state.cjs', 'services/generation-progress.js', 'services/gpu-error-classifier.cjs',
    'services/publication-lock.cjs', 'services/result-publication.cjs', 'services/scene-asset-registry.js',
    'runtime/runtime-loop.js', 'runtime/gpu-dispatcher.js', 'runtime/orchestration-seams.js',
    'helpers/queue-idempotency.cjs', 'helpers/redis-helpers.cjs',
    'state', 'image/iu-processor.js', 'startup-resume.js', 'orchestration-v2/book-flag.js',
    'contracts/runtime-result.js',
    'storage/postgres/repositories/task-repo.js', 'storage/postgres/repositories/generation-cancel-repo.js',
    'storage/postgres/repositories/iu-image-pointer-repo.js',
];

/**
 * Shared modules that still name a purged family in dead code paths: the task
 * keeps them untouched (ORCHESTRATION_V2 этап 4 — «общее с v2 не трогать»);
 * no live caller reaches those paths.
 */
const SHARED_KEEP = Object.freeze({
    'backend/src/config/runtime-config.js': 'REDIS / TIMEOUTS constants (data, not used by a live path)',
    'backend/src/services/gen-scope.js': 'shared with v2 (scopeBounds); its Redis scope helpers have no live caller',
    'backend/src/audio/pipeline.js': 'shared with v2; mergeSceneAudioChunks (audio-merge-lock) has no live caller',
    'backend/src/video/video-service.js': 'video/* shared with v2; the scene-video registry has no live caller',
    'backend/src/video/video-merge.js': 'video/* shared with v2; the scene merge lock path has no live caller',
    'backend/src/services/cleanup-service.cjs': 'cleanup lock of the build-file cleanup service (live) — kept family',
    'backend/src/routes/worker-routes.cjs': 'hub policy-lane drain (queue:*:policy:*) — hub transport, --include-hub-v2 only',
});

const DROPPED_TABLES = ['generation_tasks', 'asset_states', 'generation_cancellations', 'reconciliation_events',
    'cache_entries', 'asset_dependencies', 'output_manifests', 'iu_image_fence_reservations', 'iu_image_pointers'];


function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(c?js)$/.test(e.name)) out.push(p);
    }
    return out;
}

/** source without comments (line comments and block comments; strings kept) */
function codeOnly(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
        .join('\n');
}

function scannedFiles() {
    const files = walk(SRC);
    for (const dir of fs.readdirSync(PACKAGES)) {
        const src = path.join(PACKAGES, dir, 'src');
        // the orchestration package's own legacy tree is not a consumer
        files.push(...walk(src).filter((f) => !f.includes(`${path.sep}animastor-orchestration${path.sep}src${path.sep}legacy${path.sep}`)));
    }
    return files.map((abs) => ({ abs, rel: path.relative(path.resolve(BACKEND, '..'), abs).split(path.sep).join('/') }))
        .filter(({ rel }) => !PENDING_REMOVAL.has(rel));
}

const CODE_CACHE = new Map();
function codeText(abs) {
    if (!CODE_CACHE.has(abs)) CODE_CACHE.set(abs, codeOnly(fs.readFileSync(abs, 'utf8')));
    return CODE_CACHE.get(abs);
}

function offenders(re) {
    const hits = [];
    for (const { abs, rel } of scannedFiles()) {
        const lines = codeText(abs).split('\n');
        lines.forEach((line, i) => { if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`); });
    }
    return hits;
}

describe('legacy orchestration removed (ORCHESTRATION_V2 этап 4)', function () {
    this.timeout(30000);
    it('scans the host and every package', () => {
        const rels = scannedFiles().map((f) => f.rel);
        expect(rels.length).to.be.greaterThan(100);
        expect(rels).to.include('backend/src/orchestration-v2/index.js');
        expect(rels).to.include('backend/src/runtime/worker-health.js');
    });

    it('no require of the legacy package surface (only `.gen`)', () => {
        expect(offenders(/require\(\s*['"]@animastor\/orchestration['"]\s*\)(?!\s*\.gen\b)/)).to.deep.equal([]);
    });

    it('nothing requires orchestration/src/legacy', () => {
        expect(offenders(/require\(\s*['"][^'"]*orchestration[^'"]*\/legacy[^'"]*['"]\s*\)/)).to.deep.equal([]);
    });

    it('no legacy/v2 split predicate (isV2Book, book-flag)', () => {
        expect(offenders(/\bisV2Book(FailClosed)?\b|orchestration-v2\/book-flag|\.\/book-flag['"]/)).to.deep.equal([]);
    });

    it('GET /worker/counts reads the host worker-health module', () => {
        const src = fs.readFileSync(path.join(SRC, 'routes', 'generation-routes.cjs'), 'utf8');
        expect(src).to.include("require('../runtime/worker-health')");
        const wh = require(path.join(SRC, 'runtime', 'worker-health.js'));
        expect(wh.getAvailability).to.be.a('function');
        expect(wh.isAvailable).to.be.a('function');
    });

    it('the pending-removal list is empty (шаг 7 done)', () => {
        expect([...PENDING_REMOVAL]).to.deep.equal([]);
    });

    it('the deleted host modules are gone; nothing requires them', () => {
        const removed = REMOVED_MODULES.map((m) => path.join(SRC, m));
        for (const m of removed) expect(fs.existsSync(m), path.relative(BACKEND, m)).to.equal(false);
        const hits = [];
        for (const { abs, rel } of scannedFiles()) {
            const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
            let m;
            const src = codeText(abs);
            while ((m = re.exec(src))) {
                const target = path.resolve(path.dirname(abs), m[1]).replace(/\.c?js$/, '');
                if (removed.some((r) => target === r.replace(/\.c?js$/, '') || target.startsWith(`${r}${path.sep}`))) hits.push(`${rel}: ${m[1]}`);
            }
        }
        expect(hits).to.deep.equal([]);
    });

    it('the package has no legacy tree; its root exports only `gen`', () => {
        const pkg = path.join(PACKAGES, 'animastor-orchestration');
        expect(fs.existsSync(path.join(pkg, 'src', 'legacy'))).to.equal(false);
        expect(Object.keys(require(path.join(pkg, 'src', 'index.js')))).to.deep.equal(['gen']);
        expect(require(path.join(pkg, 'package.json')).version).to.equal('2.0.0');
    });

    it('no code names a Redis family the purge script deletes (except SHARED_KEEP)', () => {
        const { PURGE, PURGE_HUB_V2, KEEP } = require(path.resolve(BACKEND, '..', 'scripts', 'purge-legacy-redis.cjs'));
        const keepPrefixes = KEEP.map(([g]) => g.replace(/\*.*$/, ''));
        const hits = [];
        for (const fam of [...PURGE, ...PURGE_HUB_V2]) {
            const prefix = fam.replace(/\*.*$/, '');
            const exact = !fam.includes('*');
            for (const { abs, rel } of scannedFiles()) {
                if (SHARED_KEEP[rel]) continue;
                codeText(abs).split('\n').forEach((line, i) => {
                    let idx = line.indexOf(prefix);
                    while (idx >= 0) {
                        const next = line[idx + prefix.length] || '';
                        const keptHere = keepPrefixes.some((k) => k.length > prefix.length && line.startsWith(k, idx));
                        if (!keptHere && !(exact && /[a-z0-9-]/.test(next))) { hits.push(`${rel}:${i + 1}: ${fam}`); break; }
                        idx = line.indexOf(prefix, idx + 1);
                    }
                });
            }
        }
        expect(hits).to.deep.equal([]);
    });

    it('no code names a dropped PG table (except the drop migration)', () => {
        const re = new RegExp(`\\b(${DROPPED_TABLES.join('|')})\\b`);
        const hits = offenders(re).filter((h) => !h.startsWith('backend/src/storage/postgres/schema.js:'));
        expect(hits).to.deep.equal([]);
    });
});
