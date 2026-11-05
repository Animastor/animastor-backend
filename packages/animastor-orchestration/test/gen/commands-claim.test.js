'use strict';

const assert = require('node:assert/strict');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, count, uuid, SECRET } = require('./helpers');

const PLAN = { 'ch-1': { 'sc-1': 3, 'sc-2': 2 }, 'ch-2': { 'sc-3': 2 } };

describe('gen v2 — createCommand / cancel / beacon (ADR §6)', function () {
    this.timeout(30000);
    let ctx; let o; let book;
    beforeEach(async () => {
        ctx = await setupDb();
        o = gen.createOrchestration({ pool: ctx.pool, ports: makePorts(ctx, PLAN).ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        book = await makeBook(ctx);
    });
    afterEach(async () => { o.stop(); await ctx.teardown(); });

    const cmd = (extra = {}) => o.createCommand({ ...book, kind: 'regenerate', scope: { level: 'book' }, layers: ['audio'], ...extra });

    it('book command creates first-stage jobs only (audio_chunk), queued, with lane and max_attempts', async () => {
        const r = await cmd({ clientActionId: 'a1' });
        assert.equal(r.created, true);
        assert.deepEqual(r.summary, { jobs_created: 7, joined: 0, skipped_ready: 0 });
        const rows = (await ctx.q(`SELECT kind, executor, status, lane, max_attempts, attempt FROM gen_jobs`)).rows;
        assert.equal(rows.length, 7);
        for (const j of rows) {
            assert.equal(j.kind, 'audio_chunk'); assert.equal(j.executor, 'gpu:audio'); assert.equal(j.status, 'queued');
            assert.deepEqual(j.lane, { kind: 'private', workspace_id: book.workspaceId });
            assert.equal(j.max_attempts, 3); assert.equal(j.attempt, 0);
        }
    });

    it('double createCommand with the same client_action_id → ONE command, no duplicate jobs (sequential and concurrent)', async () => {
        const a = await cmd({ clientActionId: 'click-1' });
        const b = await cmd({ clientActionId: 'click-1' });
        assert.equal(b.command_id, a.command_id);
        assert.equal(b.existing, true); assert.equal(b.created, false);
        assert.equal(b.summary.jobs_created, 7);
        const [c, d, e] = await Promise.all([cmd({ clientActionId: 'click-2' }), cmd({ clientActionId: 'click-2' }), cmd({ clientActionId: 'click-2' })]);
        assert.equal(new Set([c.command_id, d.command_id, e.command_id]).size, 1);
        assert.equal([c, d, e].filter((x) => x.created).length, 1);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_commands`), 2);
        // click-2 overlapped click-1 entirely → all joined, still 7 rows
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs`), 7);
    });

    it('overlapping commands → joined, no duplicates; the new command cancels nothing', async () => {
        const chapter = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' } });
        assert.deepEqual(chapter.summary, { jobs_created: 5, joined: 0, skipped_ready: 0 });
        const scene = await cmd({ scope: { level: 'scene', chapter_id: 'ch-1', scene_id: 'sc-1' } });
        assert.deepEqual(scene.summary, { jobs_created: 0, joined: 3, skipped_ready: 0 });
        const all = await cmd({ scope: { level: 'book' } });
        assert.deepEqual(all.summary, { jobs_created: 2, joined: 5, skipped_ready: 0 });
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs`), 7);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE status = 'queued'`), 7);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_commands WHERE status = 'active'`), 3);
        // concurrent overlapping commands: still exactly one live row per unit
        await Promise.all([cmd({ scope: { level: 'book' } }), cmd({ scope: { level: 'book' } })]);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM (SELECT 1 FROM gen_jobs GROUP BY chapter_id, scene_id, kind, unit_key HAVING count(*) > 1) d`), 0);
    });

    it('skips units whose scene asset is ready for the current content; force regenerates them', async () => {
        await ctx.q(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, scene_hash, status, path)
                     VALUES ($1, 'ch-1', 'sc-1', 'audio', 'build-1', 'h-sc-1', 'ready', '/x'),
                            ($1, 'ch-1', 'sc-2', 'audio', 'build-1', 'OLD-HASH', 'ready', '/y')`, [book.bookId]);
        const r = await cmd();
        assert.deepEqual(r.summary, { jobs_created: 4, joined: 0, skipped_ready: 3 });
        await o.cancel({ bookId: book.bookId });
        const f = await cmd({ force: true });
        assert.deepEqual(f.summary, { jobs_created: 7, joined: 0, skipped_ready: 0 });
    });

    it('layers = requested ∩ enabled; empty → 409 layer_disabled; legacy book → 409; foreign workspace → 403', async () => {
        await assert.rejects(cmd({ enabledLayers: ['image'] }), (e) => e.status === 409 && e.code === 'layer_disabled');
        const r = await cmd({ layers: ['audio', 'image'], enabledLayers: ['audio'] });
        assert.deepEqual((await ctx.q(`SELECT layers FROM gen_commands WHERE command_id = $1`, [r.command_id])).rows[0].layers, ['audio']);
        const legacy = await makeBook(ctx, { v2: false });
        await assert.rejects(o.createCommand({ ...legacy, scope: { level: 'book' }, layers: ['audio'] }), (e) => e.status === 409 && e.code === 'book_not_v2');
        await assert.rejects(o.createCommand({ ...book, workspaceId: uuid(), scope: { level: 'book' }, layers: ['audio'] }), (e) => e.status === 403);
        await assert.rejects(cmd({ scope: { level: 'scene' } }), (e) => e.status === 400);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_commands`), 1, 'rejected commands leave no row');
    });

    it('cancel by book: all active commands + their live jobs; other books untouched (I7)', async () => {
        const other = await makeBook(ctx, { workspaceId: book.workspaceId });
        await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' } });
        await cmd({ scope: { level: 'chapter', chapter_id: 'ch-2' } });
        await o.createCommand({ ...other, userId: book.userId, scope: { level: 'book' }, layers: ['audio'] });
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const t = await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId });
        assert.ok(t.task);
        const r = await o.cancel({ bookId: t.task.book_id }, { cancelledBy: book.userId });
        const target = t.task.book_id; const untouched = target === book.bookId ? other.bookId : book.bookId;
        assert.ok(r.jobs_cancelled > 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [target]), 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_commands WHERE book_id = $1 AND status = 'active'`, [target]), 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status = 'cancelled'`, [untouched]), 0);
        // beacon of the worker holding a cancelled job returns it
        const b = await o.beacon(w, { current_job_id: t.task.job_id });
        assert.deepEqual(b.cancel, [t.task.job_id]);
        assert.equal(b.known, true);
        const ws = (await ctx.q(`SELECT current_job_id, last_seen, status FROM workers WHERE worker_id = $1`, [w])).rows[0];
        assert.equal(ws.current_job_id, t.task.job_id); assert.equal(ws.status, 'online'); assert.ok(Number(ws.last_seen) > 0);
    });

    it('cancel by layer stops every live job of the layer (commands stay active); executor API is gone', async () => {
        const a = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' } });
        const b = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-2' } });
        assert.equal((await o.cancel({ bookId: book.bookId, layer: 'image' })).jobs_cancelled, 0);
        await assert.rejects(o.cancel({ bookId: book.bookId, executor: 'gpu:audio' }), (e) => e.status === 400);
        // an audio_merge (executor local) belongs to the audio layer too
        await ctx.q(`INSERT INTO gen_jobs (command_id, workspace_id, user_id, book_id, chapter_id, scene_id, unit_key, kind, executor, layer, build_id)
                     VALUES ($1, $2, $3, $4, 'ch-9', 'sc-9', 'scene', 'audio_merge', 'local', 'audio', 'build-1')`,
        [a.command_id, book.workspaceId, book.userId, book.bookId]);
        const audio = await o.cancel({ bookId: book.bookId, layer: 'audio' });
        assert.equal(audio.jobs_cancelled, 8); assert.equal(audio.commands_cancelled, 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'audio_merge' AND status = 'cancelled'`), 1);
        for (const c of [a, b]) assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'active');
        await assert.rejects(o.cancel({}), (e) => e.status === 400);
        await assert.rejects(o.cancel({ commandId: a.command_id, bookId: book.bookId }), (e) => e.status === 400);
        await assert.rejects(o.cancel({ bookId: book.bookId, layer: 'music' }), (e) => e.status === 400);
    });

    it('gen_command_jobs: created AND joined jobs are linked; repeated click returns the stored summary', async () => {
        const a = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' }, clientActionId: 'x1' });
        const b = await cmd({ scope: { level: 'scene', chapter_id: 'ch-1', scene_id: 'sc-2' } });
        assert.deepEqual(b.summary, { jobs_created: 0, joined: 2, skipped_ready: 0 });
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_command_jobs WHERE command_id = $1`, [a.command_id]), 5);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_command_jobs WHERE command_id = $1`, [b.command_id]), 2);
        const again = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' }, clientActionId: 'x1' });
        assert.equal(again.command_id, a.command_id);
        assert.deepEqual(again.summary, a.summary);
        assert.deepEqual((await ctx.q(`SELECT summary FROM gen_commands WHERE command_id = $1`, [b.command_id])).rows[0].summary, b.summary);
    });

    it('stop of one of two commands sharing a unit: the shared unit runs on, B finishes done, A cancelled', async () => {
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const a = await cmd({ scope: { level: 'chapter', chapter_id: 'ch-1' } });           // sc-1 ×3, sc-2 ×2
        const b = await cmd({ scope: { level: 'scene', chapter_id: 'ch-1', scene_id: 'sc-2' } }); // joins sc-2 ×2
        const r = await o.cancel({ commandId: a.command_id });
        assert.equal(r.commands_cancelled, 1); assert.equal(r.jobs_cancelled, 3); assert.equal(r.kept_shared, 2);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE scene_id = 'sc-2' AND status = 'queued'`), 2);
        const accept = async () => {
            const t = (await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
            assert.equal(t.scene_id, 'sc-2');
            return o.acceptResult(t.job_id, t.attempt, t.upload_token, require('./helpers').streamOf(require('./helpers').fixture('tone.mp3')));
        };
        await accept();
        const last = await accept();
        assert.equal(last.stage_jobs_created, 1, 'B (active, audio) still gets the merge');
        const merge = (await ctx.q(`SELECT job_id, command_id FROM gen_jobs WHERE kind = 'audio_merge'`)).rows[0];
        assert.deepEqual((await ctx.q(`SELECT command_id FROM gen_command_jobs WHERE job_id = $1`, [merge.job_id])).rows.map((x) => x.command_id), [b.command_id]);
        assert.equal(merge.command_id, b.command_id);
        assert.equal((await o.runLocalOnce()).status, 200);
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [b.command_id])).rows[0].status, 'done');
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [a.command_id])).rows[0].status, 'cancelled');
    });

    it('beacon: a reported job that is no longer running for this worker is in cancel; unknown worker → known=false', async () => {
        await cmd();
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const t = await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId });
        assert.deepEqual((await o.beacon(w, { current_job_id: t.task.job_id })).cancel, []);
        await ctx.q(`UPDATE gen_jobs SET status = 'queued', worker_id = NULL, deadline = NULL WHERE job_id = $1`, [t.task.job_id]); // e.g. re-queued by the sweeper
        assert.deepEqual((await o.beacon(w, { current_job_id: t.task.job_id })).cancel, [t.task.job_id]);
        assert.equal((await o.beacon(uuid(), {})).known, false);
    });
});

