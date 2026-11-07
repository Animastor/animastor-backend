// ======================================================
// Orchestration v2 (stage 2a) — the legacy contour never touches IMAGES of a v2 book
// ======================================================
// A v2 book whose IU pictures are on disk (written by the gen core) and every
// legacy image trigger seeded: active index, asset-state image=dirty, Redis
// chunk image_status=pending, dirty unit ids. Each legacy point that reads or
// repairs image state is driven once for the v2 book and once for a legacy
// control book with the same seeds:
//   command gate (image stage), scheduler tick, reconcile cycle,
//   scene-window read-repair (reconcileWindowStatuses / restoreChunkStatusForScene),
//   window slide (slideWindow / trySlideWindowOnComplete / initSceneWindow),
//   POST /book/:id/generate-next (the «regenerate missing» slide route),
//   the image dispatch itself (generateSceneIUImages is never called).
// Expected: not one legacy write for the v2 book; the control book IS processed.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const orchestration = require('@animastor/orchestration');
const bookFlag = require('../src/orchestration-v2/book-flag');
const { createMockRedis } = require('./mocks/redis-mock');

const WRITE_CMDS = ['set', 'del', 'hset', 'hdel', 'sadd', 'srem', 'expire', 'lpush', 'rpush', 'lrem', 'incr', 'incrby', 'decr', 'zrem', 'rpoplpush', 'eval'];
const HAS_CORE_11 = !!(gen.media && typeof gen.media.inspectPng === 'function');

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

