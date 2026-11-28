// ======================================================
// Removed legacy endpoints (ORCHESTRATION_V2 §11.3, шаг 5 разведки, 2026-11-28)
// ======================================================
// Owner decision 27.11: APKs ≤ 0.3.4 are not supported; the legacy generation
// / import endpoints below are removed (v2 branches included). Guard:
//   1. HTTP: an express app with every route registrar that used to carry
//      them answers 404 (the standard express handler) on each removed path;
//   2. the kept endpoints (until task H / step 6) are still mounted there;
//   3. static: no app.<verb>('<removed path>') registration anywhere in
//      backend/src or packages/*/src, and the deleted route files stay gone.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const BACKEND = path.resolve(__dirname, '..');
const REPO = path.resolve(BACKEND, '..');

const REMOVED = [
    ['POST', '/api/v1/generate'],
    ['POST', '/api/v1/book/b1/generate-next'],
    ['POST', '/api/v1/book/load-vbook'],
    ['POST', '/api/v1/book/import-txt'],
    ['POST', '/api/v1/book/import-text'],
    ['POST', '/api/v1/book/b1/recover-placeholders'],
    ['GET', '/api/v1/book/b1/generation-state'],
    ['GET', '/api/v1/worker/status'],
    ['POST', '/api/v1/book/b1/regenerate'],
    ['POST', '/api/v1/book/b1/cancel-generation'],
    ['GET', '/api/v1/book/b1/progress-panel'],
];

// Kept until task H (VBook as a generate layer) / step 6 (hub protocol 2).
const KEPT = [
    ['get', '/api/v1/book/:bookId/progress-stream'],
    ['post', '/api/v1/book/:bookId/cancel-worker'],
    ['post', '/api/v1/book/:bookId/bootstrap'],
    ['post', '/api/v1/book/:bookId/bootstrap-next-window'],
    ['post', '/api/v1/book/:bookId/resume-bootstrap'],
    ['post', '/api/v1/book/:bookId/trigger-next-window'],
    ['get', '/api/v1/worker/counts'],
    ['post', '/gpu/task/result'],
    ['post', '/gpu/task/error'],
    // and the replacements / neighbours that must not be collateral damage
    ['post', '/api/v1/book/import'],
    ['get', '/api/v1/book/:bookId/layer-config'],
    ['put', '/api/v1/book/:bookId/layer-config'],
    ['get', '/api/v1/book/:bookId/status'],
    ['post', '/api/v1/book/:bookId/generate'],
    ['post', '/api/v1/book/:bookId/generate/stop'],
    ['get', '/api/v1/book/:bookId/generate/progress'],
    ['get', '/api/v1/book/:bookId/generate/stream'],
];

/** deps where every unknown field is a harmless stub (registration only). */
function stubDeps(extra = {}) {
    const fn = () => undefined;
    const base = { utils: { log: () => {} }, config: {}, ...extra };
    return new Proxy(base, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'symbol') return undefined;
            return new Proxy(fn, { get: (_f, kk) => (kk === 'then' ? undefined : fn) });
        },
    });
}

function buildApp() {
    const app = express();
    app.use(express.json());
    const redis = stubDeps();
    const deps = stubDeps({ orchV2: null });
    require('../src/routes/generation-routes.cjs')(app, redis, deps);
    require('../src/routes/book/generation-routes.cjs')(app, redis, deps);
    require('../src/routes/book/import-routes.cjs')(app, redis, deps);
    require('../src/routes/book/status-routes.cjs')(app, deps);
    require('../src/routes/book/parse-routes.cjs')(app, deps);
    const { createV2Routes } = require('../src/orchestration-v2/routes');
    const v2 = createV2Routes({
        host: { isEnabled: () => false, disabledReason: () => 'test' },
        config: {}, workerRepo: {}, bookRepo: {}, layerConfig: {}, redis: null, book: null, log: () => {},
    });
    v2.mountInternal(app);
    v2.mountGenerateRoutes(app);
    return app;
}

function mounted(app) {
    const out = new Set();
    for (const layer of app._router.stack) {
        if (!layer.route) continue;
        for (const m of Object.keys(layer.route.methods)) out.add(`${m} ${layer.route.path}`);
    }
    return out;
}

describe('removed legacy endpoints (ORCHESTRATION_V2 §11.3, 2026-11-28)', () => {
    let app; let server; let base;
    before(async () => {
        app = buildApp();
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((r) => server.close(r)));

    for (const [method, url] of REMOVED) {
        it(`${method} ${url} → 404 (standard handler)`, async () => {
            const r = await fetch(`${base}${url}`, {
                method, headers: { 'content-type': 'application/json' },
                body: method === 'GET' ? undefined : '{}',
            });
            expect(r.status).to.equal(404);
            expect(await r.text()).to.match(new RegExp(`Cannot ${method} `));
        });
    }

    it('the endpoints kept until task H / step 6 are still mounted', () => {
        const have = mounted(app);
        const missing = KEPT.map(([m, p]) => `${m} ${p}`).filter((k) => !have.has(k));
        expect(missing).to.deep.equal([]);
    });

    it('no source registers a removed path; the deleted route files stay deleted', () => {
        const ROUTE_RE = /app\.(?:get|post|put|delete|patch)\(\s*['"`](\/api\/v1\/(?:generate|book\/:bookId\/(?:generate-next|recover-placeholders|generation-state|regenerate|cancel-generation|progress-panel)|book\/(?:load-vbook|import-txt|import-text)|worker\/status))['"`]/;
        const roots = [path.join(BACKEND, 'src'), ...fs.readdirSync(path.join(REPO, 'packages')).map((p) => path.join(REPO, 'packages', p, 'src'))];
        const hits = [];
        const walk = (d) => {
            if (!fs.existsSync(d)) return;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
                if (!/\.(c?js|mjs)$/.test(e.name)) continue;
                const m = fs.readFileSync(p, 'utf8').match(ROUTE_RE);
                if (m) hits.push(`${path.relative(REPO, p)}: ${m[1]}`);
            }
        };
        roots.forEach(walk);
        expect(hits).to.deep.equal([]);
        for (const f of ['routes/book/progress-panel.cjs', 'routes/book/recovery-routes.cjs', 'services/regenerate-hub-sweep.cjs']) {
            expect(fs.existsSync(path.join(BACKEND, 'src', f)), f).to.equal(false);
        }
    });
});