describe('gen v2 — claim (ADR §8.1, §10)', function () {
    this.timeout(30000);
    let ctx; let o; let ports;
    const PLAN1 = { c: { s: 4 } };
    async function setup(opts = {}) {
        ctx = await setupDb();
        ports = makePorts(ctx, PLAN1, opts.ports || {});
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir, sharedLimit: opts.sharedLimit ?? null });
    }
    afterEach(async () => { o.stop(); await ctx.teardown(); });

    it('two concurrent claims → different jobs; attempt 1, deadline, token; nothing left → {task:null}', async () => {
        await setup();
        const book = await makeBook(ctx);
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'] });
        const w1 = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const w2 = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const claims = await Promise.all([w1, w2, w1, w2, w1].map((w) => o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })));
        const got = claims.filter((c) => c.task).map((c) => c.task.job_id);
        assert.equal(got.length, 4);
        assert.equal(new Set(got).size, 4, 'no job handed out twice');
        assert.equal(claims.filter((c) => !c.task).length, 1);
        const t = claims.find((c) => c.task).task;
        assert.equal(t.attempt, 1);
        assert.ok(t.upload_token.startsWith('v1.'));
        assert.equal(t.timeout_ms, 30 * 60000);
        assert.deepEqual(t.params, { workflow: 'tts', text: (await ctx.q(`SELECT input->>'text' AS x FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0].x });
        const row = (await ctx.q(`SELECT status, worker_id, deadline - claimed_at AS d FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0];
        assert.equal(row.status, 'running');
        assert.equal(row.d.minutes, 30);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM workers WHERE current_job_id IS NOT NULL`), 2);
        assert.deepEqual(await o.claim({ workerId: w1, workerType: 'image', mode: 'private', workspaceId: book.workspaceId }), { task: null });
    });

    it('lanes: private sees only its workspace; system sees only system; policy by policy id; private borrows only after its own lane', async () => {
        const pol = uuid();
        const laneByWs = new Map();
        await setup({ ports: { laneFor: async (ws) => laneByWs.get(ws) } });
        const priv = await makeBook(ctx); laneByWs.set(priv.workspaceId, { kind: 'private', workspace_id: priv.workspaceId });
        const sys = await makeBook(ctx); laneByWs.set(sys.workspaceId, { kind: 'system' });
        const shared = await makeBook(ctx); laneByWs.set(shared.workspaceId, { kind: 'policy', policy_id: pol });
        for (const b of [sys, shared, priv]) await o.createCommand({ ...b, scope: { level: 'book' }, layers: ['audio'] });

        const other = await makeWorker(ctx, { workspaceId: uuid() });
        assert.deepEqual(await o.claim({ workerId: other, workerType: 'audio', mode: 'private', workspaceId: uuid() }), { task: null });

        const sysW = await makeWorker(ctx, { type: 'audio', mode: 'system' });
        const s = await o.claim({ workerId: sysW, workerType: 'audio', mode: 'system' });
        assert.equal(s.task.book_id, sys.bookId);

        // private worker of `priv` serving policy `pol`: own lane strictly first (4 jobs), then the policy lane
        const pw = await makeWorker(ctx, { workspaceId: priv.workspaceId });
        const books = [];
        for (let i = 0; i < 8; i += 1) {
            const t = await o.claim({ workerId: pw, workerType: 'audio', mode: 'private', workspaceId: priv.workspaceId, policyIds: [pol] });
            books.push(t.task.book_id);
        }
        assert.deepEqual(books, [...Array(4).fill(priv.bookId), ...Array(4).fill(shared.bookId)]);
        // never the system lane without sharePublic
        assert.deepEqual(await o.claim({ workerId: pw, workerType: 'audio', mode: 'private', workspaceId: priv.workspaceId, policyIds: [pol] }), { task: null });
        const pub = await o.claim({ workerId: pw, workerType: 'audio', mode: 'private', workspaceId: priv.workspaceId, sharePublic: true });
        assert.equal(pub.task.book_id, sys.bookId);
    });

    it('fairness: the workspace with fewer running jobs goes first, then age', async () => {
        await setup({ ports: { laneFor: async () => ({ kind: 'system' }) } });
        const a = await makeBook(ctx); const b = await makeBook(ctx);
        await o.createCommand({ ...a, scope: { level: 'book' }, layers: ['audio'] });   // older
        await o.createCommand({ ...b, scope: { level: 'book' }, layers: ['audio'] });
        const w = await makeWorker(ctx, { type: 'audio', mode: 'system' });
        const order = [];
        for (let i = 0; i < 6; i += 1) order.push((await o.claim({ workerId: w, workerType: 'audio', mode: 'system' })).task.book_id);
        assert.deepEqual(order, [a.bookId, b.bookId, a.bookId, b.bookId, a.bookId, b.bookId]);
    });

    it('shared_limit: caps running jobs of one workspace on shared lanes; NULL = off; private lanes unlimited', async () => {
        const lanes = new Map();
        await setup({ sharedLimit: 1, ports: { laneFor: async (ws) => lanes.get(ws) } });
        const a = await makeBook(ctx); lanes.set(a.workspaceId, { kind: 'system' });
        const b = await makeBook(ctx); lanes.set(b.workspaceId, { kind: 'system' });
        const p = await makeBook(ctx); lanes.set(p.workspaceId, { kind: 'private', workspace_id: p.workspaceId });
        for (const x of [a, b, p]) await o.createCommand({ ...x, scope: { level: 'book' }, layers: ['audio'] });
        const w = await makeWorker(ctx, { type: 'audio', mode: 'system' });
        const got = [];
        for (let i = 0; i < 3; i += 1) { const t = await o.claim({ workerId: w, workerType: 'audio', mode: 'system' }); got.push(t.task && t.task.book_id); }
        assert.deepEqual(got.slice(0, 2).sort(), [a.bookId, b.bookId].sort());
        assert.equal(got[2], null, 'each workspace already runs 1 = shared_limit');
        // concurrent claims under the limit never exceed it
        const many = await Promise.all(Array.from({ length: 6 }, () => o.claim({ workerId: w, workerType: 'audio', mode: 'system' })));
        assert.equal(many.filter((x) => x.task).length, 0);
        // per-call override NULL = off
        assert.ok((await o.claim({ workerId: w, workerType: 'audio', mode: 'system', sharedLimit: null })).task);
        // private lane: no limit
        const pw = await makeWorker(ctx, { workspaceId: p.workspaceId });
        const priv = await Promise.all(Array.from({ length: 4 }, () => o.claim({ workerId: pw, workerType: 'audio', mode: 'private', workspaceId: p.workspaceId })));
        assert.equal(priv.filter((x) => x.task).length, 4);
    });

    it('not_before is honoured; buildPayload failure fails the attempt (no silent loss)', async () => {
        await setup({ ports: { buildPayload: async () => { throw new Error('no voice'); } } });
        const book = await makeBook(ctx);
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'] });
        await ctx.q(`UPDATE gen_jobs SET not_before = now() + interval '1 hour' WHERE unit_key <> '0001'`);
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        assert.deepEqual(await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId }), { task: null });
        const j = (await ctx.q(`SELECT status, error_class, error, attempt FROM gen_jobs WHERE unit_key = '0001'`)).rows[0];
        assert.deepEqual([j.status, j.error_class, j.attempt], ['failed', 'deterministic', 1]);
        assert.match(j.error, /no voice/);
        assert.deepEqual(await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId }), { task: null });
    });
});
