'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, count, fixture, streamOf, SECRET } = require('./helpers');

const TONE = fixture('tone.mp3');
const jobsSnapshot = async (ctx) => (await ctx.q(
    `SELECT count(*)::int AS n, max(created_at) AS last, string_agg(job_id::text, ',' ORDER BY job_id) AS ids FROM gen_jobs`)).rows[0];

describe('gen v2 — sweeper (ADR §9)', function () {
    this.timeout(30000);
    let ctx; let o; let book; let worker;
    async function setup(plan = { ch: { sc: 2 } }, opts = {}) {
        ctx = await setupDb();
        o = gen.createOrchestration({ pool: ctx.pool, ports: makePorts(ctx, plan).ports, uploadSecret: SECRET, outputDir: ctx.outputDir, ...opts });
        book = await makeBook(ctx);
        worker = await makeWorker(ctx, { workspaceId: book.workspaceId });
    }
    afterEach(async () => { o.stop(); await ctx.teardown(); });
    const command = (extra = {}) => o.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'], ...extra });
    const claim = async () => (await o.claim({ workerId: worker, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
    const status = async (id) => (await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [id])).rows[0].status;

    it('deadline passed → timeout: re-queued (same row, attempt kept), last attempt → failed; never a new row (I1)', async () => {
        await setup({ ch: { sc: 1 } });
        await command();
        const before = await jobsSnapshot(ctx);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const t = await claim();
            assert.equal(t.attempt, attempt);
            await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 s'`);
            const s = await o.sweepOnce();
            assert.equal(s.timeouts, 1);
            const j = (await ctx.q(`SELECT status, attempt, error_class FROM gen_jobs`)).rows[0];
            assert.equal(j.attempt, attempt); assert.equal(j.error_class, 'timeout');
            assert.equal(j.status, attempt < 3 ? 'queued' : 'failed');
            await ctx.q(`UPDATE gen_jobs SET not_before = now()`);
        }
        assert.deepEqual(await jobsSnapshot(ctx), before);
    });

    it('worker silent > 60 s → worker_offline before the deadline; a live worker keeps its job', async () => {
        await setup({ ch: { sc: 2 } });
        await command();
        const live = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const t1 = await claim();
        const t2 = (await o.claim({ workerId: live, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
        await ctx.q(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint - 61 WHERE worker_id = $1`, [worker]);
        await o.beacon(live, { current_job_id: t2.job_id });
        const s = await o.sweepOnce();
        assert.equal(s.offline, 1); assert.equal(s.timeouts, 0);
        const rows = Object.fromEntries((await ctx.q(`SELECT job_id, status, error_class FROM gen_jobs`)).rows.map((r) => [r.job_id, r]));
        assert.equal(rows[t1.job_id].status, 'queued'); assert.equal(rows[t1.job_id].error_class, 'worker_offline');
        assert.equal(rows[t2.job_id].status, 'running');
        // the stale worker's late result is refused (I4)
        assert.deepEqual(await o.acceptResult(t1.job_id, t1.attempt, t1.upload_token, streamOf(TONE)), { status: 409, code: 'stale_attempt' });
    });

    it('command completion over gen_command_jobs: done / partial / failed / cancelled', async () => {
        await setup({ ch: { s1: 1, s2: 1 } });
        // done (empty command — everything ready → done immediately)
        await ctx.q(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, scene_hash, status)
                     VALUES ($1, 'ch', 's1', 'audio', 'build-1', 'h-s1', 'ready'), ($1, 'ch', 's2', 'audio', 'build-1', 'h-s2', 'ready')`, [book.bookId]);
        const empty = await command();
        assert.equal(empty.summary.skipped_ready, 2);
        await o.sweepOnce();
        assert.equal(await status(empty.command_id), 'done');
        await ctx.q(`DELETE FROM scene_assets`);

        // partial: one chunk ok (+ merge), one failed
        const p = await command();
        const a = await claim(); const b = await claim();
        await o.acceptResult(a.job_id, a.attempt, a.upload_token, streamOf(TONE));
        await o.acceptError(b.job_id, b.attempt, b.upload_token, { error_class: 'deterministic' });
        // a later scene command: the scene is not ready yet (merge queued) → it plans its own chunk;
        // p is not waiting for that chunk (not linked to p)
        const later = await o.createCommand({ ...book, scope: { level: 'scene', chapter_id: 'ch', scene_id: a.scene_id }, layers: ['audio'] });
        assert.deepEqual(later.summary, { jobs_created: 1, joined: 0, skipped_ready: 0 });
        await o.sweepOnce();
        assert.equal(await status(p.command_id), 'active', 'merge of p still queued');
        await o.runLocalOnce();
        await o.sweepOnce();
        assert.equal(await status(p.command_id), 'partial');
        assert.equal(await status(later.command_id), 'active');
        await o.cancel({ commandId: later.command_id });

        // failed: every job failed
        const f = await command({ scope: { level: 'scene', chapter_id: 'ch', scene_id: 's1' }, force: true });
        const x = await claim();
        await o.acceptError(x.job_id, x.attempt, x.upload_token, { error_class: 'deterministic' });
        await o.sweepOnce();
        assert.equal(await status(f.command_id), 'failed');

        // cancelled by layer: command still active → finished as cancelled
        const c = await command({ scope: { level: 'scene', chapter_id: 'ch', scene_id: 's2' }, force: true });
        await o.cancel({ bookId: book.bookId, layer: 'audio' });
        assert.equal(await status(c.command_id), 'active');
        await o.sweepOnce();
        assert.equal(await status(c.command_id), 'cancelled');
    });

    it('I1: no sweepOnce call ever creates a gen_jobs row (row count over a mixed workload)', async () => {
        await setup({ ch: { s1: 2, s2: 2, s3: 1 } });
        await command();
        const t = [await claim(), await claim(), await claim()];
        await o.acceptResult(t[0].job_id, t[0].attempt, t[0].upload_token, streamOf(TONE));
        await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 s' WHERE job_id = $1`, [t[1].job_id]);
        await ctx.q(`UPDATE workers SET last_seen = 0`);
        const before = await jobsSnapshot(ctx);
        for (let i = 0; i < 5; i += 1) {
            await o.sweepOnce();
            await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 s' WHERE status = 'running'`);
        }
        assert.deepEqual(await jobsSnapshot(ctx), before);
        assert.ok(before.n > 0);
    });

    it('.incoming/*.tmp older than 1 h are removed; fresh ones kept; startSweeper/stopSweeper drive sweepOnce', async () => {
        await setup({ ch: { sc: 1 } }, { incomingMaxAgeMs: 60 * 60_000 });
        const dir = path.join(ctx.outputDir, 'build-1', '.incoming');
        fs.mkdirSync(dir, { recursive: true });
        const old = path.join(dir, 'a.1.x.tmp'); const fresh = path.join(dir, 'b.1.x.tmp'); const other = path.join(dir, 'keep.txt');
        for (const p of [old, fresh, other]) fs.writeFileSync(p, 'x');
        const past = new Date(Date.now() - 2 * 60 * 60_000);
        fs.utimesSync(old, past, past); fs.utimesSync(other, past, past);
        const s = await o.sweepOnce();
        assert.equal(s.tmp_removed, 1);
        assert.deepEqual([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(other)], [false, true, true]);

        await command();
        await claim();
        await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 s'`);
        o.startSweeper(20);
        for (let i = 0; i < 50 && (await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE status = 'running'`)) > 0; i += 1) {
            await new Promise((r) => setTimeout(r, 20));
        }
        o.stopSweeper();
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE status = 'queued' AND error_class = 'timeout'`), 1);
    });
});

describe('gen v2 — restart: a new module instance over the same tables continues without loss (§9, §13.1)', function () {
    this.timeout(30000);
    let ctx;
    afterEach(async () => { await ctx.teardown(); });

    function freshGen() {
        const root = path.resolve(__dirname, '../../src/gen');
        for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
        return require('../../src/gen');
    }

    it('commands, running attempts, upload tokens and the sweeper all survive; nothing new is created by the restart', async () => {
        ctx = await setupDb();
        const genA = freshGen();
        const portsA = makePorts(ctx, { ch: { s1: 2, s2: 1 } });
        const a = genA.createOrchestration({ pool: ctx.pool, ports: portsA.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        a.startSweeper(10_000);
        const book = await makeBook(ctx);
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const cmd = await a.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'], clientActionId: 'k1' });
        const claimA = async (o) => (await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
        const t1 = await claimA(a);
        const t2 = await claimA(a);
        await a.acceptResult(t1.job_id, t1.attempt, t1.upload_token, streamOf(TONE));
        a.stop();
        const before = await jobsSnapshot(ctx);

        // «backend restart»: new module instance, new pool, same tables
        const genB = freshGen();
        assert.notEqual(genB, genA);
        const pool2 = ctx.newPool();
        try {
            const portsB = makePorts({ ...ctx, pool: pool2 }, { ch: { s1: 2, s2: 1 } });
            const b = genB.createOrchestration({ pool: pool2, ports: portsB.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
            await b.sweepOnce();
            assert.deepEqual(await jobsSnapshot(ctx), before, 'restart + sweep create nothing (I1, §13.1)');
            // the repeated click after restart → same command
            const again = await b.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'], clientActionId: 'k1' });
            assert.equal(again.command_id, cmd.command_id);
            // the worker's in-flight upload (token from instance A) is accepted by B
            const r = await b.acceptResult(t2.job_id, t2.attempt, t2.upload_token, streamOf(TONE));
            assert.equal(r.status, 200); assert.equal(r.stage_jobs_created, 1);
            const t3 = await claimA(b);
            assert.equal((await b.acceptResult(t3.job_id, t3.attempt, t3.upload_token, streamOf(TONE))).stage_jobs_created, 1);
            while (await b.runLocalOnce()) { /* merges */ }
            await b.sweepOnce();
            assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [cmd.command_id])).rows[0].status, 'done');
            assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE status <> 'done'`), 0);
            assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs`), 5); // 3 chunks + 2 merges
            assert.equal(await count(ctx, `SELECT count(*) AS n FROM scene_assets WHERE status = 'ready' AND sha256 IS NOT NULL`), 2);
        } finally { await pool2.end(); }
    });
});

describe('gen v2 — progress (ADR §9)', function () {
    this.timeout(30000);
    let ctx; let o;
    afterEach(async () => { o.stop(); await ctx.teardown(); });

    it('aggregates per command / layer / scene incl. joined units; NOTIFY gen_progress on commit', async () => {
        ctx = await setupDb();
        o = gen.createOrchestration({ pool: ctx.pool, ports: makePorts(ctx, { ch: { s1: 2, s2: 1 } }).ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        const book = await makeBook(ctx);
        const events = [];
        const sub = await o.listenProgress((e) => events.push(e));
        try {
            const c1 = await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'] });
            const c2 = await o.createCommand({ ...book, scope: { level: 'scene', chapter_id: 'ch', scene_id: 's1' }, layers: ['audio'] });
            const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
            const t = (await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
            await o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(TONE));
            const p = await o.progress(book.bookId);
            assert.equal(p.commands.length, 2);
            const p1 = p.commands.find((c) => c.command_id === c1.command_id);
            const p2 = p.commands.find((c) => c.command_id === c2.command_id);
            assert.deepEqual([p1.totals.queued, p1.totals.running, p1.totals.done], [2, 0, 1]);
            assert.deepEqual(p1.by_layer.audio.done, 1);
            assert.equal(p1.scenes.find((s) => s.scene_id === 's1').done, 1);
            // c2 joined both s1 chunks of c1: one done, one queued (both also counted as joined)
            assert.deepEqual([p2.totals.queued, p2.totals.done, p2.totals.joined_queued], [1, 1, 1]);
            for (let i = 0; i < 20 && !events.some((e) => e.command_id === c2.command_id); i += 1) await new Promise((r) => setTimeout(r, 20));
            assert.ok(events.some((e) => e.book_id === book.bookId && e.command_id === c1.command_id));
            assert.ok(events.some((e) => e.command_id === c2.command_id));
            assert.deepEqual((await o.progress('nope')).commands, []);
        } finally { await sub.close(); }
    });
});
