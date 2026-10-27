// ======================================================
// STAGE 146 — D2 REGRESSION: /api/v1/debug/runtime/* must not hang
// ======================================================
// D2: the prefix middleware
//     app.use('/api/v1/debug/runtime', (req, res) => { res.locals... })
// wrote res.locals but never called next(), so it swallowed every request to
// that subtree: the downstream route handlers never ran and the client hung
// (curl HTTP 000) instead of receiving a response.
//
// This test boots the REAL route module on a real Express app and issues a
// real HTTP request with a hard timeout. Pre-fix the request hangs and the
// AbortController fires (test fails); post-fix the route answers 200.
// ======================================================

const { expect } = require('chai');
const express = require('express');
const proxyquire = require('proxyquire');

// Stub the one heavy factory the module builds at load time (it is irrelevant
// to the middleware/next() contract under test).
const debugRoutes = proxyquire('../src/routes/debug-routes.cjs', {
    '../services/audio-recovery.cjs': () => ({
        recoverAudioForScene: async () => ({ reason: 'stub' }),
        recoverAudioResults: async () => {},
    }),
});

function buildDeps() {
    return {
        config: { OUTPUT_DIR: '/tmp' },
        state: {}, audio: {}, image: {}, video: {}, book: {}, orchestrator: {},
        storage: {}, runtime: {}, activeScenes: {}, layerConfig: {}, genScope: {},
        placeholderAudio: {}, utils: { log: () => {} },
        saveChunk: () => {}, getChunk: async () => null, getAllChunks: () => [],
        getBookWindowStatus: () => ({}), detectAvailableMode: () => 'x',
        recoverChunksFromDisk: async () => {}, recoverAllBooksFromDisk: async () => {},
        cleanupService: { stats: {} }, iuRepo: {}, computeWaveform: () => null,
        taskHandler: {}, bookDiff: {},
        journal: { getSceneEvents: async () => [] },
    };
}

function buildRedisMock() {
    return {
        get: async () => null,
        scard: async () => 0,
        scan: async () => ['0', []],
        smembers: async () => [],
        del: async () => 0,
        set: async () => 'OK',
    };
}

describe('stage146 — D2: debug runtime middleware calls next()', function () {
    this.timeout(8000);

    let server;
    let base;

    before(() => {
        const app = express();
        app.use(express.json());
        debugRoutes(app, buildRedisMock(), buildDeps());
        server = app.listen(0);
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('GET /api/v1/debug/runtime/status responds instead of hanging', async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3000);
        try {
            const res = await fetch(`${base}/api/v1/debug/runtime/status`, { signal: ac.signal });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body).to.have.property('runtime');
        } finally {
            clearTimeout(timer);
        }
    });
});