describe('orchestration v2 (2a) — legacy isolation for IMAGES (one predicate, every point)', function () {
    this.timeout(60000);
    const stamp = `isoi${Date.now().toString(36)}`;
    const V2 = `${stamp}-v2`;
    const LEG = `${stamp}-legacy`;
    const BUILD = `bld-${stamp}`;
    const IU = 'iu-0f0f0f0f';
    let wsId;
    const books = new Map();

    const bookOf = (b) => ({
        manifest: { book_id: b, build_id: BUILD }, characters: [], voices: {},
        chapters: [{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', type: 'narration', audio: { full_text: 'Текст сцены.' }, units: [{ id: IU, text: 'x', image: { prompt: 'fox' } }] }] }],
    });

    before(async function () {
        if (!HAS_CORE_11) throw new Error('needs @animastor/orchestration >= 1.1.0 in backend/node_modules (publish 1.1.0 + bump the backend dependency)');
        await runMigrations();
        await gen.migrate(getPool());
        wsId = (await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`, [`w-${stamp}`])).rows[0].id;
        await query(`INSERT INTO books (book_id, title, workspace_id, orchestration) VALUES ($1, 'v2', $3, 'v2'), ($2, 'leg', $3, 'legacy')`, [V2, LEG, wsId]);
        for (const b of [V2, LEG]) {
            books.set(b, bookOf(b));
            await query(`INSERT INTO scenes (book_id, chapter_id, scene_id) VALUES ($1, 'ch-1', 'sc-1') ON CONFLICT DO NOTHING`, [b]);
            // the IU picture is on disk (for the v2 book: written by the gen core)
            const f = path.join(config.OUTPUT_DIR, BUILD, `${b}_ch-1_sc-1_${IU}.png`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a', 'hex'));
        }
        bookFlag.invalidate();
    });

    after(async () => {
        for (const t of ['scene_assets', 'scenes', 'generation_tasks', 'books']) await query(`DELETE FROM ${t} WHERE book_id = ANY($1)`, [[V2, LEG]]);
        if (wsId) await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, BUILD), { recursive: true, force: true });
    });

    async function seed(redis, b) {
        await redis.sadd('animastor:active-scenes', `${b}:ch-1:sc-1`);
        await redis.hset(`animastor:asset-state:${b}:ch-1:sc-1`, 'image', 'dirty');
        await redis.set(`animastor:chunk:${b}_ch-1_sc-1_0`, JSON.stringify({
            book_id: b, chapter_id: 'ch-1', scene_id: 'sc-1', build_id: BUILD,
            audio_status: 'pending', image: false, image_status: 'pending', video_status: 'pending',
        }));
        await redis.set(config.BOOK_SCENE_TOTAL(b), 1);
        await redis.set(config.BOOK_SCENE_NEXT(b), 0);
    }

    /** Run fn for both books on fresh tracked Redis; return the writes that name each book. */
    async function both(fn) {
        const out = {};
        for (const b of [V2, LEG]) {
            const { redis, writes } = trackingRedis();
            await seed(redis, b);
            writes.length = 0;
            const ret = await fn(redis, b);
            out[b] = { writes: writes.filter((w) => w.args.includes(b)), ret, redis };
        }
        return out;
    }

    it('command gate: the image stage of a v2 book is never authorized', async () => {
        const { redis } = trackingRedis();
        const auth = await orchestration.runtime.commandGate.getAuthorizedStages(redis, V2, 'ch-1', 'sc-1');
        expect(auth.stages.has('image')).to.equal(false);
        expect(auth.denied.image).to.equal('orchestration_v2');
    });

    it('scheduler ticks + reconcile cycles (fake clock): zero writes for the v2 book, generateSceneIUImages never called for it', async () => {
        const image = require('../src/image');
        const calls = [];
        const orig = image.generateSceneIUImages;
        image.generateSceneIUImages = async (_r, s, _b, _build, bookId) => { calls.push(bookId); return { sentCount: 0, cachedCount: 0, skippedCount: 0, total: 0 }; };
        const realNow = Date.now;
        let offset = 0;
        Date.now = () => realNow() + offset;
        const origFetch = global.fetch;
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
        try {
            const deps = { orchestrator: orchestration.orchestrator, state: require('../src/state') };
            const r = await both(async (redis) => {
                for (let tick = 0; tick < 24; tick += 1) {
                    offset += 5_000;
                    try { await orchestration.runtime.scheduler.tick(redis); } catch (_) { /* legacy errors are not the subject */ }
                    if (tick % 12 === 0) {
                        try { await orchestration.runtime.reconciliation.reconcileCycle(redis, deps, { startup: tick === 0 }); } catch (_) { /* idem */ }
                    }
                }
            });
            expect(r[V2].writes, JSON.stringify(r[V2].writes.slice(0, 5))).to.deep.equal([]);
            expect(r[LEG].writes.length, 'control: legacy ran on the legacy book').to.be.greaterThan(0);
            expect(JSON.parse(await r[V2].redis.get(`animastor:chunk:${V2}_ch-1_sc-1_0`)).image_status).to.equal('pending');
            expect(calls.filter((b) => b === V2)).to.deep.equal([]);
        } finally {
            image.generateSceneIUImages = orig;
            Date.now = realNow;
            global.fetch = origFetch;
        }
    });

    it('read-repair: reconcileWindowStatuses / restoreChunkStatusForScene do not flip a v2 chunk to image ready; legacy control is repaired', async () => {
        const sw = orchestration.runtime.sceneWindow;
        let r = await both((redis, b) => sw.reconcileWindowStatuses(redis, b, BUILD));
        expect(r[V2].ret).to.deep.equal({ reconciled: 0, reason: 'orchestration_v2' });
        expect(r[V2].writes).to.deep.equal([]);
        expect(JSON.parse(await r[LEG].redis.get(`animastor:chunk:${LEG}_ch-1_sc-1_0`)).image_status).to.equal('ready', 'control: file on disk → ready');
        r = await both((redis, b) => sw.restoreChunkStatusForScene(redis, BUILD, b, 'ch-1', 'sc-1'));
        expect(r[V2].writes).to.deep.equal([]);
        expect(r[LEG].writes.length).to.be.greaterThan(0);
    });

    it('window: slideWindow / trySlideWindowOnComplete / initSceneWindow keep out of a v2 book', async () => {
        const sw = orchestration.runtime.sceneWindow;
        const loaded = (b) => books.get(b);
        let r = await both((redis, b) => sw.slideWindow(redis, b, loaded(b), BUILD));
        expect(r[V2].ret).to.deep.equal({ started: 0, remaining: 0, reason: 'orchestration_v2' });
        expect(r[V2].writes).to.deep.equal([]);
        expect(r[LEG].writes.length, 'control: the legacy slide moves its pointers').to.be.greaterThan(0);
        r = await both((redis, b) => sw.trySlideWindowOnComplete(redis, b, loaded(b), BUILD));
        expect(r[V2].ret.reason).to.equal('orchestration_v2');
        expect(r[V2].writes).to.deep.equal([]);
        r = await both((redis, b) => sw.initSceneWindow(redis, require('../src/book').collectScenes(loaded(b)), loaded(b), BUILD, b, { scope: 'whole_book' }));
        expect(r[V2].ret).to.equal(0);
        expect(r[V2].writes).to.deep.equal([]);
        expect(r[LEG].writes.length).to.be.greaterThan(0);
    });

    it('POST /book/:id/generate-next for a v2 book: nothing started, no legacy writes', async () => {
        const { redis, writes } = trackingRedis();
        await seed(redis, V2);
        writes.length = 0;
        const app = express();
        app.use(express.json());
        require('../src/routes/book/generation-routes.cjs')(app, redis, {
            utils: { log: () => {} }, config, layerConfig: { get: async () => ({}) },
            book: { loadBook: (id) => books.get(id) || null, collectScenes: (b) => require('../src/book').collectScenes(b) },
            runtime: { sceneWindow: orchestration.runtime.sceneWindow }, state: {}, activeScenes: {}, iuRepo: {},
            getAllChunks: async () => [], getChunk: async () => null,
        });
        const server = http.createServer(app);
        await new Promise((res) => server.listen(0, '127.0.0.1', res));
        try {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/book/${V2}/generate-next`, { method: 'POST' });
            expect(r.status).to.equal(200);
            expect((await r.json()).started).to.equal(0);
        } finally { await new Promise((res) => server.close(res)); }
        expect(writes.filter((w) => w.args.includes(V2))).to.deep.equal([]);
    });

    it('fail-closed: an unknown answer of the predicate (PG error) keeps legacy out of the image read-repair', async () => {
        const sw = orchestration.runtime.sceneWindow;
        try {
            bookFlag._setRepoForTest({ getOrchestration: async () => { throw new Error('connection reset'); } });
            bookFlag.invalidate();
            const { redis, writes } = trackingRedis();
            await seed(redis, LEG);
            writes.length = 0;
            const r = await sw.reconcileWindowStatuses(redis, LEG, BUILD);
            expect(r.reason).to.equal('orchestration_v2');
            expect(writes.filter((w) => w.args.includes(LEG))).to.deep.equal([]);
        } finally { bookFlag._setRepoForTest(null); bookFlag.invalidate(); }
    });
});
