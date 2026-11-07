'use strict';
// О1 (reports/2026-11-07/orch-v2-image-scene-run.md): polling / restore
// endpoints answer with Cache-Control: no-store, without ETag, never 304.
const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { isNoStorePath, noStoreForPolling } = require('../src/middleware/no-store');

const POLL_PATHS = [
    '/book/ba_1/progress-panel',
    '/book/ba_1/progress-stream',
    '/book/ba_1/assets-state',
    '/book/ba_1/status',
    '/book/ba_1/agent-status',
    '/book/ba_1/layer-config',
    '/book/ba_1/generation-status',
    '/scene/ba_1/ch-1/sc-1/status',
    '/worker/counts',
    '/generate/commands/abc',
    '/generate',
];
const CACHEABLE_PATHS = [
    '/book/ba_1',
    '/books',
    '/scene/ba_1/ch-1/sc-1/waveform',
    '/scene/ba_1/ch-1/sc-1/storyboard',
    '/worker/counts-history',
    '/generated/x',
];

function buildApp() {
    const app = express();
    app.use('/api/v1', noStoreForPolling);
    app.get('/api/v1/book/:id/progress-panel', (req, res) => res.json({ tasks: [], any_incomplete: false }));
    app.get('/api/v1/worker/counts', (req, res) => res.json({ audio: 1 }));
    app.get('/api/v1/book/:id/assets-state', (req, res) => res.json({ scenes: {} }));
    app.get('/api/v1/book/:id/progress-stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end('data: {}\n\n');
    });
    app.get('/api/v1/book/:id', (req, res) => res.json({ book_id: req.params.id }));
    app.post('/api/v1/book/:id/progress-panel', (req, res) => res.json({ ok: true }));
    return app;
}

// Ephemeral express server + global fetch (no supertest dep, as config-routes.test.js).
let srv;
async function get(p, headers = {}) {
    const r = await fetch(srv.base + p, { headers });
    const text = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text };
}
async function post(p) {
    const r = await fetch(srv.base + p, { method: 'POST' });
    await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
}

describe('О1 no-store for polling endpoints', () => {
    before(async () => {
        await new Promise((resolve) => {
            const server = buildApp().listen(0, '127.0.0.1', () => {
                srv = { server, base: `http://127.0.0.1:${server.address().port}` };
                resolve();
            });
        });
    });
    after(() => new Promise((resolve) => srv.server.close(resolve)));

    describe('isNoStorePath', () => {
        for (const p of POLL_PATHS) it(`no-store: ${p}`, () => expect(isNoStorePath(p)).to.equal(true));
        for (const p of CACHEABLE_PATHS) it(`cacheable: ${p}`, () => expect(isNoStorePath(p)).to.equal(false));
    });

    it('progress-panel / worker/counts / assets-state: Cache-Control no-store, no ETag', async () => {
        for (const p of ['/api/v1/book/b1/progress-panel', '/api/v1/worker/counts', '/api/v1/book/b1/assets-state']) {
            const r = await get(p);
            expect(r.status, p).to.equal(200);
            expect(r.headers['cache-control'], p).to.equal('no-store');
            expect(r.headers.etag, p).to.equal(undefined);
        }
    });

    it('If-None-Match never yields 304 on a polling path', async () => {
        const r = await get('/api/v1/book/b1/progress-panel', { 'If-None-Match': 'W/"58-E8X2CSrc0ABGG0HeBBPXZeRVFU8"' });
        expect(r.status).to.equal(200);
        expect(JSON.parse(r.text)).to.deep.equal({ tasks: [], any_incomplete: false });
        // even with the ETag the server itself would have computed
        const r2 = await get('/api/v1/book/b1/progress-panel', { 'If-None-Match': '*' });
        expect(r2.status).to.equal(200);
    });

    it('progress-stream: a route-level Cache-Control is tightened to no-store', async () => {
        const r = await get('/api/v1/book/b1/progress-stream');
        expect(r.headers['cache-control']).to.equal('no-store');
    });

    it('other GETs and non-GET methods keep Express defaults (ETag, no Cache-Control)', async () => {
        const r = await get('/api/v1/book/b1');
        expect(r.headers.etag).to.be.a('string');
        expect(r.headers['cache-control']).to.equal(undefined);
        const p = await post('/api/v1/book/b1/progress-panel');
        expect(p.headers['cache-control']).to.equal(undefined);
    });

    it('backend.cjs mounts the middleware on /api/v1 before the routes', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'backend.cjs'), 'utf8');
        const mount = src.indexOf("app.use('/api/v1', noStoreForPolling)");
        expect(mount).to.be.greaterThan(0);
        const firstRoutes = src.indexOf("require('./routes/auth-routes.cjs')");
        expect(mount).to.be.lessThan(firstRoutes);
    });
});
