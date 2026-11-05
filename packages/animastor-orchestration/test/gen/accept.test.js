'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, count, fixture, streamOf, SECRET } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const listTmp = (dir) => {
    const out = [];
    const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.tmp')) out.push(p); } };
    walk(dir);
    return out;
};

describe('gen v2 — acceptResult / acceptError (ADR §7) and transitions (§6.3)', function () {
    this.timeout(30000);
    let ctx; let o; let book; let worker; let ports;
    const TONE = fixture('tone.mp3');

    async function setup(plan = { ch: { sc: 2 } }, overrides = {}) {
        ctx = await setupDb();
        ports = makePorts(ctx, plan, overrides);
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        book = await makeBook(ctx);
        worker = await makeWorker(ctx, { workspaceId: book.workspaceId });
    }
    afterEach(async () => { o.stop(); await ctx.teardown(); });
    const command = (extra = {}) => o.createCommand({ ...book, scope: { level: 'book' }, layers: ['audio'], ...extra });
    const claim = async () => (await o.claim({ workerId: worker, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
    const put = (t, buf = TONE, attempt = t.attempt, token = t.upload_token) => o.acceptResult(t.job_id, attempt, token, streamOf(buf));

    it('current attempt → 200, job done with sha256/bytes, file renamed into artifactPath, part recorded in scene_assets', async () => {
        await setup();
        await command();
        const t = await claim();
        const r = await put(t);
        assert.equal(r.status, 200); assert.equal(r.sha256, sha(TONE));
        const j = (await ctx.q(`SELECT * FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0];
        assert.equal(j.status, 'done'); assert.equal(j.result_sha256, sha(TONE)); assert.equal(Number(j.result_bytes), TONE.length);
        assert.equal(j.result_path, ports.ports.artifactPath(j));
        assert.equal(sha(fs.readFileSync(j.result_path)), sha(TONE));
        assert.deepEqual(listTmp(ctx.outputDir), [], 'no tmp left behind');
        const a = (await ctx.q(`SELECT status, metadata FROM scene_assets WHERE book_id = $1`, [book.bookId])).rows[0];
        assert.equal(a.status, 'pending', 'one chunk does not make the scene audio ready (I5)');
        assert.equal(a.metadata.gen_parts[t.unit_key].sha256, sha(TONE));
        assert.equal((await ctx.q(`SELECT current_job_id FROM workers WHERE worker_id = $1`, [worker])).rows[0].current_job_id, null);
    });

    it('last audio_chunk → audio_merge (local) created once; merge → scene_assets ready + sha256 + job_id', async () => {
        await setup({ ch: { sc: 3 } });
        const c = await command();
        const [a, b, d] = [await claim(), await claim(), await claim()];
        assert.equal((await put(a)).stage_jobs_created, 0);
        // the two last chunks race: exactly one merge
        const rs = await Promise.all([put(b), put(d)]);
        assert.deepEqual(rs.map((r) => r.status), [200, 200]);
        assert.equal(rs.reduce((s, r) => s + r.stage_jobs_created, 0), 1);
        const m = (await ctx.q(`SELECT * FROM gen_jobs WHERE kind = 'audio_merge'`)).rows;
        assert.equal(m.length, 1);
        assert.equal(m[0].command_id, c.command_id); assert.equal(m[0].executor, 'local'); assert.equal(m[0].lane, null);
        assert.deepEqual(m[0].input.parts.map((p) => p.unit_key), ['0001', '0002', '0003']);
        // GPU workers never see local work
        assert.equal(await claim(), null);
        const r = await o.runLocalOnce();
        assert.equal(r.status, 200);
        assert.deepEqual(ports.calls.runLocal, [m[0].job_id]);
        const asset = (await ctx.q(`SELECT * FROM scene_assets WHERE book_id = $1 AND asset_type = 'audio'`, [book.bookId])).rows[0];
        assert.equal(asset.status, 'ready'); assert.equal(asset.sha256, sha(TONE)); assert.equal(asset.job_id, m[0].job_id);
        assert.equal(asset.scene_hash, 'h-sc'); assert.equal(asset.build_id, 'build-1'); assert.equal(asset.format, 'mp3');
        assert.ok(asset.duration_sec > 1);
        assert.equal(sha(fs.readFileSync(asset.path)), sha(TONE));
        assert.equal(await o.runLocalOnce(), null);
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'done');
    });

    it('stale attempt → 409 and the file is discarded (nothing written, no tmp)', async () => {
        await setup({ ch: { sc: 1 } });
        await command();
        const t1 = await claim();
        // the sweeper re-queued attempt 1 (timeout) and attempt 2 went to another worker
        await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 s' WHERE job_id = $1`, [t1.job_id]);
        await o.sweepOnce();
        await ctx.q(`UPDATE gen_jobs SET not_before = now()`);
        const t2 = await claim();
        assert.equal(t2.job_id, t1.job_id); assert.equal(t2.attempt, 2);
        const r = await put(t1);
        assert.deepEqual(r, { status: 409, code: 'stale_attempt' });
        assert.deepEqual(listTmp(ctx.outputDir), []);
        assert.equal(fs.existsSync(ports.ports.artifactPath({ ...t1, input: { build_id: 'build-1' }, book_id: book.bookId })), false);
        // attempt-1 token cannot be replayed as attempt 2
        await assert.rejects(o.acceptResult(t1.job_id, 2, t1.upload_token, streamOf(TONE)), (e) => e.status === 401);
        assert.equal((await put(t2)).status, 200);
    });

    it('attempt goes stale WHILE the upload streams → 409 under FOR UPDATE, tmp deleted', async () => {
        await setup({ ch: { sc: 1 } });
        const c = await command();
        const t = await claim();
        let release;
        const gate = new Promise((r) => { release = r; });
        async function* slow() { yield TONE.subarray(0, 100); await gate; yield TONE.subarray(100); }
        const pending = o.acceptResult(t.job_id, t.attempt, t.upload_token, Readable.from(slow()));
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(listTmp(ctx.outputDir).length, 1, 'tmp is being written in .incoming');
        await o.cancel({ commandId: c.command_id });
        release();
        assert.deepEqual(await pending, { status: 409, code: 'stale_attempt' });
        assert.deepEqual(listTmp(ctx.outputDir), []);
        assert.equal((await ctx.q(`SELECT status FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0].status, 'cancelled');
    });

    it('the same PUT repeated after commit → 200 idempotent; different bytes for the same attempt → 409', async () => {
        await setup({ ch: { sc: 2 } });
        await command();
        const t = await claim();
        assert.equal((await put(t)).status, 200);
        const again = await put(t);
        assert.equal(again.status, 200); assert.equal(again.idempotent, true);
        const other = fixture('quiet.mp3');
        assert.deepEqual(await put(t, other), { status: 409, code: 'stale_attempt' });
        assert.equal(sha(fs.readFileSync((await ctx.q(`SELECT result_path FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0].result_path)), sha(TONE));
        assert.deepEqual(listTmp(ctx.outputDir), []);
    });

    it('silence → rejected as an error (422 invalid_result → failed), never ready; bad token → 401', async () => {
        await setup({ ch: { sc: 1 } });
        await command();
        const t = await claim();
        await assert.rejects(put(t, TONE, t.attempt, t.upload_token.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))), (e) => e.status === 401);
        const r = await put(t, fixture('silence.mp3'));
        assert.equal(r.status, 422); assert.equal(r.code, 'invalid_result'); assert.equal(r.reason, 'silence');
        const j = (await ctx.q(`SELECT status, error_class, error, result_path FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0];
        assert.deepEqual([j.status, j.error_class, j.result_path], ['failed', 'invalid_result', null]);
        assert.match(j.error, /silence/);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM scene_assets WHERE status = 'ready'`), 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'audio_merge'`), 0);
        assert.deepEqual(listTmp(ctx.outputDir), []);
        const r2 = await put(t, fixture('quiet.mp3'));
        assert.equal(r2.status, 409, 'a failed job accepts nothing');
    });

    it('acceptError: transient → queued with not_before +30 s then +120 s, then failed; deterministic → failed; stale → 409', async () => {
        await setup({ ch: { sc: 2 } });
        await command();
        let t = await claim();
        const err = (x, body) => o.acceptError(x.job_id, x.attempt, x.upload_token, body);
        let r = await err(t, { error_class: 'transient', reason: 'ECONNRESET' });
        assert.deepEqual(r, { status: 200, job_status: 'queued', retry: true });
        let j = (await ctx.q(`SELECT status, attempt, worker_id, extract(epoch from not_before - now()) AS wait FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0];
        assert.equal(j.status, 'queued'); assert.equal(j.attempt, 1); assert.equal(j.worker_id, null);
        assert.ok(j.wait > 25 && j.wait <= 30, `wait ${j.wait}`);
        assert.deepEqual(await err(t, { error_class: 'transient' }), { status: 409, code: 'stale_attempt' });
        const first = t.job_id;
        // the other chunk is claimable meanwhile; ours is not (not_before)
        const other = await claim();
        assert.notEqual(other.job_id, first);
        await ctx.q(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [first]);
        t = await claim();
        assert.equal(t.job_id, first); assert.equal(t.attempt, 2);
        r = await err(t, { error_class: 'transient' });
        j = (await ctx.q(`SELECT extract(epoch from not_before - now()) AS wait FROM gen_jobs WHERE job_id = $1`, [first])).rows[0];
        assert.ok(j.wait > 115 && j.wait <= 120, `wait ${j.wait}`);
        await ctx.q(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [first]);
        t = await claim();
        assert.equal(t.attempt, 3);
        r = await err(t, { error_class: 'transient' });
        assert.deepEqual(r, { status: 200, job_status: 'failed', retry: false });
        r = await err(other, { error_class: 'deterministic', reason: 'node_errors' });
        assert.deepEqual(r, { status: 200, job_status: 'failed', retry: false });
        await assert.rejects(o.acceptError(first, 3, 'v1.1.x', {}), (e) => e.status === 401);
    });

    it('cancelled command → the last chunk is refused and NO audio_merge is created', async () => {
        await setup({ ch: { sc: 2 } });
        const c = await command();
        const a = await claim(); const b = await claim();
        assert.equal((await put(a)).status, 200);
        await o.cancel({ commandId: c.command_id });
        assert.deepEqual(await put(b), { status: 409, code: 'stale_attempt' });
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'audio_merge'`), 0);
    });

    it('command no longer active while its chunk still runs (cancel interleaving) → chunk accepted, merge NOT created', async () => {
        await setup({ ch: { sc: 2 } });
        const c = await command();
        const a = await claim(); const b = await claim();
        assert.equal((await put(a)).status, 200);
        await ctx.q(`UPDATE gen_commands SET status = 'cancelled' WHERE command_id = $1`, [c.command_id]);
        const r = await put(b);
        assert.equal(r.status, 200); assert.equal(r.stage_jobs_created, 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'audio_merge'`), 0);
    });

    it('a failed chunk blocks the merge; layer disabled at accept time blocks the merge', async () => {
        await setup({ ch: { sc: 2 } });
        await command();
        const a = await claim(); const b = await claim();
        await o.acceptError(a.job_id, a.attempt, a.upload_token, { error_class: 'deterministic' });
        assert.equal((await put(b)).stage_jobs_created, 0);
        await ctx.teardown(); o.stop();

        let enabled = true;
        await setup({ ch: { sc: 1 } }, { isLayerEnabled: async () => enabled });
        await command();
        const t = await claim();
        enabled = false;
        assert.equal((await put(t)).stage_jobs_created, 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'audio_merge'`), 0);
    });

    it('runLocal failure → the merge attempt fails by policy (unknown → failed)', async () => {
        await setup({ ch: { sc: 1 } }, { runLocal: async () => { throw Object.assign(new Error('ffmpeg concat'), { error_class: 'deterministic' }); } });
        await command();
        const t = await claim();
        await put(t);
        const r = await o.runLocalOnce();
        assert.equal(r.job_status, 'failed');
        const m = (await ctx.q(`SELECT status, error FROM gen_jobs WHERE kind = 'audio_merge'`)).rows[0];
        assert.equal(m.status, 'failed'); assert.match(m.error, /ffmpeg concat/);
    });
});
