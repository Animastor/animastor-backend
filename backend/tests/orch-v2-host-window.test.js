// ======================================================
// Orchestration v2 host: master flag + the VBook window of a book
// ======================================================
// Until 2026-11-28 this file proved that the legacy contour never touched a
// v2 book (one predicate, fail-closed). The legacy contour and the predicate
// are gone (ORCHESTRATION_V2 этап 4): what stays is
//   • master flag OFF / missing secret / missing ffmpeg → v2 does nothing;
//   • window-generator: the next VBook window writes no Redis chunk records /
//     scene counters (placeholders only) — for every book.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const { createOrchV2Host } = require('../src/orchestration-v2');
const { createMockRedis } = require('./mocks/redis-mock');

const WRITE_CMDS = ['set', 'del', 'hset', 'hdel', 'sadd', 'srem', 'expire', 'lpush', 'rpush', 'lrem', 'incr', 'incrby', 'decr', 'zrem', 'rpoplpush', 'eval'];

function trackingRedis() {
    const redis = createMockRedis();
    const writes = [];
    for (const cmd of WRITE_CMDS) {
        if (typeof redis[cmd] !== 'function') continue;
        const orig = redis[cmd].bind(redis);
        redis[cmd] = async (...args) => {
            writes.push({ cmd, args: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
            return orig(...args);
        };
    }
    redis.publish = async (ch, msg) => { writes.push({ cmd: 'publish', args: `${ch} ${msg}` }); return 0; };
    return { redis, writes };
}

describe('orchestration v2 host — master flag and the VBook window', function () {
    this.timeout(60000);
    const stamp = `iso${Date.now().toString(36)}`;
    const V2 = `${stamp}-v2`;
    const LEG = `${stamp}-legacy`;
    const BUILD = `bld-${stamp}`;
    let wsId;

    before(async () => {
        await runMigrations();
        await gen.migrate(getPool());
        wsId = (await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`, [`w-${stamp}`])).rows[0].id;
        await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, 'v2', $3), ($2, 'second', $3)`, [V2, LEG, wsId]);
        for (const b of [V2, LEG]) {
            await query(`INSERT INTO scenes (book_id, chapter_id, scene_id) VALUES ($1, 'ch-1', 'sc-1') ON CONFLICT DO NOTHING`, [b]);
            await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, status, path)
                         VALUES ($1, 'ch-1', 'sc-1', 'audio', $2, 'placeholder', $3)`, [b, BUILD, path.join(config.OUTPUT_DIR, BUILD, `${b}_ch-1_sc-1.mp3`)]);
            const f = path.join(config.OUTPUT_DIR, BUILD, `${b}_ch-1_sc-1.mp3`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, Buffer.alloc(2048, 0));
            require('../src/audio/placeholder-marker').writePlaceholderMarker(f, { reason: 'import' });
        }
    });

    after(async () => {
        for (const t of ['scene_assets', 'scenes', 'generation_tasks', 'books']) await query(`DELETE FROM ${t} WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, BUILD), { recursive: true, force: true });
    });

    it('master flag OFF (default), missing secret, missing ffmpeg → nothing of v2 starts (no migration)', async () => {
        let migrations = 0;
        const fakeGen = { migrate: async () => { migrations += 1; }, createOrchestration: () => { throw new Error('must not be created'); } };
        const cases = [
            [{}, /ORCH_V2_ENABLED/],
            [{ ORCH_V2_ENABLED: '0', ORCH_V2_UPLOAD_SECRET: 'x'.repeat(40) }, /ORCH_V2_ENABLED/],
            [{ ORCH_V2_ENABLED: '1' }, /ORCH_V2_UPLOAD_SECRET/],
            [{ ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: 'short' }, /ORCH_V2_UPLOAD_SECRET/],
        ];
        for (const [env, reason] of cases) {
            const h = createOrchV2Host({ env, gen: fakeGen, getPool, hasFfmpeg: () => true, log: () => {} });
            await h.start();
            expect(h.isEnabled()).to.equal(false);
            expect(h.disabledReason()).to.match(reason);
        }
        const noFf = createOrchV2Host({ env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: 'x'.repeat(40) }, gen: fakeGen, getPool, hasFfmpeg: () => false, log: () => {} });
        await noFf.start();
        expect(noFf.isEnabled()).to.equal(false);
        expect(noFf.disabledReason()).to.match(/ffmpeg/);
        expect(migrations).to.equal(0);
        // routes answer 503 with the flag off
        const { createV2Routes } = require('../src/orchestration-v2/routes');
        const routes = createV2Routes({ host: noFf, config: { GPU_HUB_API_KEY: 'k' }, workerRepo: {}, bookRepo: {}, layerConfig: {}, redis: null, book: null, log: () => {} });
        const handlers = {};
        routes.mountInternal({ post: (p, ...h) => { handlers[`POST ${p}`] = h; }, put: (p, ...h) => { handlers[`PUT ${p}`] = h; }, get: (p, ...h) => { handlers[`GET ${p}`] = h; } });
        const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        const [auth, handler] = handlers['POST /internal/gen/claim'];
        await new Promise((resolve) => auth({ headers: { 'x-api-key': 'k' } }, res, resolve));
        await handler({ body: { worker_id: crypto.randomUUID() }, headers: {} }, res);
        expect(res.code).to.equal(503);
        expect(res.body.code).to.equal('orch_v2_disabled');
    });
    it('window-generator: the next window writes no Redis chunk records / scene counters (placeholders only) — every book', async () => {
        async function runWindow(bookId) {
            const { redis, writes } = trackingRedis();
            const placeholders = [];
            const wg = require('../src/services/window-generator.cjs')({
                redis,
                txtImporter: { bootstrapNextWindow: async () => ({ all_done: false, added_scenes: 2, chapter: { chapter_id: 'ch-9', scenes: [{ scene_id: 'sc-a', type: 'narration' }, { scene_id: 'sc-b', type: 'narration' }] } }) },
                genSessionRepo: { updateSession: async () => {}, getSessionsByStatus: async () => [], setBookCompletionStatus: async () => {} },
                placeholderAudio: { ensureAllPlaceholderAudio: async (_b, _book, scenes) => { placeholders.push(...scenes); return { created: scenes.length, skipped: 0 }; } },
                config,
            });
            await wg.runBackgroundWindowGeneration(bookId, 'sess-1', { buildId: BUILD });
            return { placeholders, writes };
        }
        for (const bookId of [V2, LEG]) {
            const r = await runWindow(bookId);
            expect(r.writes.filter((w) => w.args.includes(bookId))).to.deep.equal([], 'no chunk records / scene counters / Redis writes for the book');
            expect(r.placeholders.map((x) => x.scene_id)).to.deep.equal(['sc-a', 'sc-b'], 'placeholders are still created');
            // bootstrap idempotency (2026-11-26): chapter_id, never "undefined"
            expect(r.placeholders.map((x) => x.chapter_id)).to.deep.equal(['ch-9', 'ch-9']);
        }
    });
});
