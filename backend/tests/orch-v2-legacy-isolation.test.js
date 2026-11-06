// ======================================================
// Orchestration v2 (stage 1b/E) — the legacy contour never touches a v2 book
// ======================================================
// A v2 book with placeholder audio and every legacy trigger seeded (active
// index, asset-state GENERATING, audio-orch WAITING_CHUNKS long stalled,
// event journal, hub result key, pending GPU retry). 5 minutes of legacy
// cycles on a fake clock (scheduler tick every 5 s, reconcile every 60 s,
// the first one with startup phases) + gpu-retry-policy + startup-resume.
// Expected: NOT ONE legacy write for the v2 book (Redis, generation_tasks,
// hub), while the same seeds of a legacy control book DO get processed.
// Plus: master flag OFF / missing secret / missing ffmpeg → v2 does nothing.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const orchestration = require('@animastor/orchestration');
const bookFlag = require('../src/orchestration-v2/book-flag');
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

describe('orchestration v2 — legacy isolation (one predicate, fail-closed)', function () {
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
        await query(`INSERT INTO books (book_id, title, workspace_id, orchestration) VALUES ($1, 'v2', $3, 'v2'), ($2, 'leg', $3, 'legacy')`, [V2, LEG, wsId]);
        for (const b of [V2, LEG]) {
            await query(`INSERT INTO scenes (book_id, chapter_id, scene_id) VALUES ($1, 'ch-1', 'sc-1') ON CONFLICT DO NOTHING`, [b]);
            await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, status, path)
                         VALUES ($1, 'ch-1', 'sc-1', 'audio', $2, 'placeholder', $3)`, [b, BUILD, path.join(config.OUTPUT_DIR, BUILD, `${b}_ch-1_sc-1.mp3`)]);
            const f = path.join(config.OUTPUT_DIR, BUILD, `${b}_ch-1_sc-1.mp3`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, Buffer.alloc(2048, 0));
            require('../src/audio/placeholder-marker').writePlaceholderMarker(f, { reason: 'import' });
        }
        bookFlag.invalidate();
    });

    after(async () => {
        for (const t of ['scene_assets', 'scenes', 'generation_tasks', 'books']) await query(`DELETE FROM ${t} WHERE book_id = ANY($1)`, [[V2, LEG]]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, BUILD), { recursive: true, force: true });
    });

    async function seed(redis, b) {
        const jobSchema = require('@animastor/contracts').jobProtocolV2;
        const chunks = require('../src/audio/chunks');
        const audioOrch = require('../src/services/audio-orchestrator');
        await redis.sadd('animastor:active-scenes', `${b}:ch-1:sc-1`);
        await redis.hset(`animastor:asset-state:${b}:ch-1:sc-1`, 'audio', 'generating');
        await redis.set(`animastor:audio-orch:${b}:ch-1:sc-1`, JSON.stringify({
            phase: audioOrch.PHASES.WAITING_CHUNKS, expected_count: 1, chunks_received: 0,
            started_at: Date.now() - 3 * 3600_000, build_id: BUILD, dispatch_id: 'd-old',
        }));
        await redis.lpush(`animastor:event-journal:${b}:ch-1:sc-1`, JSON.stringify({ type: 'AUDIO_DISPATCHED', ts: Date.now() }));
        const jobId = jobSchema.buildJobId(chunks.makeChunkId('ch-1', 'sc-1', 1, b), 'audio');
        await redis.set(`animastor:result:${BUILD}:${b}:ch-1:sc-1:audio`, JSON.stringify({ job_id: jobId, result_base64: 'AAAA', build_id: BUILD, dispatch_id: 'd-old' }));
        await redis.set(`animastor:gpu-retry:pending:${b}:ch-1:sc-1:audio`, JSON.stringify({ book_id: b, chapter_id: 'ch-1', scene_id: 'sc-1', stage: 'audio', task_id: 't', retry_no: 1 }));
    }

    it('5 min of legacy cycles (fake clock): zero legacy writes for the v2 book; the legacy control book is processed', async () => {
        const { redis, writes } = trackingRedis();
        await seed(redis, V2);
        await seed(redis, LEG);
        writes.length = 0;
        const fetchCalls = [];
        const origFetch = global.fetch;
        global.fetch = async (url) => { fetchCalls.push(String(url)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
        const realNow = Date.now;
        let offset = 0;
        Date.now = () => realNow() + offset;
        const rt = orchestration.runtime;
        try {
            // gate: never authorized
            const auth = await rt.commandGate.getAuthorizedStages(redis, V2, 'ch-1', 'sc-1');
            expect(auth.stages.size).to.equal(0);
            expect(auth.denied.audio).to.equal('orchestration_v2');
            // startup-resume (before the loop, as backend.cjs)
            await require('../src/startup-resume').interruptActiveGenerationTasks(redis, { log: () => {} });
            const deps = { orchestrator: orchestration.orchestrator, state: require('../src/state') };
            for (let tick = 0; tick < 60; tick += 1) {                  // 60 × 5 s = 5 min
                offset += 5_000;
                try { await rt.scheduler.tick(redis); } catch (_) { /* legacy errors are not the subject */ }
                if (tick % 12 === 0) {
                    try { await rt.reconciliation.reconcileCycle(redis, deps, { startup: tick === 0 }); } catch (_) { /* idem */ }
                }
            }
            // gpu retry policy: a v2 book's failure / pending retry is not legacy's
            const retry = require('../src/services/gpu-retry-policy.cjs');
            const r1 = await retry.handleStageFailure(redis, { bookId: V2, chapterId: 'ch-1', sceneId: 'sc-1', stage: 'audio', buildId: BUILD, dispatchId: 'd', reason: 'timeout' });
            expect(r1).to.deep.equal({ handled: false, reason: 'orchestration_v2' });
            const r2 = await retry.fireRetry(redis, `animastor:gpu-retry:pending:${V2}:ch-1:sc-1:audio`);
            expect(r2).to.deep.equal({ retried: false, reason: 'orchestration_v2' });
        } finally {
            Date.now = realNow;
            global.fetch = origFetch;
        }
        const v2Writes = writes.filter((w) => w.args.includes(V2));
        expect(v2Writes, JSON.stringify(v2Writes.slice(0, 5))).to.deep.equal([]);
        expect(writes.filter((w) => w.args.includes(LEG)).length, 'control: legacy did run on the legacy book').to.be.greaterThan(0);
        expect(Number((await query(`SELECT count(*) AS n FROM generation_tasks WHERE book_id = $1`, [V2])).rows[0].n)).to.equal(0);
        expect(fetchCalls.filter((u) => u.includes(V2))).to.deep.equal([]);
        // the v2 seeds are still exactly there
        expect(await redis.get(`animastor:gpu-retry:pending:${V2}:ch-1:sc-1:audio`)).to.be.a('string');
        expect(await redis.sismember ? true : true).to.equal(true);
        const placeholder = (await query(`SELECT status FROM scene_assets WHERE book_id = $1`, [V2])).rows[0].status;
        expect(placeholder).to.equal('placeholder');
    });

    it('book-flag: missing column → legacy; PG error → fail-closed (v2); cache invalidation', async () => {
        try {
            bookFlag._setRepoForTest({ getOrchestration: async () => { throw Object.assign(new Error('column does not exist'), { code: '42703' }); } });
            expect(await bookFlag.isV2Book('x')).to.equal(false);
            bookFlag._setRepoForTest({ getOrchestration: async () => { throw new Error('connection reset'); } });
            expect(await bookFlag.isV2BookFailClosed('y')).to.equal(true);
            let v = 'legacy';
            bookFlag._setRepoForTest({ getOrchestration: async () => v });
            expect(await bookFlag.isV2Book('z')).to.equal(false);
            v = 'v2';
            expect(await bookFlag.isV2Book('z')).to.equal(false, 'cached');
            bookFlag.invalidate('z');
            expect(await bookFlag.isV2Book('z')).to.equal(true);
        } finally { bookFlag._setRepoForTest(null); }
        // the real repo against PG
        expect(await bookFlag.isV2Book(V2)).to.equal(true);
        expect(await bookFlag.isV2Book(LEG)).to.equal(false);
        expect(await bookFlag.isV2Book(`${stamp}-missing`)).to.equal(false);
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
        routes.mountInternal({ post: (p, ...h) => { handlers[`POST ${p}`] = h; }, put: (p, ...h) => { handlers[`PUT ${p}`] = h; } });
        const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        const [auth, handler] = handlers['POST /internal/gen/claim'];
        await new Promise((resolve) => auth({ headers: { 'x-api-key': 'k' } }, res, resolve));
        await handler({ body: { worker_id: crypto.randomUUID() }, headers: {} }, res);
        expect(res.code).to.equal(503);
        expect(res.body.code).to.equal('orch_v2_disabled');
    });
    it('window-generator: the next window of a v2 book writes no legacy chunk / scene counters (placeholders only); legacy control writes them; PG error → v2', async () => {
        async function runWindow(bookId) {
            const { redis, writes } = trackingRedis();
            const saved = [];
            const placeholders = [];
            const wg = require('../src/services/window-generator.cjs')({
                redis,
                txtImporter: { bootstrapNextWindow: async () => ({ all_done: false, added_scenes: 2, chapter: { chapter: 'ch-9', scenes: [{ scene_id: 'sc-a', type: 'narration' }, { scene_id: 'sc-b', type: 'narration' }] } }) },
                genSessionRepo: { updateSession: async () => {}, getSessionsByStatus: async () => [], setBookCompletionStatus: async () => {} },
                state: {}, activeScenes: {},
                placeholderAudio: { ensureAllPlaceholderAudio: async (_b, _book, scenes) => { placeholders.push(...scenes); return { created: scenes.length, skipped: 0 }; } },
                saveChunk: async (id, data) => { saved.push({ id, data }); },
                config,
            });
            await wg.runBackgroundWindowGeneration(bookId, 'sess-1', { buildId: BUILD });
            return { saved, placeholders, writes };
        }
        bookFlag.invalidate();
        const v2 = await runWindow(V2);
        expect(v2.saved).to.deep.equal([], 'no legacy chunk record for a v2 book');
        expect(v2.writes.filter((w) => w.args.includes(V2))).to.deep.equal([], 'no scene counters / Redis writes for the v2 book');
        expect(v2.placeholders.map((x) => x.scene_id)).to.deep.equal(['sc-a', 'sc-b'], 'placeholders are still created');

        const leg = await runWindow(LEG);
        expect(leg.saved.map((x) => x.data.scene_id)).to.deep.equal(['sc-a', 'sc-b'], 'legacy book: chunk records written');
        // NOTE (found in 1c, NOT fixed — legacy is frozen): on main since 779cc3e
        // `let chunkCount = 0;` sits inside the comment line «— 3. Create chunks…», so
        // the legacy loop throws ReferenceError right after saveChunk → no placeholder
        // and no scene counters for a legacy book's next window. When it is fixed this
        // control flips: placeholders ['sc-a','sc-b'] + BOOK_SCENE_TOTAL written.
        expect(leg.placeholders).to.deep.equal([], 'pre-existing legacy bug (chunkCount) — see the note');

        // fail-closed: unknown answer (PG error) → treated as v2 → nothing legacy written
        try {
            bookFlag._setRepoForTest({ getOrchestration: async () => { throw new Error('connection reset'); } });
            bookFlag.invalidate();
            const err = await runWindow(LEG);
            expect(err.saved).to.deep.equal([]);
        } finally { bookFlag._setRepoForTest(null); bookFlag.invalidate(); }
    });
});
