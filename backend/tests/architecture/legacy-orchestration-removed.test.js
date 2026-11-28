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
// PENDING_REMOVAL — files that still carry the legacy wiring and are deleted
// (or, for the composition root and the generation routes, cut) by the next
// commit of the same task (шаг 7). The list must only shrink; the next commit
// empties it.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');
const PACKAGES = path.resolve(BACKEND, '..', 'packages');

const PENDING_REMOVAL = new Set([
    'backend/src/backend.cjs',
    'backend/src/routes/generation-routes.cjs',
    'backend/src/helpers/redis-helpers.cjs',
    'backend/src/image/iu-processor.js',
    'backend/src/runtime/runtime-loop.js',
    'backend/src/services/gpu-retry-policy.cjs',
    'backend/src/services/task-handler.cjs',
    'backend/src/services/video-orchestrator.js',
    'backend/src/startup-resume.js',
    'backend/src/storage/hub-cancel-adapter.js',
    'backend/src/storage/runtime-persistence-adapter.js',
    'backend/src/orchestration-v2/book-flag.js',
]);

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

function offenders(re) {
    const hits = [];
    for (const { abs, rel } of scannedFiles()) {
        const lines = codeOnly(fs.readFileSync(abs, 'utf8')).split('\n');
        lines.forEach((line, i) => { if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`); });
    }
    return hits;
}

describe('legacy orchestration removed (ORCHESTRATION_V2 этап 4)', () => {
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

    it('the pending-removal list names only files that still exist', () => {
        for (const rel of PENDING_REMOVAL) {
            expect(fs.existsSync(path.resolve(BACKEND, '..', rel)), rel).to.equal(true);
        }
    });
});
